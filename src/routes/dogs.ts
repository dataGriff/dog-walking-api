import { Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { AppEnv } from "../env";
import { database } from "../db";
import { clients, dogs } from "../db/schema";
import { clearingEmpty, nowIso, problem, scoped } from "../problem";
import { parseBody } from "../validate";

const name = z.string().trim().min(1, "name must not be blank");
// "Today" is the walker's today, and the furthest-ahead zone (UTC+14) is up
// to a day ahead of UTC, so the latest acceptable date is tomorrow in UTC.
const dateOfBirth = z.iso.date("date_of_birth must be a date (YYYY-MM-DD)").refine(
  (d) => d <= new Date(Date.now() + 86_400_000).toISOString().slice(0, 10),
  "date_of_birth must not be in the future",
);

const CreateDog = z.strictObject({
  client_id: z.uuid("client_id must be a uuid"),
  name,
  breed: z.string().optional(),
  date_of_birth: dateOfBirth.optional(),
  notes: z.string().optional(),
});
const UpdateDog = z.strictObject({
  name: name.optional(),
  breed: z.string().optional(),
  date_of_birth: z.union([dateOfBirth, z.literal("")]).optional(),
  notes: z.string().optional(),
});

export const dogRoutes = new Hono<AppEnv>()
  .get("/", async (c) => {
    const db = database(c.env.DB);
    const clientId = c.req.query("client_id");
    const conditions = [eq(dogs.walker_id, c.get("walkerId"))];
    if (clientId) conditions.push(eq(dogs.client_id, clientId));
    const rows = await db
      .select()
      .from(dogs)
      .where(and(...conditions))
      .orderBy(desc(dogs.created_at), desc(dogs.dog_id))
      .all();
    return c.json({ dogs: rows.map(scoped) });
  })
  .post("/", async (c) => {
    const body = await parseBody(c, CreateDog, "invalid_dog");
    if (!body.ok) return body.response;
    const db = database(c.env.DB);
    const owner = await db
      .select({ client_id: clients.client_id })
      .from(clients)
      .where(and(eq(clients.walker_id, c.get("walkerId")), eq(clients.client_id, body.value.client_id)))
      .get();
    if (!owner) {
      return problem(c, 400, "invalid_dog", `client_id ${body.value.client_id} is not one of your clients`);
    }
    const row = {
      dog_id: crypto.randomUUID(),
      walker_id: c.get("walkerId"),
      ...body.value,
      created_at: nowIso(),
    };
    await db.insert(dogs).values(row).run();
    return c.json(scoped(row), 201);
  })
  .get("/:dog_id", async (c) => {
    const db = database(c.env.DB);
    const row = await db
      .select()
      .from(dogs)
      .where(and(eq(dogs.walker_id, c.get("walkerId")), eq(dogs.dog_id, c.req.param("dog_id"))))
      .get();
    if (!row) return problem(c, 404, "dog_not_found", `No dog ${c.req.param("dog_id")}`);
    return c.json(scoped(row));
  })
  .patch("/:dog_id", async (c) => {
    const body = await parseBody(c, UpdateDog, "invalid_dog");
    if (!body.ok) return body.response;
    const db = database(c.env.DB);
    const where = and(eq(dogs.walker_id, c.get("walkerId")), eq(dogs.dog_id, c.req.param("dog_id")));
    // An empty patch still has to answer with the row, so touch a column it already has.
    const row = await db
      .update(dogs)
      .set(Object.keys(body.value).length > 0 ? (clearingEmpty(body.value) as Partial<typeof dogs.$inferInsert>) : { dog_id: c.req.param("dog_id") })
      .where(where)
      .returning()
      .get();
    if (!row) return problem(c, 404, "dog_not_found", `No dog ${c.req.param("dog_id")}`);
    return c.json(scoped(row));
  })
  .delete("/:dog_id", async (c) => {
    const walkerId = c.get("walkerId");
    const dogId = c.req.param("dog_id");
    // One statement, so a walk booked meanwhile cannot slip between check and delete.
    const result = await c.env.DB.prepare(
      `DELETE FROM dogs WHERE dog_id = ?1 AND walker_id = ?2 AND NOT EXISTS (
         SELECT 1 FROM walks, json_each(walks.dog_ids) AS booked
         WHERE booked.value = ?1 AND walks.walker_id = ?2 AND walks.status IN ('scheduled', 'in_progress'))`,
    )
      .bind(dogId, walkerId)
      .run();
    if (result.meta.changes > 0) return c.body(null, 204);
    const db = database(c.env.DB);
    const where = and(eq(dogs.walker_id, walkerId), eq(dogs.dog_id, dogId));
    if (!(await db.select({ dog_id: dogs.dog_id }).from(dogs).where(where).get())) {
      return problem(c, 404, "dog_not_found", `No dog ${dogId}`);
    }
    return problem(c, 409, "dog_has_open_walks", "This dog is booked on an open walk; complete or cancel it first.");
  });

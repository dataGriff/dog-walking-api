import { Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { AppEnv } from "../env";
import { database } from "../db";
import { clients, dogs } from "../db/schema";
import { nowIso, present, problem } from "../problem";
import { parseBody } from "../validate";

const name = z.string().trim().min(1, "name must not be blank");
const dateOfBirth = z.iso.date("date_of_birth must be a date (YYYY-MM-DD)").refine(
  (d) => d <= new Date().toISOString().slice(0, 10),
  "date_of_birth must not be in the future",
);

const CreateDog = z.strictObject({
  client_id: z.uuid("client_id must be a uuid"),
  name,
  breed: z.string().optional(),
  date_of_birth: dateOfBirth.optional(),
  notes: z.string().optional(),
});
const UpdateDog = CreateDog.omit({ client_id: true }).partial();

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
    return c.json({ dogs: rows.map(({ walker_id: _w, ...row }) => present(row)) });
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
    const { walker_id: _w, ...out } = row;
    return c.json(present(out), 201);
  })
  .get("/:dog_id", async (c) => {
    const db = database(c.env.DB);
    const row = await db
      .select()
      .from(dogs)
      .where(and(eq(dogs.walker_id, c.get("walkerId")), eq(dogs.dog_id, c.req.param("dog_id"))))
      .get();
    if (!row) return problem(c, 404, "dog_not_found", `No dog ${c.req.param("dog_id")}`);
    const { walker_id: _w, ...out } = row;
    return c.json(present(out));
  })
  .patch("/:dog_id", async (c) => {
    const body = await parseBody(c, UpdateDog, "invalid_dog");
    if (!body.ok) return body.response;
    const db = database(c.env.DB);
    const where = and(eq(dogs.walker_id, c.get("walkerId")), eq(dogs.dog_id, c.req.param("dog_id")));
    const existing = await db.select({ dog_id: dogs.dog_id }).from(dogs).where(where).get();
    if (!existing) return problem(c, 404, "dog_not_found", `No dog ${c.req.param("dog_id")}`);
    if (Object.keys(body.value).length > 0) {
      await db.update(dogs).set(body.value).where(where).run();
    }
    const row = (await db.select().from(dogs).where(where).get())!;
    const { walker_id: _w, ...out } = row;
    return c.json(present(out));
  })
  .delete("/:dog_id", async (c) => {
    const db = database(c.env.DB);
    const where = and(eq(dogs.walker_id, c.get("walkerId")), eq(dogs.dog_id, c.req.param("dog_id")));
    const existing = await db.select({ dog_id: dogs.dog_id }).from(dogs).where(where).get();
    if (!existing) return problem(c, 404, "dog_not_found", `No dog ${c.req.param("dog_id")}`);
    await db.delete(dogs).where(where).run();
    return c.body(null, 204);
  });

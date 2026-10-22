import { Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { AppEnv } from "../env";
import { database } from "../db";
import { clients } from "../db/schema";
import { clearingEmpty, nowIso, problem, scoped } from "../problem";
import { parseBody } from "../validate";

const name = z.string().trim().min(1, "name must not be blank");
const email = z.email("email must be an email address");

const CreateClient = z.strictObject({
  name,
  email: email.optional(),
  phone: z.string().optional(),
  address: z.string().optional(),
  notes: z.string().optional(),
});
const UpdateClient = z.strictObject({
  name: name.optional(),
  email: z.union([email, z.literal("")]).optional(),
  phone: z.string().optional(),
  address: z.string().optional(),
  notes: z.string().optional(),
});

export const clientRoutes = new Hono<AppEnv>()
  .get("/", async (c) => {
    const db = database(c.env.DB);
    const rows = await db
      .select()
      .from(clients)
      .where(eq(clients.walker_id, c.get("walkerId")))
      .orderBy(desc(clients.created_at), desc(clients.client_id))
      .all();
    return c.json({ clients: rows.map(scoped) });
  })
  .post("/", async (c) => {
    const body = await parseBody(c, CreateClient, "invalid_client");
    if (!body.ok) return body.response;
    const db = database(c.env.DB);
    const row = {
      client_id: crypto.randomUUID(),
      walker_id: c.get("walkerId"),
      ...body.value,
      created_at: nowIso(),
    };
    await db.insert(clients).values(row).run();
    return c.json(scoped(row), 201);
  })
  .get("/:client_id", async (c) => {
    const db = database(c.env.DB);
    const row = await db
      .select()
      .from(clients)
      .where(and(eq(clients.walker_id, c.get("walkerId")), eq(clients.client_id, c.req.param("client_id"))))
      .get();
    if (!row) return problem(c, 404, "client_not_found", `No client ${c.req.param("client_id")}`);
    return c.json(scoped(row));
  })
  .patch("/:client_id", async (c) => {
    const body = await parseBody(c, UpdateClient, "invalid_client");
    if (!body.ok) return body.response;
    const db = database(c.env.DB);
    const where = and(eq(clients.walker_id, c.get("walkerId")), eq(clients.client_id, c.req.param("client_id")));
    // An empty patch still has to answer with the row, so touch a column it already has.
    const row = await db
      .update(clients)
      .set(Object.keys(body.value).length > 0 ? (clearingEmpty(body.value) as Partial<typeof clients.$inferInsert>) : { client_id: c.req.param("client_id") })
      .where(where)
      .returning()
      .get();
    if (!row) return problem(c, 404, "client_not_found", `No client ${c.req.param("client_id")}`);
    return c.json(scoped(row));
  })
  .delete("/:client_id", async (c) => {
    const walkerId = c.get("walkerId");
    const clientId = c.req.param("client_id");
    // One statement, so a walk booked meanwhile cannot slip between check and delete.
    const result = await c.env.DB.prepare(
      `DELETE FROM clients WHERE client_id = ?1 AND walker_id = ?2 AND NOT EXISTS (
         SELECT 1 FROM walks, json_each(walks.dog_ids) AS booked
         JOIN dogs ON dogs.dog_id = booked.value
         WHERE dogs.client_id = ?1 AND walks.walker_id = ?2 AND walks.status IN ('scheduled', 'in_progress'))`,
    )
      .bind(clientId, walkerId)
      .run();
    if (result.meta.changes > 0) return c.body(null, 204);
    const db = database(c.env.DB);
    const where = and(eq(clients.walker_id, walkerId), eq(clients.client_id, clientId));
    if (!(await db.select({ client_id: clients.client_id }).from(clients).where(where).get())) {
      return problem(c, 404, "client_not_found", `No client ${clientId}`);
    }
    return problem(c, 409, "dog_has_open_walks", "One of this client's dogs is booked on an open walk; complete or cancel it first.");
  });

import { Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { AppEnv } from "../env";
import { database } from "../db";
import { clients } from "../db/schema";
import { nowIso, present, problem } from "../problem";
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
const UpdateClient = CreateClient.partial();

export const clientRoutes = new Hono<AppEnv>()
  .get("/", async (c) => {
    const db = database(c.env.DB);
    const rows = await db
      .select()
      .from(clients)
      .where(eq(clients.walker_id, c.get("walkerId")))
      .orderBy(desc(clients.created_at), desc(clients.client_id))
      .all();
    return c.json({ clients: rows.map(({ walker_id: _w, ...row }) => present(row)) });
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
    const { walker_id: _w, ...out } = row;
    return c.json(present(out), 201);
  })
  .get("/:client_id", async (c) => {
    const db = database(c.env.DB);
    const row = await db
      .select()
      .from(clients)
      .where(and(eq(clients.walker_id, c.get("walkerId")), eq(clients.client_id, c.req.param("client_id"))))
      .get();
    if (!row) return problem(c, 404, "client_not_found", `No client ${c.req.param("client_id")}`);
    const { walker_id: _w, ...out } = row;
    return c.json(present(out));
  })
  .patch("/:client_id", async (c) => {
    const body = await parseBody(c, UpdateClient, "invalid_client");
    if (!body.ok) return body.response;
    const db = database(c.env.DB);
    const where = and(eq(clients.walker_id, c.get("walkerId")), eq(clients.client_id, c.req.param("client_id")));
    const existing = await db.select().from(clients).where(where).get();
    if (!existing) return problem(c, 404, "client_not_found", `No client ${c.req.param("client_id")}`);
    if (Object.keys(body.value).length > 0) {
      await db.update(clients).set(body.value).where(where).run();
    }
    const row = (await db.select().from(clients).where(where).get())!;
    const { walker_id: _w, ...out } = row;
    return c.json(present(out));
  })
  .delete("/:client_id", async (c) => {
    const db = database(c.env.DB);
    const where = and(eq(clients.walker_id, c.get("walkerId")), eq(clients.client_id, c.req.param("client_id")));
    const existing = await db.select({ client_id: clients.client_id }).from(clients).where(where).get();
    if (!existing) return problem(c, 404, "client_not_found", `No client ${c.req.param("client_id")}`);
    // Dogs go with their client: ON DELETE CASCADE on dogs.client_id.
    await db.delete(clients).where(where).run();
    return c.body(null, 204);
  });

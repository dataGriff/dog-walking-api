/** The test harness, mounted only when AUTH_MODE=test.
 *
 * It exists so the pinned feature files can be bound without reaching
 * into the database: fixtures the contract tests replay against, the
 * walk history and outbox the event scenarios assert on, and switches
 * for the "event publication is unavailable" scenarios. Nothing here is
 * reachable in clerk mode. */
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import type { AppEnv } from "./env";
import { database } from "./db";
import {
  clients,
  dogs,
  outbox,
  test_flags,
  walk_cancelled_events,
  walk_completed_events,
  walk_scheduled_events,
  walks,
} from "./db/schema";
import { relayOutbox } from "./events/outbox";
import { problem } from "./problem";

const HISTORY = {
  walk_scheduled_events,
  walk_completed_events,
  walk_cancelled_events,
} as const;

/** The walker the mock examples belong to - mocks/*.examples.yaml in the spec repo. */
export const FIXTURE_WALKER = "user_2walkeranna";

export async function seedFixtures(d1: D1Database) {
  const db = database(d1);
  const w = FIXTURE_WALKER;
  await db.batch([
    db.delete(walk_cancelled_events),
    db.delete(walk_completed_events),
    db.delete(walk_scheduled_events),
    db.delete(outbox),
    db.delete(walks),
    db.delete(dogs),
    db.delete(clients),
    db.delete(test_flags),
    db.insert(clients).values([
      {
        client_id: "11111111-1111-4111-8111-111111111111",
        walker_id: w,
        name: "Alice Ahmed",
        email: "alice@example.com",
        phone: "+44 7700 900001",
        address: "1 Park Lane, Cardiff",
        notes: "Key under the plant pot",
        created_at: "2026-10-01T09:00:00.000Z",
      },
      {
        client_id: "77777777-7777-4777-8777-777777777777",
        walker_id: w,
        name: "Ben Brooks",
        created_at: "2026-09-01T09:00:00.000Z",
      },
    ]),
    db.insert(dogs).values([
      {
        dog_id: "22222222-2222-4222-8222-222222222222",
        walker_id: w,
        client_id: "11111111-1111-4111-8111-111111111111",
        name: "Biscuit",
        breed: "Cockapoo",
        date_of_birth: "2022-05-14",
        notes: "Pulls on the lead near squirrels",
        created_at: "2026-10-01T09:05:00.000Z",
      },
      {
        dog_id: "88888888-8888-4888-8888-888888888888",
        walker_id: w,
        client_id: "11111111-1111-4111-8111-111111111111",
        name: "Rex",
        breed: "Labrador",
        created_at: "2026-10-01T09:06:00.000Z",
      },
    ]),
    db.insert(walks).values([
      {
        walk_id: "33333333-3333-4333-8333-333333333333",
        walker_id: w,
        scheduled_at: "2026-11-02T09:00:00.000Z",
        duration_minutes: 45,
        dog_ids: JSON.stringify(["22222222-2222-4222-8222-222222222222"]),
        status: "scheduled",
        notes: "Meet at the park gate",
        created_at: "2026-10-20T18:00:00.000Z",
      },
      {
        walk_id: "44444444-4444-4444-8444-444444444444",
        walker_id: w,
        scheduled_at: "2026-11-03T09:00:00.000Z",
        duration_minutes: 30,
        dog_ids: JSON.stringify(["22222222-2222-4222-8222-222222222222"]),
        status: "scheduled",
        created_at: "2026-10-20T18:05:00.000Z",
      },
      {
        walk_id: "55555555-5555-4555-8555-555555555555",
        walker_id: w,
        scheduled_at: "2026-11-04T09:00:00.000Z",
        duration_minutes: 30,
        dog_ids: JSON.stringify(["22222222-2222-4222-8222-222222222222"]),
        status: "in_progress",
        started_at: "2026-11-04T09:01:00.000Z",
        created_at: "2026-10-20T18:10:00.000Z",
      },
      {
        walk_id: "66666666-6666-4666-8666-666666666666",
        walker_id: w,
        scheduled_at: "2026-11-05T09:00:00.000Z",
        duration_minutes: 30,
        dog_ids: JSON.stringify(["22222222-2222-4222-8222-222222222222"]),
        status: "scheduled",
        created_at: "2026-10-20T18:15:00.000Z",
      },
    ]),
  ]);
}

export const testRoutes = new Hono<AppEnv>()
  .post("/reset", async (c) => {
    await seedFixtures(c.env.DB);
    return c.json({ reset: true, fixture_walker: FIXTURE_WALKER });
  })
  .get("/history/:table", async (c) => {
    const table = HISTORY[c.req.param("table") as keyof typeof HISTORY];
    if (!table) return problem(c, 404, "unknown_table", "Not a history table.");
    const walkId = c.req.query("walk_id");
    const db = database(c.env.DB);
    const rows = walkId
      ? await db.select().from(table).where(eq(table.walk_id, walkId)).all()
      : await db.select().from(table).all();
    return c.json({ rows });
  })
  .get("/outbox", async (c) => {
    const subject = c.req.query("subject");
    const db = database(c.env.DB);
    const rows = subject
      ? await db.select().from(outbox).where(eq(outbox.subject, subject)).all()
      : await db.select().from(outbox).all();
    return c.json({ rows: rows.map((r) => ({ ...r, envelope: JSON.parse(r.envelope) as unknown })) });
  })
  .post("/flags", async (c) => {
    const body = (await c.req.json()) as Record<string, unknown>;
    const db = database(c.env.DB);
    for (const [key, value] of Object.entries(body)) {
      await db
        .insert(test_flags)
        .values({ key, value: String(value) })
        .onConflictDoUpdate({ target: test_flags.key, set: { value: String(value) } })
        .run();
    }
    return c.json({ flags: body });
  })
  .post("/relay", async (c) => {
    try {
      const sent = await relayOutbox(database(c.env.DB), c.env.EVENTS, true);
      return c.json({ sent });
    } catch (err) {
      return c.json({ sent: 0, error: err instanceof Error ? err.message : String(err) }, 503);
    }
  })
  .post("/replay", async (c) => {
    const { event_id } = (await c.req.json()) as { event_id?: string };
    if (!event_id) return problem(c, 400, "invalid_replay", "event_id is required");
    const row = await database(c.env.DB).select().from(outbox).where(eq(outbox.event_id, event_id)).get();
    if (!row) return problem(c, 404, "unknown_event", `No outbox row ${event_id}`);
    await c.env.EVENTS.send(JSON.parse(row.envelope), { contentType: "json" });
    return c.json({ replayed: event_id });
  });

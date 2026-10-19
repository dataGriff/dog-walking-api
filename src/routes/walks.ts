import { Hono, type Context } from "hono";
import { and, asc, eq, gte, inArray, lt } from "drizzle-orm";
import { z } from "zod";
import type { AppEnv } from "../env";
import { database, type Database } from "../db";
import { dogs, walks } from "../db/schema";
import { nowIso, present, problem } from "../problem";
import { parseBody } from "../validate";
import { CHANNELS, TYPES, envelope } from "../events/cloudevents";
import { outbox } from "../db/schema";
import { outboxRow, relayOutbox } from "../events/outbox";

const STATUSES = ["scheduled", "in_progress", "completed", "cancelled"] as const;
const REASONS = ["client_request", "walker_unavailable", "bad_weather", "dog_unwell"] as const;

const dateTime = z.iso.datetime({ offset: true, message: "must be an RFC 3339 date-time" });
const dogIds = z.array(z.uuid("each dog_id must be a uuid")).min(1, "dog_ids needs at least one dog");
const duration = z.int("duration_minutes must be a whole number").min(1, "duration_minutes must be at least 1");

const ScheduleWalk = z.strictObject({
  scheduled_at: dateTime,
  duration_minutes: duration,
  dog_ids: dogIds,
  notes: z.string().optional(),
});
const UpdateWalk = ScheduleWalk.partial();
const CompleteWalk = z.strictObject({ notes: z.string().optional() });
const CancelWalk = z.strictObject({
  reason: z.enum(REASONS, { message: `reason must be one of ${REASONS.join(", ")}` }),
});

type WalkRow = typeof walks.$inferSelect;

function toApi(row: WalkRow) {
  const { walker_id: _w, last_event_id: _e, ...rest } = row;
  return present({ ...rest, dog_ids: JSON.parse(row.dog_ids) as string[] });
}

/** Normalise to UTC `Z` form so ordering and windows compare as instants. */
function utc(iso: string): string {
  return new Date(iso).toISOString();
}

async function ownedDogs(db: Database, walkerId: string, ids: string[]): Promise<string[] | null> {
  const unique = [...new Set(ids)];
  let found = 0;
  // Chunked: D1 binds at most 100 parameters per statement.
  for (let i = 0; i < unique.length; i += 50) {
    const rows = await db
      .select({ dog_id: dogs.dog_id })
      .from(dogs)
      .where(and(eq(dogs.walker_id, walkerId), inArray(dogs.dog_id, unique.slice(i, i + 50))))
      .all();
    found += rows.length;
  }
  return found === unique.length ? unique : null;
}

async function loadWalk(db: Database, walkerId: string, walkId: string) {
  return db
    .select()
    .from(walks)
    .where(and(eq(walks.walker_id, walkerId), eq(walks.walk_id, walkId)))
    .get();
}

function notFound(c: Context<AppEnv>) {
  return problem(c, 404, "walk_not_found", `No walk ${c.req.param("walk_id")}`);
}

function relayLater(c: Context<AppEnv>, db: Database) {
  c.executionCtx.waitUntil(
    relayOutbox(db, c.env.EVENTS, c.env.AUTH_MODE === "test").catch((err) =>
      console.warn("outbox relay deferred:", err instanceof Error ? err.message : err),
    ),
  );
}

/** Close or progress a walk and commit its event in one D1 batch.
 *
 * The UPDATE carries the status the caller saw, so of two concurrent
 * transitions only one changes the row, and the outbox INSERT ... SELECT
 * is keyed on last_event_id so only that one commits an event. Returns the
 * walk as it now stands, or null when another request won the race. */
async function transition(
  c: Context<AppEnv>,
  db: Database,
  row: WalkRow,
  fromStatuses: string[],
  changes: Partial<WalkRow>,
  channel: string,
  event: ReturnType<typeof envelope>,
): Promise<WalkRow | null> {
  const ob = outboxRow(channel, event);
  const update = db
    .update(walks)
    .set({ ...changes, last_event_id: event.id })
    .where(and(eq(walks.walk_id, row.walk_id), inArray(walks.status, fromStatuses)))
    .toSQL();
  // Through the D1 binding: drizzle's batch cannot prepare a raw INSERT ... SELECT.
  const d1 = c.env.DB;
  await d1.batch([
    d1.prepare(update.sql).bind(...update.params),
    d1
      .prepare(
        "INSERT INTO outbox (event_id, channel, subject, envelope, created_at) " +
          "SELECT ?1, ?2, ?3, ?4, ?5 FROM walks WHERE walk_id = ?6 AND last_event_id = ?1",
      )
      .bind(ob.event_id, ob.channel, ob.subject, ob.envelope, ob.created_at, row.walk_id),
  ]);
  relayLater(c, db);
  const after = await loadWalk(db, row.walker_id, row.walk_id);
  return after && after.last_event_id === event.id ? after : null;
}

function alreadyClosed(c: Context<AppEnv>, status: string | undefined) {
  return problem(c, 409, "walk_already_closed", `A ${status ?? "closed"} walk cannot be changed.`);
}

export const walkRoutes = new Hono<AppEnv>()
  .get("/", async (c) => {
    const db = database(c.env.DB);
    const conditions = [eq(walks.walker_id, c.get("walkerId"))];
    const from = c.req.query("scheduled_from");
    const to = c.req.query("scheduled_to");
    const status = c.req.query("status");
    if (from) {
      if (!dateTime.safeParse(from).success) return problem(c, 400, "invalid_walk", "scheduled_from must be a date-time");
      conditions.push(gte(walks.scheduled_at, utc(from)));
    }
    if (to) {
      if (!dateTime.safeParse(to).success) return problem(c, 400, "invalid_walk", "scheduled_to must be a date-time");
      conditions.push(lt(walks.scheduled_at, utc(to)));
    }
    if (status) {
      if (!(STATUSES as readonly string[]).includes(status)) {
        return problem(c, 400, "invalid_walk", `status must be one of ${STATUSES.join(", ")}`);
      }
      conditions.push(eq(walks.status, status));
    }
    const rows = await db
      .select()
      .from(walks)
      .where(and(...conditions))
      .orderBy(asc(walks.scheduled_at), asc(walks.created_at))
      .all();
    return c.json({ walks: rows.map(toApi) });
  })
  .post("/", async (c) => {
    const body = await parseBody(c, ScheduleWalk, "invalid_walk");
    if (!body.ok) return body.response;
    const db = database(c.env.DB);
    const walkerId = c.get("walkerId");
    const dogIdsOwned = await ownedDogs(db, walkerId, body.value.dog_ids);
    if (!dogIdsOwned) return problem(c, 400, "invalid_walk", "every dog_id must be one of your dogs");
    const now = nowIso();
    const row: WalkRow = {
      walk_id: crypto.randomUUID(),
      walker_id: walkerId,
      scheduled_at: utc(body.value.scheduled_at),
      duration_minutes: body.value.duration_minutes,
      dog_ids: JSON.stringify(dogIdsOwned),
      status: "scheduled",
      notes: body.value.notes ?? null,
      started_at: null,
      completed_at: null,
      cancelled_at: null,
      cancellation_reason: null,
      last_event_id: null,
      created_at: now,
    };
    const event = envelope(
      TYPES.scheduled,
      {
        walk_id: row.walk_id,
        walker_id: walkerId,
        scheduled_at: row.scheduled_at,
        duration_minutes: row.duration_minutes,
        dog_ids: dogIdsOwned,
      },
      now,
    );
    await db.batch([db.insert(walks).values(row), db.insert(outbox).values(outboxRow(CHANNELS.scheduled, event))]);
    relayLater(c, db);
    return c.json(toApi(row), 201);
  })
  .get("/:walk_id", async (c) => {
    const row = await loadWalk(database(c.env.DB), c.get("walkerId"), c.req.param("walk_id"));
    if (!row) return notFound(c);
    return c.json(toApi(row));
  })
  .patch("/:walk_id", async (c) => {
    const body = await parseBody(c, UpdateWalk, "invalid_walk");
    if (!body.ok) return body.response;
    const db = database(c.env.DB);
    const walkerId = c.get("walkerId");
    const row = await loadWalk(db, walkerId, c.req.param("walk_id"));
    if (!row) return notFound(c);
    if (row.status !== "scheduled") {
      return problem(c, 409, "walk_not_scheduled", `A ${row.status} walk cannot be amended.`);
    }
    const changes: Partial<WalkRow> = {};
    if (body.value.scheduled_at !== undefined) changes.scheduled_at = utc(body.value.scheduled_at);
    if (body.value.duration_minutes !== undefined) changes.duration_minutes = body.value.duration_minutes;
    if (body.value.notes !== undefined) changes.notes = body.value.notes;
    if (body.value.dog_ids !== undefined) {
      const owned = await ownedDogs(db, walkerId, body.value.dog_ids);
      if (!owned) return problem(c, 400, "invalid_walk", "every dog_id must be one of your dogs");
      changes.dog_ids = JSON.stringify(owned);
    }
    if (Object.keys(changes).length > 0) {
      await db.update(walks).set(changes).where(eq(walks.walk_id, row.walk_id)).run();
    }
    return c.json(toApi({ ...row, ...changes }));
  })
  .post("/:walk_id/start", async (c) => {
    const db = database(c.env.DB);
    const row = await loadWalk(db, c.get("walkerId"), c.req.param("walk_id"));
    if (!row) return notFound(c);
    if (row.status !== "scheduled") {
      return problem(c, 409, "walk_not_scheduled", `A ${row.status} walk cannot be started.`);
    }
    const changes = { status: "in_progress", started_at: nowIso() };
    const result = await db
      .update(walks)
      .set(changes)
      .where(and(eq(walks.walk_id, row.walk_id), eq(walks.status, "scheduled")))
      .returning()
      .get();
    if (!result) return problem(c, 409, "walk_not_scheduled", "The walk is no longer scheduled.");
    return c.json(toApi(result));
  })
  .post("/:walk_id/complete", async (c) => {
    const body = await parseBody(c, CompleteWalk, "invalid_walk", false);
    if (!body.ok) return body.response;
    const db = database(c.env.DB);
    const row = await loadWalk(db, c.get("walkerId"), c.req.param("walk_id"));
    if (!row) return notFound(c);
    if (row.status === "completed" || row.status === "cancelled") {
      return problem(c, 409, "walk_already_closed", `A ${row.status} walk cannot be completed.`);
    }
    const now = nowIso();
    const changes: Partial<WalkRow> = { status: "completed", completed_at: now };
    if (body.value.notes !== undefined) changes.notes = body.value.notes;
    const event = envelope(
      TYPES.completed,
      {
        walk_id: row.walk_id,
        walker_id: row.walker_id,
        scheduled_at: row.scheduled_at,
        ...(row.started_at ? { started_at: row.started_at } : {}),
        completed_at: now,
        duration_minutes: row.duration_minutes,
        dog_ids: JSON.parse(row.dog_ids) as string[],
      },
      now,
    );
    const after = await transition(c, db, row, ["scheduled", "in_progress"], changes, CHANNELS.completed, event);
    if (!after) return alreadyClosed(c, (await loadWalk(db, row.walker_id, row.walk_id))?.status);
    return c.json(toApi(after));
  })
  .post("/:walk_id/cancel", async (c) => {
    const body = await parseBody(c, CancelWalk, "invalid_walk");
    if (!body.ok) return body.response;
    const db = database(c.env.DB);
    const row = await loadWalk(db, c.get("walkerId"), c.req.param("walk_id"));
    if (!row) return notFound(c);
    if (row.status === "completed" || row.status === "cancelled") {
      return problem(c, 409, "walk_already_closed", `A ${row.status} walk cannot be cancelled.`);
    }
    const now = nowIso();
    const changes: Partial<WalkRow> = {
      status: "cancelled",
      cancelled_at: now,
      cancellation_reason: body.value.reason,
    };
    const event = envelope(
      TYPES.cancelled,
      {
        walk_id: row.walk_id,
        walker_id: row.walker_id,
        scheduled_at: row.scheduled_at,
        cancelled_at: now,
        reason: body.value.reason,
      },
      now,
    );
    const after = await transition(c, db, row, ["scheduled", "in_progress"], changes, CHANNELS.cancelled, event);
    if (!after) return alreadyClosed(c, (await loadWalk(db, row.walker_id, row.walk_id))?.status);
    return c.json(toApi(after));
  });

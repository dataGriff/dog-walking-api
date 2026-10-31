import { Hono, type Context } from "hono";
import { and, asc, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import { z } from "zod";
import type { AppEnv } from "../env";
import { database, type Database } from "../db";
import { dogs, walks } from "../db/schema";
import { nowIso, present, problem } from "../problem";
import { parseBody } from "../validate";
import { CHANNELS, TYPES, envelope } from "../events/cloudevents";
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

/** True when every id in the JSON array bound as ?5 is a dog of the walker
 * bound as ?2: one parameter however many dogs, checked in the statement
 * that writes the walk. */
const OWNS_ALL_DOGS =
  "(SELECT count(*) FROM dogs WHERE dogs.walker_id = ?2 AND dogs.dog_id IN (SELECT value FROM json_each(?5))) = json_array_length(?5)";

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

/** Apply a lifecycle change and commit its event in one D1 batch.
 *
 * The UPDATE is a compare-and-swap on everything the event reports about
 * the walk as it was read, so the event can never describe a stale walk,
 * and the outbox INSERT ... SELECT is keyed on last_event_id so only the
 * change that stuck commits an event. Returns the walk as it now stands,
 * or null when the walk changed since it was read. */
async function transition(
  c: Context<AppEnv>,
  db: Database,
  row: WalkRow,
  changes: Partial<WalkRow>,
  channel: string,
  event: ReturnType<typeof envelope>,
): Promise<WalkRow | null> {
  const ob = outboxRow(channel, event);
  const update = db
    .update(walks)
    .set({ ...changes, last_event_id: event.id })
    .where(
      and(
        eq(walks.walk_id, row.walk_id),
        eq(walks.status, row.status),
        eq(walks.scheduled_at, row.scheduled_at),
        eq(walks.duration_minutes, row.duration_minutes),
        eq(walks.dog_ids, row.dog_ids),
        row.started_at === null ? isNull(walks.started_at) : eq(walks.started_at, row.started_at),
      ),
    )
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

/** Complete or cancel a walk. The event is built from the walk as read; if
 * it changed before the write (a start, a reschedule), re-read and rebuild
 * so the event matches the walk it closes. */
async function closeWalk(
  c: Context<AppEnv>,
  build: (row: WalkRow, now: string) => {
    changes: Partial<WalkRow>;
    channel: string;
    event: ReturnType<typeof envelope>;
  },
) {
  const db = database(c.env.DB);
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await loadWalk(db, c.get("walkerId"), c.req.param("walk_id") ?? "");
    if (!row) return notFound(c);
    if (row.status === "completed" || row.status === "cancelled") return alreadyClosed(c, row.status);
    const { changes, channel, event } = build(row, nowIso());
    const after = await transition(c, db, row, changes, channel, event);
    if (after) return c.json(toApi(after));
  }
  return problem(c, 409, "walk_changed", "The walk kept changing while it was being closed; try again.");
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
    // The ownership check above is advisory; this insert re-checks it in the
    // same statement, so a dog removed meanwhile cannot end up on the walk.
    // The outbox row is inserted only if the walk was.
    const ob = outboxRow(CHANNELS.scheduled, event);
    const d1 = c.env.DB;
    const [inserted] = await d1.batch([
      d1
        .prepare(
          "INSERT INTO walks (walk_id, walker_id, scheduled_at, duration_minutes, dog_ids, status, notes, created_at) " +
            "SELECT ?1, ?2, ?3, ?4, ?5, 'scheduled', ?6, ?7 WHERE " +
            `${OWNS_ALL_DOGS}`,
        )
        .bind(row.walk_id, walkerId, row.scheduled_at, row.duration_minutes, row.dog_ids, row.notes, now),
      d1
        .prepare(
          "INSERT INTO outbox (event_id, channel, subject, envelope, created_at) " +
            "SELECT ?1, ?2, ?3, ?4, ?5 FROM walks WHERE walk_id = ?3",
        )
        .bind(ob.event_id, ob.channel, ob.subject, ob.envelope, ob.created_at),
    ]);
    if (!inserted?.meta.changes) return problem(c, 400, "invalid_walk", "every dog_id must be one of your dogs");
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
    if (body.value.notes !== undefined) changes.notes = body.value.notes === "" ? null : body.value.notes;
    if (body.value.dog_ids !== undefined) {
      const owned = await ownedDogs(db, walkerId, body.value.dog_ids);
      if (!owned) return problem(c, 400, "invalid_walk", "every dog_id must be one of your dogs");
      changes.dog_ids = JSON.stringify(owned);
    }
    // Guarded on the status, so a walk started or closed since it was read is
    // not amended, and on the new dogs still being the walker's, so a dog
    // removed since the check above cannot be booked.
    const updated = await db
      .update(walks)
      .set(Object.keys(changes).length > 0 ? changes : { walk_id: row.walk_id })
      .where(
        and(
          eq(walks.walk_id, row.walk_id),
          eq(walks.status, "scheduled"),
          changes.dog_ids === undefined
            ? undefined
            : sql`(SELECT count(*) FROM dogs WHERE dogs.walker_id = ${walkerId}
                  AND dogs.dog_id IN (SELECT value FROM json_each(${changes.dog_ids}))) = json_array_length(${changes.dog_ids})`,
        ),
      )
      .returning()
      .get();
    if (!updated) {
      const now = await loadWalk(db, walkerId, row.walk_id);
      if (now?.status === "scheduled") return problem(c, 400, "invalid_walk", "every dog_id must be one of your dogs");
      return problem(c, 409, "walk_not_scheduled", `A ${now?.status ?? "closed"} walk cannot be amended.`);
    }
    return c.json(toApi(updated));
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
    return closeWalk(c, (row, now) => ({
      changes: {
        status: "completed",
        completed_at: now,
        ...(body.value.notes !== undefined ? { notes: body.value.notes } : {}),
      },
      channel: CHANNELS.completed,
      event: envelope(
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
      ),
    }));
  })
  .post("/:walk_id/cancel", async (c) => {
    const body = await parseBody(c, CancelWalk, "invalid_walk");
    if (!body.ok) return body.response;
    return closeWalk(c, (row, now) => ({
      changes: { status: "cancelled", cancelled_at: now, cancellation_reason: body.value.reason },
      channel: CHANNELS.cancelled,
      event: envelope(
        TYPES.cancelled,
        {
          walk_id: row.walk_id,
          walker_id: row.walker_id,
          scheduled_at: row.scheduled_at,
          cancelled_at: now,
          reason: body.value.reason,
        },
        now,
      ),
    }));
  });

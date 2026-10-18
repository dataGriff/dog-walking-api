import type { Database } from "../db";
import { walk_cancelled_events, walk_completed_events, walk_scheduled_events } from "../db/schema";
import { TYPES, type WalkEvent } from "./cloudevents";

/** Land one envelope in the walk history (the walks data contract).
 *
 * Idempotent: every table is keyed on the envelope id and the insert is
 * OR IGNORE, so a redelivered or replayed envelope adds no second row. */
export async function recordHistory(db: Database, event: WalkEvent): Promise<"recorded" | "ignored"> {
  const base = {
    event_id: event.id,
    event_type: event.type,
    event_source: event.source,
    event_time: event.time,
    walk_id: event.data.walk_id,
    walker_id: event.data.walker_id,
    scheduled_at: event.data.scheduled_at,
  };
  switch (event.type) {
    case TYPES.scheduled: {
      const d = event.data as Extract<WalkEvent, { type: string }>["data"] & {
        duration_minutes: number;
        dog_ids: string[];
      };
      await db
        .insert(walk_scheduled_events)
        .values({ ...base, duration_minutes: d.duration_minutes, dog_ids: JSON.stringify(d.dog_ids) })
        .onConflictDoNothing()
        .run();
      return "recorded";
    }
    case TYPES.completed: {
      const d = event.data as {
        started_at?: string;
        completed_at: string;
        duration_minutes: number;
        dog_ids: string[];
      };
      await db
        .insert(walk_completed_events)
        .values({
          ...base,
          started_at: d.started_at ?? null,
          completed_at: d.completed_at,
          duration_minutes: d.duration_minutes,
          dog_ids: JSON.stringify(d.dog_ids),
        })
        .onConflictDoNothing()
        .run();
      return "recorded";
    }
    case TYPES.cancelled: {
      const d = event.data as { cancelled_at: string; reason: string };
      await db
        .insert(walk_cancelled_events)
        .values({ ...base, cancelled_at: d.cancelled_at, reason: d.reason })
        .onConflictDoNothing()
        .run();
      return "recorded";
    }
    default:
      return "ignored";
  }
}

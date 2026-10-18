import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Database } from "../db";
import { outbox, test_flags } from "../db/schema";
import type { Envelope } from "./cloudevents";

/** The outbox insert to batch alongside the aggregate write. */
export function outboxRow(channel: string, env: Envelope<{ walk_id: string }>) {
  return {
    event_id: env.id,
    channel,
    subject: env.subject,
    envelope: JSON.stringify(env),
    created_at: env.time,
  };
}

/** Publish every unpublished outbox row to the queue and mark it sent.
 *
 * At-least-once by design: a crash between send and mark republishes,
 * and consumers dedupe on the envelope id. Returns how many were sent.
 * In test mode the `publication_unavailable` flag simulates a queue
 * outage so the "succeed or fail together" scenarios can hold. */
export async function relayOutbox(db: Database, queue: Queue, testMode: boolean): Promise<number> {
  if (testMode) {
    const flag = await db
      .select()
      .from(test_flags)
      .where(eq(test_flags.key, "publication_unavailable"))
      .get();
    if (flag?.value === "true") {
      throw new Error("event publication unavailable (test flag)");
    }
  }
  const pending = await db
    .select()
    .from(outbox)
    .where(isNull(outbox.published_at))
    .orderBy(asc(outbox.created_at))
    .limit(100)
    .all();
  if (pending.length === 0) return 0;

  await queue.sendBatch(
    pending.map((row) => ({ body: JSON.parse(row.envelope) as unknown, contentType: "json" as const })),
  );

  const sentAt = new Date().toISOString();
  await db
    .update(outbox)
    .set({ published_at: sentAt, attempts: sql`${outbox.attempts} + 1` })
    .where(and(inArray(outbox.event_id, pending.map((row) => row.event_id)), isNull(outbox.published_at)))
    .run();
  return pending.length;
}

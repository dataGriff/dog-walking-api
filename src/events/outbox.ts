import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Database } from "../db";
import { outbox, test_flags } from "../db/schema";
import type { Envelope } from "./cloudevents";

const PAGE = 50;

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
  // Page size keeps each UPDATE under D1's 100 bound parameters; loop so a
  // backlog drains in one relay rather than one page per cron tick.
  let sent = 0;
  for (let page = 0; page < 20; page++) {
    const pending = await db
      .select()
      .from(outbox)
      .where(isNull(outbox.published_at))
      .orderBy(asc(outbox.created_at))
      .limit(PAGE)
      .all();
    if (pending.length === 0) break;
    const ids = pending.map((row) => row.event_id);

    // Count the attempt before it is made, so a row the queue keeps
    // refusing is visible as such (attempts grows, published_at stays null).
    await db
      .update(outbox)
      .set({ attempts: sql`${outbox.attempts} + 1` })
      .where(inArray(outbox.event_id, ids))
      .run();

    await queue.sendBatch(
      pending.map((row) => ({ body: JSON.parse(row.envelope) as unknown, contentType: "json" as const })),
    );

    await db
      .update(outbox)
      .set({ published_at: new Date().toISOString() })
      .where(and(inArray(outbox.event_id, ids), isNull(outbox.published_at)))
      .run();
    sent += pending.length;
    if (pending.length < PAGE) break;
  }
  return sent;
}

import { and, asc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { Database } from "../db";
import { outbox, test_flags } from "../db/schema";
import type { Envelope } from "./cloudevents";

const PAGE = 50;
/** How long a relay owns the rows it claimed before another may retry them. */
const LEASE_MS = 60_000;
/** After this many attempts a row is parked: left unpublished and logged. */
export const MAX_ATTEMPTS = 10;

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
  // Each page is claimed under a lease before it is sent, so concurrent
  // relays (every write request starts one, plus the cron) publish disjoint
  // rows. A row the queue keeps refusing is retried after its lease lapses
  // and parked after MAX_ATTEMPTS, so it can never block the rows behind it.
  let sent = 0;
  for (let page = 0; page < 20; page++) {
    const now = new Date().toISOString();
    const leaseUntil = new Date(Date.now() + LEASE_MS).toISOString();
    const claimable = db
      .select({ event_id: outbox.event_id })
      .from(outbox)
      .where(
        and(
          isNull(outbox.published_at),
          lt(outbox.attempts, MAX_ATTEMPTS),
          or(isNull(outbox.claimed_until), lt(outbox.claimed_until, now)),
        ),
      )
      .orderBy(asc(outbox.created_at))
      .limit(PAGE);
    const claimed = (
      await db
        .update(outbox)
        .set({ claimed_until: leaseUntil, attempts: sql`${outbox.attempts} + 1` })
        .where(inArray(outbox.event_id, claimable))
        .returning()
        .all()
    ).sort((a, b) => a.created_at.localeCompare(b.created_at));
    if (claimed.length === 0) break;

    const published: string[] = [];
    for (const chunk of byteChunks(claimed)) {
      try {
        await queue.sendBatch(chunk.map(message));
        published.push(...chunk.map((row) => row.event_id));
      } catch {
        // One bad message must not hold back the rest: retry them singly.
        for (const row of chunk) {
          try {
            await queue.send(JSON.parse(row.envelope) as unknown, { contentType: "json" });
            published.push(row.event_id);
          } catch (err) {
            const parked = row.attempts >= MAX_ATTEMPTS;
            console.error(
              `outbox ${row.event_id} not published (attempt ${row.attempts}${parked ? ", parked" : ""}):`,
              err instanceof Error ? err.message : err,
            );
          }
        }
      }
    }
    if (published.length > 0) {
      await db
        .update(outbox)
        .set({ published_at: new Date().toISOString(), claimed_until: null })
        .where(inArray(outbox.event_id, published))
        .run();
    }
    sent += published.length;
    if (claimed.length < PAGE) break;
  }
  return sent;
}

type OutboxRow = typeof outbox.$inferSelect;

function message(row: OutboxRow) {
  return { body: JSON.parse(row.envelope) as unknown, contentType: "json" as const };
}

/** Split rows into sendBatch calls under Queues' batch limits (100
 * messages, 256 KB), with headroom for per-message overhead. */
function byteChunks(rows: OutboxRow[]): OutboxRow[][] {
  const chunks: OutboxRow[][] = [];
  let current: OutboxRow[] = [];
  let bytes = 0;
  for (const row of rows) {
    const size = row.envelope.length + 100;
    if (current.length > 0 && (bytes + size > 200_000 || current.length === 100)) {
      chunks.push(current);
      current = [];
      bytes = 0;
    }
    current.push(row);
    bytes += size;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

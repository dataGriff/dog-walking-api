import { and, asc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { Database } from "../db";
import { outbox, test_flags } from "../db/schema";
import type { Envelope } from "./cloudevents";

const PAGE = 50;
/** How long a relay owns the rows it claimed before another may retry them. */
const LEASE_MS = 60_000;
/** From this many attempts on, a row still unpublished is stuck: it is
 * logged, retried only hourly, and no longer holds its walk's later events
 * back. It is never given up on: an outage delays events, it does not lose them. */
export const STUCK_AFTER = 10;
const STUCK_LEASE_MS = 3_600_000;
/** Consecutive single-send failures after which the queue is taken to be
 * down and the rest of this relay is skipped (the leases bring them back). */
const DOWN_AFTER = 3;

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
  // rows. A row the queue refuses is retried after its lease lapses, however
  // long that takes. A walk's later events wait behind its earliest
  // unpublished one, so a walk's events publish in order, unless that one
  // is stuck: a single bad message must not freeze its walk forever.
  // When the queue looks down the relay stops early rather than retrying
  // every row on every request.
  let sent = 0;
  for (let page = 0; page < 20; page++) {
    const now = new Date().toISOString();
    const leaseUntil = new Date(Date.now() + LEASE_MS).toISOString();
    const stuckLeaseUntil = new Date(Date.now() + STUCK_LEASE_MS).toISOString();
    const claimable = db
      .select({ event_id: outbox.event_id })
      .from(outbox)
      .where(
        and(
          isNull(outbox.published_at),
          or(isNull(outbox.claimed_until), lt(outbox.claimed_until, now)),
          sql`NOT EXISTS (SELECT 1 FROM outbox AS earlier WHERE earlier.subject = ${outbox.subject}
                AND earlier.published_at IS NULL AND earlier.created_at < ${outbox.created_at}
                AND earlier.attempts < ${STUCK_AFTER})`,
        ),
      )
      .orderBy(asc(outbox.created_at))
      .limit(PAGE);
    const claimed = (
      await db
        .update(outbox)
        .set({
          // SET reads the row's old values, so attempts + 1 is this attempt.
          claimed_until: sql`CASE WHEN ${outbox.attempts} + 1 >= ${STUCK_AFTER} THEN ${stuckLeaseUntil} ELSE ${leaseUntil} END`,
          attempts: sql`${outbox.attempts} + 1`,
        })
        .where(inArray(outbox.event_id, claimable))
        .returning()
        .all()
    ).sort((a, b) => a.created_at.localeCompare(b.created_at));
    if (claimed.length === 0) break;

    const published: string[] = [];
    let failedInARow = 0;
    chunks: for (const chunk of byteChunks(claimed)) {
      try {
        await queue.sendBatch(chunk.map(message));
        published.push(...chunk.map((row) => row.event_id));
        failedInARow = 0;
      } catch {
        // One bad message must not hold back the rest: retry them singly,
        // until a run of failures says the queue itself is down.
        for (const row of chunk) {
          if (failedInARow >= DOWN_AFTER) break chunks;
          try {
            await queue.send(JSON.parse(row.envelope) as unknown, { contentType: "json" });
            published.push(row.event_id);
            failedInARow = 0;
          } catch (err) {
            failedInARow++;
            const stuck = row.attempts >= STUCK_AFTER ? " - stuck, still retrying" : "";
            console.error(
              `outbox ${row.event_id} not published (attempt ${row.attempts}${stuck}):`,
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
    // A page that published nothing means the queue is refusing: stop and
    // let the leases bring these rows back. Otherwise keep going, even after
    // a short page, since publishing a walk's event may have made its next
    // one claimable; failed rows stay leased, so the loop ends.
    if (published.length === 0) break;
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

import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../src/db/schema";
import { relayOutbox, STUCK_AFTER } from "../src/events/outbox";

/** The relay against a real SQLite outbox (the D1 migrations, via drizzle's
 * proxy driver over node:sqlite) and a queue that fails on demand. */
function setup() {
  const sqlite = new DatabaseSync(":memory:");
  const dir = new URL("../migrations/", import.meta.url);
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    for (const stmt of readFileSync(new URL(file, dir), "utf8").split("--> statement-breakpoint")) {
      if (stmt.trim()) sqlite.exec(stmt);
    }
  }
  const db = drizzle(async (sql, params, method) => {
    const stmt = sqlite.prepare(sql);
    stmt.setReturnArrays(true);
    if (method === "run") {
      stmt.run(...(params as never[]));
      return { rows: [] };
    }
    const rows = stmt.all(...(params as never[])) as unknown as unknown[][];
    return { rows: method === "get" ? (rows[0] ?? []) : rows } as { rows: never };
  }, { schema });

  let down = false;
  const sent: string[] = [];
  const fail = () => {
    if (down) throw new Error("queue unavailable");
  };
  const queue = {
    async sendBatch(messages: { body: { id: string } }[]) {
      fail();
      sent.push(...messages.map((m) => m.body.id));
    },
    async send(body: { id: string }) {
      fail();
      sent.push(body.id);
    },
  } as unknown as Queue;

  let seq = 0;
  const enqueue = (walk: string, id: string) => {
    const at = new Date(Date.parse("2026-10-31T09:00:00Z") + seq++ * 1000).toISOString();
    sqlite
      .prepare("INSERT INTO outbox (event_id, channel, subject, envelope, created_at) VALUES (?, 'c', ?, ?, ?)")
      .run(id, walk, JSON.stringify({ id }), at);
  };
  const unpublished = () =>
    (sqlite.prepare("SELECT count(*) AS n FROM outbox WHERE published_at IS NULL").get() as { n: number }).n;
  return {
    db: db as never,
    queue,
    sent,
    enqueue,
    unpublished,
    setDown: (v: boolean) => (down = v),
  };
}

describe("outbox relay", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-31T10:00:00Z"));
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.useRealTimers());

  it("never gives up on an event, however long the queue is down", async () => {
    const o = setup();
    o.enqueue("w1", "e1");
    o.setDown(true);
    for (let minute = 0; minute < STUCK_AFTER + 5; minute++) {
      await relayOutbox(o.db, o.queue, false);
      vi.advanceTimersByTime(61_000); // past the lease
    }
    expect(o.unpublished()).toBe(1);
    o.setDown(false);
    expect(await relayOutbox(o.db, o.queue, false)).toBe(1);
    expect(o.sent).toEqual(["e1"]);
    expect(o.unpublished()).toBe(0);
  });

  it("publishes a walk's events in order, in one relay once the queue is up", async () => {
    const o = setup();
    o.enqueue("w1", "w1-scheduled");
    o.enqueue("w2", "w2-scheduled");
    o.enqueue("w1", "w1-completed");
    expect(await relayOutbox(o.db, o.queue, false)).toBe(3);
    expect(o.sent.indexOf("w1-scheduled")).toBeLessThan(o.sent.indexOf("w1-completed"));
  });

  it("holds a walk's later event behind an earlier one that failed", async () => {
    const o = setup();
    o.enqueue("w1", "w1-scheduled");
    o.setDown(true);
    await relayOutbox(o.db, o.queue, false); // w1-scheduled fails and stays leased
    o.setDown(false);
    o.enqueue("w1", "w1-completed");
    o.enqueue("w2", "w2-scheduled");
    await relayOutbox(o.db, o.queue, false);
    expect(o.sent).toEqual(["w2-scheduled"]); // w1-completed must not overtake
    vi.advanceTimersByTime(61_000);
    await relayOutbox(o.db, o.queue, false);
    expect(o.sent).toEqual(["w2-scheduled", "w1-scheduled", "w1-completed"]);
  });
});

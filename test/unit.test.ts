import { describe, expect, it } from "vitest";
import { present } from "../src/problem";
import { envelope, SOURCE, TYPES } from "../src/events/cloudevents";
import { outboxRow } from "../src/events/outbox";
import { resolveWalker } from "../src/auth";

describe("present", () => {
  it("drops null and undefined members so optional contract fields are absent", () => {
    expect(present({ a: 1, b: null, c: undefined, d: "x" })).toEqual({ a: 1, d: "x" });
  });
});

describe("CloudEvents envelope", () => {
  it("is a 1.0 structured envelope keyed on the walk", () => {
    const e = envelope(TYPES.scheduled, { walk_id: "w1", walker_id: "u1" }, "2026-01-01T00:00:00.000Z");
    expect(e.specversion).toBe("1.0");
    expect(e.source).toBe(SOURCE);
    expect(e.type).toBe("com.hungovercoders.walks.scheduled.v1");
    expect(e.subject).toBe("w1");
    expect(e.datacontenttype).toBe("application/json");
    expect(e.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("gives every envelope its own id", () => {
    const a = envelope(TYPES.completed, { walk_id: "w1" }, "2026-01-01T00:00:00.000Z");
    const b = envelope(TYPES.completed, { walk_id: "w1" }, "2026-01-01T00:00:00.000Z");
    expect(a.id).not.toBe(b.id);
  });

  it("outbox rows are keyed on the envelope id and carry the whole envelope", () => {
    const e = envelope(TYPES.cancelled, { walk_id: "w1" }, "2026-01-01T00:00:00.000Z");
    const row = outboxRow("walks.cancelled.v1", e);
    expect(row.event_id).toBe(e.id);
    expect(row.subject).toBe("w1");
    expect(JSON.parse(row.envelope)).toEqual(e);
  });
});

describe("test-mode auth", () => {
  const env = { AUTH_MODE: "test" } as Parameters<typeof resolveWalker>[1];
  it("accepts test:<walker_id>", async () => {
    expect(await resolveWalker("test:walker-anna", env)).toBe("walker-anna");
  });
  it("rejects anything else", async () => {
    expect(await resolveWalker("test:", env)).toBeNull();
    expect(await resolveWalker("eyJhbGci.fake.jwt", env)).toBeNull();
  });
  it("clerk mode without a secret key rejects every token", async () => {
    expect(await resolveWalker("test:walker-anna", { AUTH_MODE: "clerk" } as typeof env)).toBeNull();
  });
});

import { Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { ApiWorld } from "./world.ts";
import { carries, fieldList } from "./common.ts";

// --- actions: the same sentence serves as a Given ("was") and a When ("is")

When(/^the walk (?:is|was) started via startWalk$/, async function (this: ApiWorld) {
  await this.call("POST", `/walks/${this.currentWalk!.walk_id}/start`);
  if (this.last.status === 200) this.currentWalk = this.last.body;
});

When(/^the walk (?:is|was) completed via completeWalk$/, async function (this: ApiWorld) {
  await this.call("POST", `/walks/${this.currentWalk!.walk_id}/complete`);
  if (this.last.status === 200) this.currentWalk = this.last.body;
});

When("the walk is completed with notes {string} via completeWalk", async function (this: ApiWorld, notes: string) {
  this.given = { notes };
  await this.call("POST", `/walks/${this.currentWalk!.walk_id}/complete`, { notes });
  if (this.last.status === 200) this.currentWalk = this.last.body;
});

When(/^the walk (?:is|was) cancelled because "([^"]+)" via cancelWalk$/, async function (this: ApiWorld, reason: string) {
  this.given = { reason };
  await this.call("POST", `/walks/${this.currentWalk!.walk_id}/cancel`, { reason });
  if (this.last.status === 200) this.currentWalk = this.last.body;
});

// --- the walk after an action

Then("the walk carries a started_at", function (this: ApiWorld) {
  carries(this.last.body, ["started_at"], "the walk");
});

Then("the walk carries a completed_at and the notes", function (this: ApiWorld) {
  carries(this.last.body, ["completed_at", "notes"], "the walk");
  assert.equal(this.last.body!.notes, this.given.notes);
});

Then("the walk carries a completed_at but no started_at", function (this: ApiWorld) {
  carries(this.last.body, ["completed_at"], "the walk");
  assert.equal(this.last.body!.started_at, undefined, "started_at is absent");
});

Then("the walk carries a cancelled_at and the cancellation_reason {string}", function (this: ApiWorld, reason: string) {
  carries(this.last.body, ["cancelled_at", "cancellation_reason"], "the walk");
  assert.equal(this.last.body!.cancellation_reason, reason);
});

Then("the cancellation is accepted and records that reason", async function (this: ApiWorld) {
  this.expectStatus(200, "cancelling the walk");
  assert.equal(this.last.body!.cancellation_reason, this.given.reason);
  const walk = await this.refreshWalk();
  assert.equal(walk.status, "cancelled");
  assert.equal(walk.cancellation_reason, this.given.reason);
});

Then("a reason outside this list is rejected with a {int}", async function (this: ApiWorld, status: number) {
  const walk = await this.scheduleWalk(["Biscuit"]);
  await this.call("POST", `/walks/${walk.walk_id}/cancel`, { reason: "felt_like_it" });
  this.expectStatus(status, "cancelling for an undeclared reason");
  assert.ok(typeof this.last.body?.error_code === "string", "the problem body carries an error_code");
});

// --- events

Given("event publication is unavailable", async function (this: ApiWorld) {
  const reply = await this.harness("POST", "/flags", { publication_unavailable: true });
  assert.equal(reply.status, 200);
});

Then("a {string} event is guaranteed to be published for the walk", async function (this: ApiWorld, eventName: string) {
  const walkId = this.currentWalk!.walk_id;
  const [row] = await this.outboxFor(walkId, eventName);
  assert.ok(row, `the ${eventName} event was committed with the walk`);
  const table = this.historyTable(eventName);
  await this.eventually(async () => (await this.historyFor(table, walkId))[0], `${eventName} to land in ${table}`);
});

Then("the {string} event is published once publication recovers", async function (this: ApiWorld, eventName: string) {
  const walkId = this.currentWalk!.walk_id;
  const table = this.historyTable(eventName);
  // Nothing lands while publication is down...
  await new Promise((r) => setTimeout(r, 500));
  assert.equal((await this.historyFor(table, walkId)).length, 0, "no event is delivered while publication is unavailable");
  const [pending] = await this.outboxFor(walkId, eventName);
  assert.ok(pending && pending.published_at == null, "the event waits in the outbox, unpublished");
  // ...and everything does once it recovers (the cron does this in production).
  await this.harness("POST", "/flags", { publication_unavailable: false });
  const relay = await this.harness("POST", "/relay");
  assert.equal(relay.status, 200, `relay: ${JSON.stringify(relay.body)}`);
  await this.eventually(async () => (await this.historyFor(table, walkId))[0], `${eventName} to land in ${table}`);
});

Then(/^no (?:completed )?walk ever exists without its "([^"]+)" event$/, async function (this: ApiWorld, eventName: string) {
  const walk = await this.refreshWalk();
  const rows = await this.outboxFor(walk.walk_id, eventName);
  assert.equal(rows.length, 1, `exactly one ${eventName} event is committed for the walk`);
  assert.ok(rows[0]!.published_at, "and it has now been published");
});

Then("a {string} event is published on {string}", async function (this: ApiWorld, eventName: string, channel: string) {
  const walkId = this.currentWalk!.walk_id;
  const row = await this.eventually(
    async () => (await this.outboxFor(walkId, eventName)).find((r) => r.channel === channel && r.published_at),
    `${eventName} on ${channel}`,
  );
  this.envelope = row.envelope;
  await this.eventually(
    async () => (await this.historyFor(this.historyTable(eventName), walkId))[0],
    `${eventName} to be consumed`,
  );
});

Then("the envelope carries specversion {string}, a unique id and a time", async function (this: ApiWorld, specversion: string) {
  const env = this.envelope!;
  assert.equal(env.specversion, specversion);
  assert.match(env.id, /^[0-9a-f-]{36}$/);
  assert.ok(!Number.isNaN(Date.parse(env.time)), "time is a date-time");
  const all = await this.outboxFor(this.currentWalk!.walk_id);
  assert.equal(all.filter((r) => r.event_id === env.id).length, 1, "the id is unique");
});

Then("the envelope source is {word} and its type is {word}", function (this: ApiWorld, source: string, type: string) {
  assert.equal(this.envelope!.source, source);
  assert.equal(this.envelope!.type, type);
});

Then("the envelope subject is the walk_id, with datacontenttype {string}", function (this: ApiWorld, ct: string) {
  assert.equal(this.envelope!.subject, this.currentWalk!.walk_id);
  assert.equal(this.envelope!.datacontenttype, ct);
});

Then(/^the data carries the (.+)$/, function (this: ApiWorld, fields: string) {
  const data = this.envelope!.data;
  carries(data, fieldList(fields), "the event data");
  assert.equal(data.walk_id, this.currentWalk!.walk_id);
  assert.equal(data.walker_id, this.walkerId());
});

Then("handlers dedupe on the envelope id, not the natural key", async function (this: ApiWorld) {
  const env = this.envelope!;
  const table = Object.values({ s: "walk_scheduled_events", c: "walk_completed_events", x: "walk_cancelled_events" }).find(
    (t) => t.includes(env.type.split(".").at(-2)!),
  )!;
  const before = await this.historyFor(table, this.currentWalk!.walk_id);
  assert.equal(before.length, 1);
  const replay = await this.harness("POST", "/replay", { event_id: env.id });
  assert.equal(replay.status, 200);
  await new Promise((r) => setTimeout(r, 1500));
  const after = await this.historyFor(table, this.currentWalk!.walk_id);
  assert.equal(after.length, 1, "replaying the same envelope id adds no row");
  assert.equal(after[0]!.event_id, env.id, "the row is keyed on the envelope id, not walk_id");
});

// --- the history data contract

Then(/^the history table (\w+) carries one row for the walk with its (.+)$/, async function (this: ApiWorld, table: string, fields: string) {
  const walkId = this.currentWalk!.walk_id;
  const rows = await this.eventually(async () => {
    const r = await this.historyFor(table, walkId);
    return r.length > 0 ? r : null;
  }, `a ${table} row`);
  assert.equal(rows.length, 1, `exactly one ${table} row for the walk`);
  carries(rows[0]!, fieldList(fields), `the ${table} row`);
  assert.equal(rows[0]!.walker_id, this.walkerId());
});

Then("the history table {word} carries no row for the walk", async function (this: ApiWorld, table: string) {
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((await this.historyFor(table, this.currentWalk!.walk_id)).length, 0);
});

Then("replaying the same envelope id adds no second row", async function (this: ApiWorld) {
  const walkId = this.currentWalk!.walk_id;
  const [completed] = await this.outboxFor(walkId, "WalkCompleted");
  assert.ok(completed, "the completion event is in the outbox");
  const replay = await this.harness("POST", "/replay", { event_id: completed.event_id });
  assert.equal(replay.status, 200);
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal((await this.historyFor("walk_completed_events", walkId)).length, 1);
});

When("the walk is completed with notes that are not text via completeWalk", async function (this: ApiWorld) {
  await this.call("POST", `/walks/${this.currentWalk!.walk_id}/complete`, { notes: 42 });
});

Then("the walk status is still {string} when fetched via getWalk", async function (this: ApiWorld, status: string) {
  const walk = await this.refreshWalk();
  assert.equal(walk.status, status);
});

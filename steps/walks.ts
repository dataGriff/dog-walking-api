import { Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { ApiWorld } from "./world.ts";
import { carries, fieldList } from "./common.ts";

// --- scheduling

When(
  /^the walker schedules a (\d+) minute walk for "([^"]+)"(?: and "([^"]+)")? via scheduleWalk$/,
  async function (this: ApiWorld, minutes: string, dogA: string, dogB?: string) {
    const names = dogB ? [dogA, dogB] : [dogA];
    const dogIds = [];
    for (const n of names) dogIds.push((await this.ensureDog(n)).dog_id);
    const payload = {
      scheduled_at: new Date(Date.now() + 86_400_000).toISOString(),
      duration_minutes: Number(minutes),
      dog_ids: dogIds,
      notes: "Meet at the park gate",
    };
    this.given = payload;
    await this.call("POST", "/walks", payload);
    if (this.last.status === 201 && this.last.body) {
      this.currentWalk = this.last.body;
      for (const n of names) this.walks.set(n, this.last.body);
    }
  },
);

When(/^the walker schedules a walk with (.+) via scheduleWalk$/, async function (this: ApiWorld, problem: string) {
  const biscuit = await this.ensureDog("Biscuit");
  const payload: Record<string, unknown> = {
    scheduled_at: new Date(Date.now() + 86_400_000).toISOString(),
    duration_minutes: 30,
    dog_ids: [biscuit.dog_id],
  };
  if (problem === "no dog_ids") payload.dog_ids = [];
  else if (problem === "a dog_id that is not one of the walker's dogs") payload.dog_ids = [crypto.randomUUID()];
  else if (problem === "a duration_minutes of 0") payload.duration_minutes = 0;
  else assert.fail(`unknown problem: ${problem}`);
  await this.call("POST", "/walks", payload);
});

Given("the walker scheduled a walk for {string}", async function (this: ApiWorld, dog: string) {
  await this.scheduleWalk([dog]);
});

Given("the walker scheduled a walk for {string} at {string}", async function (this: ApiWorld, dog: string, at: string) {
  await this.scheduleWalk([dog], { at });
});

Given("the walker scheduled a walk for {string} and started it", async function (this: ApiWorld, dog: string) {
  const walk = await this.scheduleWalk([dog]);
  await this.call("POST", `/walks/${walk.walk_id}/start`);
  this.expectStatus(200, "starting the walk");
  this.currentWalk = this.last.body;
});

Given(
  "the walker scheduled a walk for {string} and cancelled it because {string}",
  async function (this: ApiWorld, dog: string, reason: string) {
    const walk = await this.scheduleWalk([dog]);
    await this.call("POST", `/walks/${walk.walk_id}/cancel`, { reason });
    this.expectStatus(200, "cancelling the walk");
    this.walks.set(dog, this.last.body!);
  },
);

Given("the walker {string} scheduled a walk for their dog {string}", async function (this: ApiWorld, walker: string, dog: string) {
  await this.scheduleWalk([dog], { walker });
});

// --- fetching and listing

When("the walk is fetched by walk_id via getWalk", async function (this: ApiWorld) {
  await this.call("GET", `/walks/${this.currentWalk!.walk_id}`);
});

When("an unknown walk_id is fetched via getWalk", async function (this: ApiWorld) {
  await this.call("GET", `/walks/${crypto.randomUUID()}`);
});

When("the walker {string} fetches that walk_id via getWalk", async function (this: ApiWorld, walker: string) {
  this.currentWalker = walker;
  await this.call("GET", `/walks/${this.currentWalk!.walk_id}`, undefined, { walker });
});

When("the walks are listed via listWalks", async function (this: ApiWorld) {
  await this.call("GET", "/walks");
});

When("the walks are listed via listWalks without a bearer_auth token", async function (this: ApiWorld) {
  await this.call("GET", "/walks", undefined, { auth: false });
});

When(
  "the walks are listed via listWalks with scheduled_from {string} and scheduled_to {string}",
  async function (this: ApiWorld, from: string, to: string) {
    await this.call("GET", `/walks?scheduled_from=${encodeURIComponent(from)}&scheduled_to=${encodeURIComponent(to)}`);
  },
);

When("the walks are listed via listWalks with status {string}", async function (this: ApiWorld, status: string) {
  await this.call("GET", `/walks?status=${status}`);
});

function listedWalkIds(world: ApiWorld): string[] {
  const list: Record<string, unknown>[] = world.last.body?.walks;
  assert.ok(Array.isArray(list), "the body has a walks array");
  return list.map((w) => String(w.walk_id));
}

Then("the walks list carries the {string} walk before the {string} walk", function (this: ApiWorld, first: string, second: string) {
  const ids = listedWalkIds(this);
  const a = ids.indexOf(this.walks.get(first)!.walk_id);
  const b = ids.indexOf(this.walks.get(second)!.walk_id);
  assert.ok(a !== -1 && b !== -1, `both walks are listed`);
  assert.ok(a < b, `the ${first} walk is listed before the ${second} walk`);
});

Then("the walks list carries the {string} walk but not the {string} walk", function (this: ApiWorld, yes: string, no: string) {
  const ids = listedWalkIds(this);
  assert.ok(ids.includes(this.walks.get(yes)!.walk_id), `the ${yes} walk is listed`);
  assert.ok(!ids.includes(this.walks.get(no)!.walk_id), `the ${no} walk is not listed`);
});

Then("the walker {string} does not see the {string} walk via listWalks", async function (this: ApiWorld, walker: string, dog: string) {
  await this.call("GET", "/walks", undefined, { walker });
  this.expectStatus(200, "listing walks");
  assert.ok(!listedWalkIds(this).includes(this.walks.get(dog)!.walk_id), `the ${dog} walk is not listed`);
});

// --- amending

When("the walk's scheduled_at and duration_minutes are changed via updateWalk", async function (this: ApiWorld) {
  this.before = this.currentWalk;
  this.updated = { scheduled_at: new Date(Date.now() + 3 * 86_400_000).toISOString(), duration_minutes: 60 };
  await this.call("PATCH", `/walks/${this.currentWalk!.walk_id}`, this.updated);
});

When("the walk's duration_minutes is changed via updateWalk", async function (this: ApiWorld) {
  this.before = this.currentWalk;
  this.updated = { duration_minutes: 60 };
  await this.call("PATCH", `/walks/${this.currentWalk!.walk_id}`, this.updated);
});

Then("the walk's scheduled_at and duration_minutes are the new values", function (this: ApiWorld) {
  assert.equal(new Date(this.last.body!.scheduled_at).toISOString(), new Date(this.updated.scheduled_at).toISOString());
  assert.equal(this.last.body!.duration_minutes, this.updated.duration_minutes);
});

Then("the walk's dog_ids and notes are unchanged", function (this: ApiWorld) {
  assert.deepEqual(this.last.body!.dog_ids, this.before!.dog_ids);
  assert.equal(this.last.body!.notes, this.before!.notes);
});

// --- the walk body

Then("the walk status is {string}", function (this: ApiWorld, status: string) {
  assert.ok(this.last.body, "the response has a body");
  assert.equal(this.last.body!.status, status);
});

Then("the walk status is still {string}", function (this: ApiWorld, status: string) {
  assert.equal(this.last.body!.status, status);
});

Then(
  "the walk carries a walk_id, the scheduled_at, duration_minutes {int}, both dog_ids, the notes and created_at",
  function (this: ApiWorld, minutes: number) {
    const walk = this.last.body!;
    carries(walk, ["walk_id", "scheduled_at", "duration_minutes", "dog_ids", "notes", "created_at"], "the walk");
    assert.equal(walk.duration_minutes, minutes);
    assert.equal(new Date(walk.scheduled_at).toISOString(), new Date(this.given.scheduled_at).toISOString());
    assert.deepEqual([...walk.dog_ids].sort(), [...this.given.dog_ids].sort());
    assert.equal(walk.notes, this.given.notes);
  },
);

Then(/^the walk carries the (walk_id.+)$/, function (this: ApiWorld, fields: string) {
  carries(this.last.body, fieldList(fields), "the walk");
  assert.equal(this.last.body!.walk_id, this.currentWalk!.walk_id);
});

When(
  /^the walks are listed via listWalks with (a scheduled_from that is not a date-time|a scheduled_to that is not a date-time|a status outside the declared statuses)$/,
  async function (this: ApiWorld, filter: string) {
  const query =
    filter === "a scheduled_from that is not a date-time"
      ? "scheduled_from=next-tuesday"
      : filter === "a scheduled_to that is not a date-time"
        ? "scheduled_to=2026-13-45"
        : filter === "a status outside the declared statuses"
          ? "status=postponed"
          : assert.fail(`unknown filter: ${filter}`);
    await this.call("GET", `/walks?${query}`);
  },
);

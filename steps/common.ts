import { Given, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { ApiWorld } from "./world.ts";

Given("the walker {string} is signed in", function (this: ApiWorld, walker: string) {
  this.currentWalker = walker;
  this.walkerId(walker);
});

Then("the response status is {int}", function (this: ApiWorld, status: number) {
  this.expectStatus(status, "the last response");
});

Then("the problem body carries an error_code and message", function (this: ApiWorld) {
  const body = this.last.body;
  assert.ok(body, "the response has a JSON body");
  assert.ok(typeof body.error_code === "string" && /^[a-z_]+$/.test(body.error_code), `error_code is lower_snake_case, got ${JSON.stringify(body.error_code)}`);
  assert.ok(typeof body.message === "string" && body.message.length > 0, "message is a non-empty string");
});

/** Assert the named fields are all present (and non-null) on an object. */
export function carries(obj: Record<string, unknown> | null, fields: string[], what: string) {
  assert.ok(obj, `${what} is present`);
  for (const f of fields) {
    assert.ok(obj![f] !== undefined && obj![f] !== null, `${what} carries ${f} (got ${JSON.stringify(obj)})`);
  }
}

/** "a, b and c" / "a, b, and c" / "a and b" -> ["a", "b", "c"], dropping filler words. */
export function fieldList(text: string): string[] {
  return text
    .replace(/\band\b/g, ",")
    .split(",")
    .map((s) => s.trim().replace(/^(?:a|an|the|its|both)\s+/, "").replace(/\s+\d+$/, ""))
    .filter((s) => s.length > 0)
    .map((s) => s.split(/\s+/)[0]!);
}

Then(/^the (client|dog|walk) carries no (\w+)$/, function (this: ApiWorld, _what: string, field: string) {
  assert.ok(this.last.body, "the response has a body");
  assert.equal(this.last.body![field], undefined, `${field} is absent, got ${JSON.stringify(this.last.body)}`);
});

Given("the walker has an open walk for {string}", async function (this: ApiWorld, dog: string) {
  await this.scheduleWalk([dog]);
});

Given("the walker has a cancelled walk for {string}", async function (this: ApiWorld, dog: string) {
  const walk = await this.scheduleWalk([dog]);
  await this.call("POST", `/walks/${walk.walk_id}/cancel`, { reason: "client_request" });
  this.expectStatus(200, "cancelling the walk");
});

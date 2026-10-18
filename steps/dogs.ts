import { Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { ApiWorld } from "./world.ts";
import { carries, fieldList } from "./common.ts";

Given("the client has a dog {string}", async function (this: ApiWorld, name: string) {
  await this.createDog(name, this.currentClient!);
});

Given("the walker has a dog {string}", async function (this: ApiWorld, name: string) {
  await this.ensureDog(name);
});

When("the walker adds a dog named {string} for that client_id via createDog", async function (this: ApiWorld, name: string) {
  const payload = {
    client_id: this.currentClient!.client_id,
    name,
    breed: "Cockapoo",
    date_of_birth: "2022-05-14",
    notes: "Pulls on the lead near squirrels",
  };
  this.given = payload;
  await this.call("POST", "/dogs", payload);
  if (this.last.status === 201 && this.last.body) {
    this.dogs.set(name, this.last.body);
    this.currentDog = this.last.body;
  }
});

When(/^the walker adds a dog with (.+) via createDog$/, async function (this: ApiWorld, problem: string) {
  const payload: Record<string, unknown> = { client_id: this.currentClient!.client_id, name: "Biscuit" };
  if (problem === "a blank name") payload.name = "";
  else if (problem === "a date_of_birth in the future") {
    payload.date_of_birth = new Date(Date.now() + 400 * 86_400_000).toISOString().slice(0, 10);
  } else if (problem === "a client_id that is not one of the walker's clients") payload.client_id = crypto.randomUUID();
  else assert.fail(`unknown problem: ${problem}`);
  await this.call("POST", "/dogs", payload);
});

When("the dog is fetched by dog_id via getDog", async function (this: ApiWorld) {
  await this.call("GET", `/dogs/${this.currentDog!.dog_id}`);
});

When("an unknown dog_id is fetched via getDog", async function (this: ApiWorld) {
  await this.call("GET", `/dogs/${crypto.randomUUID()}`);
});

When("the walker {string} fetches that dog_id via getDog", async function (this: ApiWorld, walker: string) {
  this.currentWalker = walker;
  await this.call("GET", `/dogs/${this.currentDog!.dog_id}`, undefined, { walker });
});

When("the dogs are listed via listDogs", async function (this: ApiWorld) {
  await this.call("GET", "/dogs");
});

When("the dogs are listed via listDogs filtered by that client_id", async function (this: ApiWorld) {
  // "that client_id" is the Background client, the one Biscuit belongs to.
  const client = this.clients.get("Alice Ahmed") ?? this.currentClient!;
  await this.call("GET", `/dogs?client_id=${client.client_id}`);
});

When("the dog's notes are changed via updateDog", async function (this: ApiWorld) {
  this.before = this.currentDog;
  this.updated = { notes: "Now fine with squirrels" };
  await this.call("PATCH", `/dogs/${this.currentDog!.dog_id}`, this.updated);
});

When("the dog is removed via deleteDog", async function (this: ApiWorld) {
  await this.call("DELETE", `/dogs/${this.currentDog!.dog_id}`);
});

Then("the dog carries a dog_id, the client_id, the name, and created_at", function (this: ApiWorld) {
  carries(this.last.body, ["dog_id", "client_id", "name", "created_at"], "the dog");
  assert.equal(this.last.body!.name, this.given.name);
  assert.equal(this.last.body!.client_id, this.given.client_id);
});

Then(/^the dog carries the (.+)$/, function (this: ApiWorld, fields: string) {
  carries(this.last.body, fieldList(fields), "the dog");
  assert.equal(this.last.body!.dog_id, this.currentDog!.dog_id);
});

Then("the dog's breed, date_of_birth and notes are the ones given", function (this: ApiWorld) {
  for (const f of ["breed", "date_of_birth", "notes"]) {
    assert.equal(this.last.body![f], this.given[f], `dog ${f}`);
  }
});

Then("the dog's notes are the new value", function (this: ApiWorld) {
  assert.equal(this.last.body!.notes, this.updated.notes);
});

Then("the dog's name, breed, date_of_birth and client_id are unchanged", function (this: ApiWorld) {
  for (const f of ["name", "breed", "date_of_birth", "client_id"]) {
    assert.equal(this.last.body![f], this.before![f], `dog ${f}`);
  }
});

function dogNames(world: ApiWorld): string[] {
  const list: Record<string, unknown>[] = world.last.body?.dogs;
  assert.ok(Array.isArray(list), "the body has a dogs array");
  return list.map((d) => String(d.name));
}

Then("the dogs list carries {string} and {string}", function (this: ApiWorld, a: string, b: string) {
  const names = dogNames(this);
  assert.ok(names.includes(a) && names.includes(b), `${a} and ${b} are listed, got ${JSON.stringify(names)}`);
});

Then("the dogs list carries {string} but not {string}", function (this: ApiWorld, a: string, b: string) {
  const names = dogNames(this);
  assert.ok(names.includes(a), `${a} is listed, got ${JSON.stringify(names)}`);
  assert.ok(!names.includes(b), `${b} is not listed, got ${JSON.stringify(names)}`);
});

Then("the walker {string} does not see {string} via listDogs", async function (this: ApiWorld, walker: string, name: string) {
  await this.call("GET", "/dogs", undefined, { walker });
  this.expectStatus(200, "listing dogs");
  assert.ok(!dogNames(this).includes(name), `${name} is not listed`);
});

Then("fetching the dog via getDog returns {int}", async function (this: ApiWorld, status: number) {
  await this.call("GET", `/dogs/${this.currentDog!.dog_id}`);
  this.expectStatus(status, "fetching the dog");
});

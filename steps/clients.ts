import { Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { ApiWorld } from "./world.ts";
import { carries, fieldList } from "./common.ts";

const CLIENT_FIELDS = ["client_id", "name", "email", "phone", "address", "notes", "created_at"];

Given("the walker has a client {string}", async function (this: ApiWorld, name: string) {
  await this.createClient(name);
});

Given("the walker has a client {string} with a dog {string}", async function (this: ApiWorld, client: string, dog: string) {
  const c = await this.createClient(client);
  await this.createDog(dog, c);
});

Given("the walker {string} has a client {string}", async function (this: ApiWorld, walker: string, name: string) {
  await this.createClient(name, {}, walker);
});

Given(
  "the walker {string} has a client {string} with a dog {string}",
  async function (this: ApiWorld, walker: string, client: string, dog: string) {
    const c = await this.createClient(client, {}, walker);
    await this.createDog(dog, c, {}, walker);
  },
);

When("the walker adds a client named {string} via createClient", async function (this: ApiWorld, name: string) {
  const payload = {
    name,
    email: "alice@example.com",
    phone: "+44 7700 900001",
    address: "1 Park Lane, Cardiff",
    notes: "Key under the plant pot",
  };
  this.given = payload;
  await this.call("POST", "/clients", payload);
  if (this.last.status === 201 && this.last.body) {
    this.clients.set(name, this.last.body);
    this.currentClient = this.last.body;
  }
});

When(/^the walker adds a client with (.+) via createClient$/, async function (this: ApiWorld, problem: string) {
  const payload: Record<string, unknown> = { name: "Alice Ahmed", email: "alice@example.com" };
  if (problem === "a blank name") payload.name = "   ";
  else if (problem === "an email that is not an email address") payload.email = "not-an-email";
  else assert.fail(`unknown problem: ${problem}`);
  await this.call("POST", "/clients", payload);
});

When("the client is fetched by client_id via getClient", async function (this: ApiWorld) {
  await this.call("GET", `/clients/${this.currentClient!.client_id}`);
});

When("an unknown client_id is fetched via getClient", async function (this: ApiWorld) {
  await this.call("GET", `/clients/${crypto.randomUUID()}`);
});

When("the walker {string} fetches that client_id via getClient", async function (this: ApiWorld, walker: string) {
  this.currentWalker = walker;
  await this.call("GET", `/clients/${this.currentClient!.client_id}`, undefined, { walker });
});

When("the roster is listed via listClients", async function (this: ApiWorld) {
  await this.call("GET", "/clients");
});

When("the roster is listed via listClients without a bearer_auth token", async function (this: ApiWorld) {
  await this.call("GET", "/clients", undefined, { auth: false });
});

When("the client's phone is changed via updateClient", async function (this: ApiWorld) {
  this.before = this.currentClient;
  this.updated = { phone: "+44 7700 900002" };
  await this.call("PATCH", `/clients/${this.currentClient!.client_id}`, this.updated);
});

When("the client is removed via deleteClient", async function (this: ApiWorld) {
  await this.call("DELETE", `/clients/${this.currentClient!.client_id}`);
});

Then("the client carries a client_id, the name, and created_at", function (this: ApiWorld) {
  carries(this.last.body, ["client_id", "name", "created_at"], "the client");
  assert.equal(this.last.body!.name, this.given.name);
});

Then(/^the client carries the (.+)$/, function (this: ApiWorld, fields: string) {
  carries(this.last.body, fieldList(fields), "the client");
  assert.equal(this.last.body!.client_id, this.currentClient!.client_id);
});

Then("the client's email, phone, address and notes are the ones given", function (this: ApiWorld) {
  for (const f of ["email", "phone", "address", "notes"]) {
    assert.equal(this.last.body![f], this.given[f], `client ${f}`);
  }
});

Then("the client's phone is the new value", function (this: ApiWorld) {
  assert.equal(this.last.body!.phone, this.updated.phone);
});

Then("the client's name, email, address and notes are unchanged", function (this: ApiWorld) {
  for (const f of ["name", "email", "address", "notes"]) {
    assert.equal(this.last.body![f], this.before![f], `client ${f}`);
  }
  carries(this.last.body, CLIENT_FIELDS, "the updated client");
});

Then("the clients list carries {string} before {string}", function (this: ApiWorld, first: string, second: string) {
  const list: Record<string, unknown>[] = this.last.body?.clients;
  assert.ok(Array.isArray(list), "the body has a clients array");
  const names = list.map((c) => c.name);
  const a = names.indexOf(first);
  const b = names.indexOf(second);
  assert.ok(a !== -1 && b !== -1, `${first} and ${second} are listed, got ${JSON.stringify(names)}`);
  assert.ok(a < b, `${first} is listed before ${second}`);
});

Then("the walker {string} does not see {string} via listClients", async function (this: ApiWorld, walker: string, name: string) {
  await this.call("GET", "/clients", undefined, { walker });
  this.expectStatus(200, "listing clients");
  const list: Record<string, unknown>[] = this.last.body?.clients;
  assert.ok(Array.isArray(list), "the body has a clients array");
  assert.ok(!list.some((c) => c.name === name), `${name} is not listed`);
});

Then("fetching the client via getClient returns {int}", async function (this: ApiWorld, status: number) {
  await this.call("GET", `/clients/${this.currentClient!.client_id}`);
  this.expectStatus(status, "fetching the client");
});

import { After, Before, setDefaultTimeout, setWorldConstructor, World } from "@cucumber/cucumber";
import assert from "node:assert/strict";

setDefaultTimeout(20_000);

export type Json = Record<string, any>;
export type Reply = { status: number; body: Json | null };

/** Everything a scenario remembers between steps. The walker ids are
 * unique per scenario so scenarios never see each other's records. */
export class ApiWorld extends World {
  base = (process.env.BASE_URL ?? "http://localhost:8787").replace(/\/$/, "");
  scenarioId = crypto.randomUUID().slice(0, 8);
  walkers = new Map<string, string>();
  currentWalker = "walker-anna";
  last: Reply = { status: 0, body: null };
  clients = new Map<string, Json>();
  dogs = new Map<string, Json>();
  walks = new Map<string, Json>();
  currentClient: Json | null = null;
  currentDog: Json | null = null;
  currentWalk: Json | null = null;
  /** What the last create request asked for, to compare against the reply. */
  given: Json = {};
  /** Values the last update sent. */
  updated: Json = {};
  /** The record as it was before the last update. */
  before: Json | null = null;
  envelope: Json | null = null;
  usedAuth = true;

  walkerId(name = this.currentWalker): string {
    let id = this.walkers.get(name);
    if (!id) {
      id = `${name}-${this.scenarioId}`;
      this.walkers.set(name, id);
    }
    return id;
  }

  async call(
    method: string,
    path: string,
    body?: unknown,
    opts: { auth?: boolean; walker?: string } = {},
  ): Promise<Reply> {
    const headers: Record<string, string> = {};
    this.usedAuth = opts.auth !== false;
    if (this.usedAuth) headers.authorization = `Bearer test:${this.walkerId(opts.walker)}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(this.base + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: Json | null = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }
    this.last = { status: res.status, body: parsed };
    return this.last;
  }

  async harness(method: string, path: string, body?: unknown): Promise<Reply> {
    const res = await fetch(this.base + "/__test" + path, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }

  /** Poll until `probe` returns a truthy value or the deadline passes. */
  async eventually<T>(probe: () => Promise<T | null | undefined | false>, what: string, ms = 8000): Promise<T> {
    const deadline = Date.now() + ms;
    for (;;) {
      const value = await probe();
      if (value) return value;
      if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  expectStatus(status: number, context: string) {
    assert.equal(this.last.status, status, `${context}: expected ${status}, got ${this.last.status} ${JSON.stringify(this.last.body)}`);
  }

  // --- setup helpers: strict, so a setup that silently returned 200 {} fails too

  async createClient(name: string, extra: Json = {}, walker?: string): Promise<Json> {
    const payload = {
      name,
      email: `${name.toLowerCase().replace(/[^a-z]+/g, ".")}@example.com`,
      phone: "+44 7700 900001",
      address: "1 Park Lane, Cardiff",
      notes: "Key under the plant pot",
      ...extra,
    };
    this.given = payload;
    await this.call("POST", "/clients", payload, { walker });
    this.expectStatus(201, `creating client ${name}`);
    const client = this.last.body!;
    assert.ok(typeof client.client_id === "string" && client.client_id, "created client has a client_id");
    this.clients.set(name, client);
    this.currentClient = client;
    return client;
  }

  async createDog(name: string, client: Json, extra: Json = {}, walker?: string): Promise<Json> {
    const payload = {
      client_id: client.client_id,
      name,
      breed: "Cockapoo",
      date_of_birth: "2022-05-14",
      notes: "Pulls on the lead near squirrels",
      ...extra,
    };
    this.given = payload;
    await this.call("POST", "/dogs", payload, { walker });
    this.expectStatus(201, `creating dog ${name}`);
    const dog = this.last.body!;
    assert.ok(typeof dog.dog_id === "string" && dog.dog_id, "created dog has a dog_id");
    this.dogs.set(name, dog);
    this.currentDog = dog;
    return dog;
  }

  /** A dog for the current walker, with a client of their own when none exists yet. */
  async ensureDog(name: string, walker?: string): Promise<Json> {
    const existing = this.dogs.get(name);
    if (existing) return existing;
    const w = walker ?? this.currentWalker;
    const clientKey = `__default_client__${w}`;
    const client = this.clients.get(clientKey) ?? (await this.createClient(`Owner of ${name}`, {}, w));
    this.clients.set(clientKey, client);
    return this.createDog(name, client, {}, w);
  }

  async scheduleWalk(
    dogNames: string[],
    opts: { duration?: number; at?: string; notes?: string; walker?: string } = {},
  ): Promise<Json> {
    const dogIds = [];
    for (const n of dogNames) dogIds.push((await this.ensureDog(n, opts.walker)).dog_id);
    const payload = {
      scheduled_at: opts.at ?? new Date(Date.now() + 86_400_000).toISOString(),
      duration_minutes: opts.duration ?? 45,
      dog_ids: dogIds,
      notes: opts.notes ?? "Meet at the park gate",
    };
    this.given = payload;
    await this.call("POST", "/walks", payload, { walker: opts.walker });
    this.expectStatus(201, `scheduling a walk for ${dogNames.join(", ")}`);
    const walk = this.last.body!;
    assert.ok(typeof walk.walk_id === "string" && walk.walk_id, "scheduled walk has a walk_id");
    for (const n of dogNames) this.walks.set(n, walk);
    this.currentWalk = walk;
    return walk;
  }

  async refreshWalk(): Promise<Json> {
    assert.ok(this.currentWalk, "a walk is in play");
    await this.call("GET", `/walks/${this.currentWalk!.walk_id}`);
    this.expectStatus(200, "fetching the current walk");
    this.currentWalk = this.last.body!;
    return this.currentWalk!;
  }

  historyTable(eventName: string): string {
    return { WalkScheduled: "walk_scheduled_events", WalkCompleted: "walk_completed_events", WalkCancelled: "walk_cancelled_events" }[eventName]!;
  }

  eventType(eventName: string): string {
    return { WalkScheduled: "com.hungovercoders.walks.scheduled.v1", WalkCompleted: "com.hungovercoders.walks.completed.v1", WalkCancelled: "com.hungovercoders.walks.cancelled.v1" }[eventName]!;
  }

  async outboxFor(walkId: string, eventName?: string): Promise<Json[]> {
    const reply = await this.harness("GET", `/outbox?subject=${walkId}`);
    const rows: Json[] = Array.isArray(reply.body?.rows) ? reply.body!.rows : [];
    return eventName ? rows.filter((r) => r.envelope?.type === this.eventType(eventName)) : rows;
  }

  async historyFor(table: string, walkId: string): Promise<Json[]> {
    const reply = await this.harness("GET", `/history/${table}?walk_id=${walkId}`);
    return Array.isArray(reply.body?.rows) ? reply.body!.rows : [];
  }
}

setWorldConstructor(ApiWorld);

Before(async function (this: ApiWorld) {
  await this.harness("POST", "/flags", { publication_unavailable: false });
});

After(async function (this: ApiWorld) {
  await this.harness("POST", "/flags", { publication_unavailable: false });
});

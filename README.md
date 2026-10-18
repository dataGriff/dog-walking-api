# dog-walking-api

The implementation of the **clients** and **walks** services of the
[dog-walking specs](https://github.com/dataGriff/dog-walking-spec), on
Cloudflare Workers. The contracts decide what it does; this repo decides
how:

| Concern | Choice |
| --- | --- |
| HTTP | [Hono](https://hono.dev) on Workers, one route module per contract tag |
| Storage | D1 (SQLite) through Drizzle; migrations under `migrations/` |
| Identity | Clerk session JWTs (`AUTH_MODE=clerk`), the `sub` claim is the walker |
| Events | Transactional outbox in D1, relayed to a Cloudflare Queue; CloudEvents 1.0 envelopes |
| Walk history | The queue consumer (same worker) lands every event in the ODCS tables, deduped on `event_id` |
| Contract pin | `contracts.lock` → `task contracts:fetch` → read-only `.contracts/<service>/` |

The three repos:

- `dog-walking-spec` - OpenAPI, AsyncAPI, Gherkin features and the data
  contract. The record. Merges to its main cut `<service>/v<x.y.z>` tags.
- `dog-walking-api` (this) - implements both services behind the pinned tags.
- `dog-walking-web` - the SvelteKit app a walker uses, consuming the same pins.

## Running locally

```sh
npm install
task contracts:fetch        # the pinned specs, mocks and spec toolchain
task dev                    # wrangler dev on :8787, AUTH_MODE=test, fresh local D1
```

In test mode a request authenticates with `Authorization: Bearer
test:<walker_id>`; every record is scoped to that walker:

```sh
curl -s localhost:8787/clients -H 'authorization: Bearer test:walker-anna'
curl -s -X POST localhost:8787/__test/reset     # seed the mock fixtures (walker user_2walkeranna)
```

For Clerk locally, copy `.dev.vars.example` to `.dev.vars` with your
`CLERK_SECRET_KEY` and run `npx wrangler dev` (AUTH_MODE defaults to clerk).

## The definition of done

`task contracts:verify` runs, in order:

1. `task features` - the pinned feature files, bound strictly by
   `steps/*.ts`, against a worker `scripts/with-worker.mjs` starts on a
   fresh local D1 (54 scenarios).
2. `task features:null` - the same suite against the spec toolchain's null
   service, which answers `200 {}` to everything; zero scenarios may pass.
3. `task schemathesis` - schema fuzz of both OpenAPI surfaces against a
   running worker at `BASE_URL`.
4. `task contracts:test` - Microcks replays every example in the spec
   repo's `mocks/` against the worker (`REST_ENDPOINT` as the containers
   reach it) and validates the responses against the OpenAPI. Needs Docker.

CI (`.github/workflows/ci.yml`) runs exactly these. `contract-converge.yml`
reruns them when Renovate bumps `contracts.lock` and wakes an agent only
when they are red (one-time settings in its header).

Test-only surface, mounted only when `AUTH_MODE=test`: `POST /__test/reset`
(fixtures), `GET /__test/history/<table>?walk_id=`, `GET
/__test/outbox?subject=`, `POST /__test/flags` (`publication_unavailable`),
`POST /__test/relay`, `POST /__test/replay`. `TEST_DEFAULT_WALKER` lets a
runner that cannot send headers (Microcks) act as the fixtures' walker; it
is ignored outside test mode.

## Events

Every state change that promises an event writes the aggregate row and an
`outbox` row in one D1 batch. A relay publishes unpublished rows to the
`dog-walking-events` queue after the request (and every five minutes from
a cron trigger, so a queue outage delays events but never loses them).
The queue consumer writes `walk_scheduled_events`, `walk_completed_events`
and `walk_cancelled_events` with `INSERT OR IGNORE` on the envelope id.
See the spec's `docs/adr-001-outbox.md`.

## Deploying

One-time, with `wrangler login`:

```sh
npx wrangler d1 create dog-walking            # paste the id into wrangler.jsonc
npx wrangler queues create dog-walking-events
npx wrangler queues create dog-walking-events-dlq
npx wrangler secret put CLERK_SECRET_KEY
```

Then every push to `main` runs `.github/workflows/deploy.yml`: migrations
with `wrangler d1 migrations apply --remote`, then `wrangler deploy`.
Repository secrets: `CLOUDFLARE_API_TOKEN` (Workers Scripts, D1 and
Queues edit) and `CLOUDFLARE_ACCOUNT_ID`. Point the web app's
`API_BASE_URL` at the deployed worker.

## Changing the contract

Never here. A behaviour change starts in `dog-walking-spec` behind its
gates; when the tag lands, Renovate opens a PR bumping `contracts.lock`
and the converge workflow proves the implementation still satisfies it.
Regenerate `migrations/` with `npm run db:generate` and
`worker-configuration.d.ts` with `npm run types` after schema or
wrangler.jsonc changes; CI fails if either is stale.

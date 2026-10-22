import { Hono } from "hono";
import type { AppEnv } from "./env";
import { requireWalker } from "./auth";
import { database } from "./db";
import { recordHistory } from "./events/history";
import { relayOutbox } from "./events/outbox";
import type { WalkEvent } from "./events/cloudevents";
import { problem } from "./problem";
import { clientRoutes } from "./routes/clients";
import { dogRoutes } from "./routes/dogs";
import { walkRoutes } from "./routes/walks";
import { testRoutes } from "./testing";

const app = new Hono<AppEnv>();

app.onError((err, c) => {
  console.error(err);
  return problem(c, 500, "internal_error", "Something went wrong on our side.");
});
app.notFound((c) => problem(c, 404, "not_found", `No route ${c.req.method} ${c.req.path}`));

app.get("/healthz", (c) => c.json({ ok: true }));

// The test harness exists only in test mode; elsewhere the paths do not exist.
app.use("/__test/*", async (c, next) => {
  if (c.env.AUTH_MODE !== "test") return c.notFound();
  await next();
});
app.route("/__test", testRoutes);

for (const prefix of ["/clients", "/dogs", "/walks"]) {
  app.use(prefix, requireWalker);
  app.use(`${prefix}/*`, requireWalker);
}
app.route("/clients", clientRoutes);
app.route("/dogs", dogRoutes);
app.route("/walks", walkRoutes);

export default {
  fetch: app.fetch,

  /** Queue consumer: every walk event lands in the history tables, deduped
   * on the envelope id, so delivery can be at-least-once. */
  async queue(batch: MessageBatch<unknown>, env: AppEnv["Bindings"]) {
    const db = database(env.DB);
    for (const message of batch.messages) {
      try {
        await recordHistory(db, message.body as WalkEvent);
        message.ack();
      } catch (err) {
        console.error("history write failed, will retry:", err);
        message.retry();
      }
    }
  },

  /** Cron: drain anything the request-time relay could not publish. */
  async scheduled(_event: ScheduledController, env: AppEnv["Bindings"], ctx: ExecutionContext) {
    ctx.waitUntil(
      relayOutbox(database(env.DB), env.EVENTS, env.AUTH_MODE === "test").catch((err) =>
        console.warn("outbox relay deferred:", err instanceof Error ? err.message : err),
      ),
    );
  },
} satisfies ExportedHandler<AppEnv["Bindings"]>;

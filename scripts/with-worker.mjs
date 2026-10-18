#!/usr/bin/env node
// Start the worker locally in test mode on a fresh D1, seed the fixtures,
// run the given command with BASE_URL pointing at it, then shut down.
//   node scripts/with-worker.mjs -- npx cucumber-js
import { execSync, spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { unstable_startWorker } from "wrangler";

const args = process.argv.slice(2);
const sep = args.indexOf("--");
const command = sep === -1 ? args : args.slice(sep + 1);
if (command.length === 0) {
  console.error("usage: node scripts/with-worker.mjs -- <command...>");
  process.exit(2);
}

rmSync(".wrangler/state", { recursive: true, force: true });
execSync("npx wrangler d1 migrations apply dog-walking --local", { stdio: "inherit" });

const port = Number(process.env.WORKER_PORT ?? 8787);
const worker = await unstable_startWorker({
  config: "wrangler.jsonc",
  // No inspector: a stray debugger port from another dev server must not block the run.
  dev: { server: { port }, inspector: false, logLevel: "warn" },
  bindings: { AUTH_MODE: { type: "plain_text", value: "test" } },
});
const base = await Promise.race([
  worker.url.then((u) => u.toString().replace(/\/$/, "")),
  new Promise((_, reject) => setTimeout(() => reject(new Error("worker did not start within 60s")), 60_000)),
]).catch(async (err) => {
  console.error(err.message);
  await worker.dispose();
  process.exit(1);
});

const reset = await fetch(`${base}/__test/reset`, { method: "POST" });
if (!reset.ok) {
  console.error(`fixture reset failed: ${reset.status} ${await reset.text()}`);
  await worker.dispose();
  process.exit(1);
}
console.log(`worker ready at ${base} (AUTH_MODE=test, fixtures seeded)`);

const child = spawn(command[0], command.slice(1), {
  stdio: "inherit",
  env: {
    ...process.env,
    BASE_URL: base,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, "--import tsx"].filter(Boolean).join(" "),
  },
});
child.on("exit", async (code, signal) => {
  await worker.dispose();
  process.exit(code ?? (signal ? 1 : 0));
});

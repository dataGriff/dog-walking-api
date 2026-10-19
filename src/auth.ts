import { createMiddleware } from "hono/factory";
import { verifyToken } from "@clerk/backend";
import type { AppEnv } from "./env";
import { problem } from "./problem";

/** Resolve the bearer token to a walker id, or null when it is not valid.
 *
 * clerk mode verifies a Clerk session JWT and takes its subject - the
 * Clerk user id - as the walker. test mode accepts `test:<walker_id>` so
 * the feature suite and local development need no identity provider. */
export async function resolveWalker(
  token: string,
  env: AppEnv["Bindings"],
): Promise<string | null> {
  if (env.AUTH_MODE === "test") {
    return token.startsWith("test:") && token.length > 5 ? token.slice(5) : null;
  }
  if (!env.CLERK_SECRET_KEY) return null;
  try {
    const authorizedParties = env.CLERK_AUTHORIZED_PARTIES?.split(",").map((s) => s.trim()).filter(Boolean);
    const payload = await verifyToken(token, {
      secretKey: env.CLERK_SECRET_KEY,
      ...(authorizedParties?.length ? { authorizedParties } : {}),
    });
    return payload.sub ?? null;
  } catch {
    return null;
  }
}

export const requireWalker = createMiddleware<AppEnv>(async (c, next) => {
  const header = c.req.header("authorization") ?? "";
  const [scheme, token] = header.split(/\s+/, 2);
  let walkerId: string | null = null;
  if (scheme?.toLowerCase() === "bearer" && token) {
    walkerId = await resolveWalker(token, c.env);
  } else if (c.env.AUTH_MODE === "test" && c.env.TEST_DEFAULT_WALKER) {
    walkerId = c.env.TEST_DEFAULT_WALKER;
  }
  if (!walkerId) {
    return problem(c, 401, "unauthenticated", "A valid bearer session token is required.");
  }
  c.set("walkerId", walkerId);
  await next();
});

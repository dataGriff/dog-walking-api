import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/** The Problem body every error response carries: a lower_snake_case
 * error_code a client can switch on and a message a person can read. */
export function problem(
  c: Context,
  status: ContentfulStatusCode,
  error_code: string,
  message: string,
) {
  return c.json({ error_code, message }, status);
}

/** Drop null/undefined members so optional contract fields are absent
 * rather than null (the schemas say `type: string`, not nullable). */
export function present<T extends Record<string, unknown>>(row: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (v !== null && v !== undefined) out[k] = v;
  }
  return out as Partial<T>;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** A stored row as the API presents it: without the walker scoping column,
 * and without null optionals. */
export function scoped<T extends { walker_id: string }>(row: T): Partial<Omit<T, "walker_id">> {
  const { walker_id: _w, ...rest } = row;
  return present(rest);
}

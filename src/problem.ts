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

/** PATCH semantics: a field left out is unchanged, an empty string clears
 * an optional field (stored as NULL, so it is absent from responses). */
export function clearingEmpty<T extends Record<string, unknown>>(patch: T): { [K in keyof T]: T[K] | null } {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) out[k] = v === "" ? null : v;
  return out as { [K in keyof T]: T[K] | null };
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

import type { Context } from "hono";
import type { z } from "zod";
import { problem } from "./problem";

/** Parse a JSON body against a schema; on failure answer the contract's
 * 400 Problem with the given error_code. Returns null when a response was
 * already sent. */
export async function parseBody<S extends z.ZodType>(
  c: Context,
  schema: S,
  error_code: string,
  required = true,
): Promise<{ ok: true; value: z.output<S> } | { ok: false; response: Response }> {
  let raw: unknown;
  const text = await c.req.text();
  if (text.trim() === "") {
    if (!required) raw = {};
    else return { ok: false, response: problem(c, 400, error_code, "A JSON body is required.") };
  } else {
    try {
      raw = JSON.parse(text);
    } catch {
      return { ok: false, response: problem(c, 400, error_code, "The body is not valid JSON.") };
    }
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path?.length ? `${issue.path.join(".")}: ` : "";
    return { ok: false, response: problem(c, 400, error_code, `${where}${issue?.message ?? "invalid"}`) };
  }
  return { ok: true, value: parsed.data };
}

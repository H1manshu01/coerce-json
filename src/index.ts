/**
 * coerce-json — repair & coerce LLM JSON output to fit a schema.
 *
 * The step after a parser (e.g. trickle-json) has produced a value: take
 * almost-valid model output and make it fit your schema, reporting every fix.
 *
 * ```ts
 * import { coerce } from "coerce-json";
 * import { z } from "zod";
 *
 * const User = z.object({ id: z.number(), active: z.boolean() });
 * const { value, ok, changes } = coerce('```json\n{"id":"42","active":"true"}\n```', User);
 * // value → { id: 42, active: true }, ok → true, changes → [strip-fence, string->number, string->boolean]
 * ```
 *
 * The root `coerce` auto-detects the schema kind: a Zod schema, a JSON Schema,
 * or a raw core {@link Spec}. The core is zero-dependency; `zod`/`ajv` are
 * optional peers used only for authoritative validation via their adapters.
 */
import { type CoerceOptions, type CoerceResult, type Spec, coerceToSpec, isValid } from "./core.js";
import { type JsonSchema, jsonSchemaToSpec } from "./json-schema.js";
import { type ZodLike, isZodSchema, zodToSpec } from "./zod.js";

export type {
  Change,
  ChangeType,
  CoerceOptions,
  CoerceResult,
  Json,
  Spec,
} from "./core.js";
export { coerceToSpec, isValid } from "./core.js";
export { type JsonSchema, jsonSchemaToSpec } from "./json-schema.js";
export { type ZodLike, isZodSchema, zodToSpec } from "./zod.js";

const SPEC_KINDS = new Set([
  "unknown",
  "string",
  "number",
  "boolean",
  "null",
  "literal",
  "enum",
  "array",
  "object",
  "record",
  "union",
  "optional",
  "nullable",
  "default",
]);

function isSpec(schema: unknown): schema is Spec {
  return (
    typeof schema === "object" &&
    schema !== null &&
    typeof (schema as { kind?: unknown }).kind === "string" &&
    SPEC_KINDS.has((schema as { kind: string }).kind)
  );
}

type Infer<S> = S extends { safeParse(data: unknown): { success: true; data: infer T } | infer _ }
  ? T
  : unknown;

/**
 * Repair and coerce `raw` toward a schema (Zod, JSON Schema, or a core
 * {@link Spec}), returning the coerced value, whether it validated, and the
 * list of fixes applied.
 */
export function coerce<S extends ZodLike>(
  raw: unknown,
  schema: S,
  options?: CoerceOptions,
): CoerceResult<Infer<S>>;
export function coerce<T = unknown>(
  raw: unknown,
  schema: Spec | JsonSchema,
  options?: CoerceOptions,
): CoerceResult<T>;
export function coerce(
  raw: unknown,
  schema: unknown,
  options?: CoerceOptions,
): CoerceResult<unknown> {
  if (isZodSchema(schema)) {
    const spec = zodToSpec(schema);
    const { value, changes } = coerceToSpec(raw, spec, options);
    const parsed = schema.safeParse(value);
    return parsed.success
      ? { value: parsed.data, ok: true, changes }
      : { value, ok: false, changes };
  }

  if (isSpec(schema)) {
    return coerceToSpec(raw, schema, options);
  }

  // Fall back to treating it as a JSON Schema.
  const spec = jsonSchemaToSpec(schema as JsonSchema);
  const result = coerceToSpec(raw, spec, options);
  return { ...result, ok: isValid(result.value, spec) };
}

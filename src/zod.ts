/**
 * coerce-json/zod — Zod adapter.
 *
 * `zod` is an optional peer dependency. This module never imports it: it reads
 * the schema's public `_def` shape structurally (Zod v3) to build a core
 * {@link Spec}, then uses the schema's own `safeParse` for the authoritative
 * `ok`. The core stays zero-dependency.
 */
import { type CoerceOptions, type CoerceResult, type Spec, coerceToSpec } from "./core.js";

/** Minimal structural view of a Zod schema — avoids a hard dependency on `zod`. */
export interface ZodLike<T = unknown> {
  safeParse(data: unknown): { success: true; data: T } | { success: false; error?: unknown };
  _def: { typeName: string };
}

/** Internal, permissive view of a Zod `_def` used for structural introspection. */
interface RawDef {
  typeName: string;
  [k: string]: unknown;
}

const MAX_SPEC_DEPTH = 100;

function def(schema: unknown): RawDef | undefined {
  if (typeof schema !== "object" || schema === null) return undefined;
  const d = (schema as { _def?: unknown })._def;
  if (typeof d !== "object" || d === null) return undefined;
  return d as RawDef;
}

/** Is `schema` a Zod schema (structurally)? */
export function isZodSchema(schema: unknown): schema is ZodLike {
  const d = def(schema);
  return (
    d !== undefined &&
    typeof d.typeName === "string" &&
    d.typeName.startsWith("Zod") &&
    typeof (schema as { safeParse?: unknown }).safeParse === "function"
  );
}

/** Translate a Zod schema into a normalized core {@link Spec}. */
export function zodToSpec(schema: unknown, depth = 0): Spec {
  const d = def(schema);
  if (d === undefined || depth > MAX_SPEC_DEPTH) return { kind: "unknown" };

  switch (d.typeName) {
    case "ZodString":
      return { kind: "string" };
    case "ZodNumber": {
      const checks = (d.checks as { kind: string }[] | undefined) ?? [];
      return { kind: "number", int: checks.some((c) => c.kind === "int") };
    }
    case "ZodBoolean":
      return { kind: "boolean" };
    case "ZodNull":
      return { kind: "null" };
    case "ZodNaN":
    case "ZodUndefined":
    case "ZodVoid":
    case "ZodAny":
    case "ZodUnknown":
    case "ZodNever":
      return { kind: "unknown" };
    case "ZodLiteral":
      return { kind: "literal", value: d.value };
    case "ZodEnum":
      return { kind: "enum", values: (d.values as string[]) ?? [] };
    case "ZodNativeEnum": {
      const values = Object.values((d.values as Record<string, unknown>) ?? {}).filter(
        (v): v is string => typeof v === "string",
      );
      return { kind: "enum", values };
    }
    case "ZodOptional":
      return { kind: "optional", inner: zodToSpec(d.innerType, depth + 1) };
    case "ZodNullable":
      return { kind: "nullable", inner: zodToSpec(d.innerType, depth + 1) };
    case "ZodDefault": {
      const dv = d.defaultValue;
      const value = typeof dv === "function" ? (dv as () => unknown)() : dv;
      return { kind: "default", inner: zodToSpec(d.innerType, depth + 1), value };
    }
    case "ZodArray":
      return { kind: "array", element: zodToSpec(d.type, depth + 1) };
    case "ZodObject": {
      const shapeFn = d.shape as (() => Record<string, unknown>) | undefined;
      const shape = typeof shapeFn === "function" ? shapeFn() : {};
      const fields: Record<string, Spec> = {};
      const required: string[] = [];
      for (const [key, child] of Object.entries(shape)) {
        const childDef = def(child);
        fields[key] = zodToSpec(child, depth + 1);
        const tn = childDef?.typeName;
        if (tn !== "ZodOptional" && tn !== "ZodDefault") required.push(key);
      }
      const unknownKeys = (d.unknownKeys as "strip" | "passthrough" | "strict") ?? "strip";
      return { kind: "object", fields, required, unknownKeys };
    }
    case "ZodRecord":
      return { kind: "record", value: zodToSpec(d.valueType, depth + 1) };
    case "ZodUnion":
    case "ZodDiscriminatedUnion": {
      const raw = d.options;
      const options = Array.isArray(raw)
        ? raw
        : raw instanceof Map
          ? Array.from((raw as Map<unknown, unknown>).values())
          : [];
      return { kind: "union", options: options.map((o) => zodToSpec(o, depth + 1)) };
    }
    // Wrappers that pass through to an inner schema.
    case "ZodEffects":
      return zodToSpec(d.schema, depth + 1);
    case "ZodBranded":
    case "ZodReadonly":
    case "ZodCatch":
      return zodToSpec(d.innerType ?? d.type, depth + 1);
    case "ZodPipeline":
      // Coerce toward the input side; the pipeline's output transform runs in safeParse.
      return zodToSpec(d.in ?? d.out, depth + 1);
    case "ZodLazy": {
      const getter = d.getter as (() => unknown) | undefined;
      return typeof getter === "function" ? zodToSpec(getter(), depth + 1) : { kind: "unknown" };
    }
    default:
      return { kind: "unknown" };
  }
}

/** Infer the output type of a Zod schema. */
type Infer<S> = S extends { safeParse(data: unknown): { success: true; data: infer T } | infer _ }
  ? T
  : unknown;

/**
 * Repair and coerce `raw` toward a Zod `schema`, then validate.
 *
 * ```ts
 * import { z } from "zod";
 * import { coerce } from "coerce-json/zod";
 *
 * const User = z.object({ id: z.number(), active: z.boolean() });
 * const { value, ok, changes } = coerce('{"id":"42","active":"true"}', User);
 * // value → { id: 42, active: true }, ok → true,
 * // changes → [string->number @ id, string->boolean @ active]
 * ```
 */
export function coerce<S extends ZodLike>(
  raw: unknown,
  schema: S,
  options?: CoerceOptions,
): CoerceResult<Infer<S>> {
  const spec = zodToSpec(schema);
  const { value, changes } = coerceToSpec(raw, spec, options);
  const parsed = schema.safeParse(value);
  return parsed.success
    ? { value: parsed.data as Infer<S>, ok: true, changes }
    : { value: value as Infer<S>, ok: false, changes };
}

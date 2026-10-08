/**
 * coerce-json/json-schema — JSON Schema adapter.
 *
 * Translates a (draft-07 / OpenAPI-style) JSON Schema into a core {@link Spec}.
 * `ok` is computed with the dependency-free validator by default; pass an Ajv
 * instance to {@link coerceWithAjv} for authoritative validation. Core stays
 * zero-dependency.
 */
import { type CoerceOptions, type CoerceResult, type Spec, coerceToSpec } from "./core.js";

/** A minimal JSON Schema shape (only the keywords this adapter reads). */
export interface JsonSchema {
  type?: string | string[];
  enum?: unknown[];
  const?: unknown;
  properties?: Record<string, JsonSchema | boolean>;
  required?: readonly string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema | readonly JsonSchema[] | boolean;
  anyOf?: readonly JsonSchema[];
  oneOf?: readonly JsonSchema[];
  default?: unknown;
  nullable?: boolean;
  [k: string]: unknown;
}

const MAX_SPEC_DEPTH = 100;

function isSchemaObject(js: unknown): js is JsonSchema {
  return typeof js === "object" && js !== null && !Array.isArray(js);
}

/** Translate a JSON Schema into a normalized core {@link Spec}. */
export function jsonSchemaToSpec(schema: JsonSchema | boolean, depth = 0): Spec {
  if (typeof schema === "boolean" || !isSchemaObject(schema) || depth > MAX_SPEC_DEPTH) {
    return { kind: "unknown" };
  }

  let spec = coreSpec(schema, depth);

  if (schema.nullable === true) spec = { kind: "nullable", inner: spec };
  if (Object.hasOwn(schema, "default"))
    spec = { kind: "default", inner: spec, value: schema.default };

  return spec;
}

function coreSpec(schema: JsonSchema, depth: number): Spec {
  if (Object.hasOwn(schema, "const")) return { kind: "literal", value: schema.const };

  if (Array.isArray(schema.enum)) {
    const values = schema.enum;
    if (values.every((v) => typeof v === "string")) {
      return { kind: "enum", values: values as string[] };
    }
    return { kind: "union", options: values.map((v) => ({ kind: "literal", value: v }) as Spec) };
  }

  const combo = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(combo)) {
    return { kind: "union", options: combo.map((s) => jsonSchemaToSpec(s, depth + 1)) };
  }

  const t = schema.type;
  if (Array.isArray(t)) {
    const hasNull = t.includes("null");
    const others = t.filter((x) => x !== "null");
    let inner: Spec =
      others.length === 1
        ? fromSingleType(others[0] as string, schema, depth)
        : { kind: "union", options: others.map((x) => fromSingleType(x as string, schema, depth)) };
    if (hasNull) inner = { kind: "nullable", inner };
    return inner;
  }
  if (typeof t === "string") return fromSingleType(t, schema, depth);

  // No explicit type — infer from structure.
  if (schema.properties || schema.additionalProperties !== undefined)
    return objectSpec(schema, depth);
  if (schema.items !== undefined) return arraySpec(schema, depth);
  return { kind: "unknown" };
}

function fromSingleType(t: string, schema: JsonSchema, depth: number): Spec {
  switch (t) {
    case "string":
      return { kind: "string" };
    case "integer":
      return { kind: "number", int: true };
    case "number":
      return { kind: "number" };
    case "boolean":
      return { kind: "boolean" };
    case "null":
      return { kind: "null" };
    case "object":
      return objectSpec(schema, depth);
    case "array":
      return arraySpec(schema, depth);
    default:
      return { kind: "unknown" };
  }
}

function objectSpec(schema: JsonSchema, depth: number): Spec {
  const props = schema.properties ?? {};
  const propKeys = Object.keys(props);

  // Pure dictionary: no declared properties but a value schema for extras.
  if (propKeys.length === 0 && isSchemaObject(schema.additionalProperties)) {
    return { kind: "record", value: jsonSchemaToSpec(schema.additionalProperties, depth + 1) };
  }

  const fields: Record<string, Spec> = {};
  const defaults: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(props)) {
    fields[key] = jsonSchemaToSpec(child, depth + 1);
    if (isSchemaObject(child) && Object.hasOwn(child, "default")) {
      defaults[key] = child.default;
    }
  }
  const required = Array.isArray(schema.required) ? schema.required.filter((k) => k in fields) : [];
  const unknownKeys = schema.additionalProperties === false ? "strict" : "passthrough";

  const spec: Extract<Spec, { kind: "object" }> = { kind: "object", fields, required, unknownKeys };
  if (Object.keys(defaults).length > 0) spec.defaults = defaults;
  return spec;
}

function arraySpec(schema: JsonSchema, depth: number): Spec {
  const items = schema.items;
  if (isSchemaObject(items)) return { kind: "array", element: jsonSchemaToSpec(items, depth + 1) };
  // Tuple validation or unspecified items — don't guess an element type.
  return { kind: "array", element: { kind: "unknown" } };
}

/**
 * Repair and coerce `raw` toward a JSON Schema. `ok` is computed with the
 * dependency-free validator — for strict JSON Schema semantics use
 * {@link coerceWithAjv}.
 */
export function coerce<T = unknown>(
  raw: unknown,
  schema: JsonSchema,
  options?: CoerceOptions,
): CoerceResult<T> {
  const spec = jsonSchemaToSpec(schema);
  return coerceToSpec<T>(raw, spec, options);
}

/** A minimal structural view of an Ajv instance. */
export interface AjvLike {
  compile(schema: unknown): (data: unknown) => boolean;
}

/**
 * Like {@link coerce}, but validates the coerced value with a provided Ajv
 * instance for authoritative `ok`. Ajv is an optional peer dependency.
 */
export function coerceWithAjv<T = unknown>(
  raw: unknown,
  schema: JsonSchema,
  ajv: AjvLike,
  options?: CoerceOptions,
): CoerceResult<T> {
  const spec = jsonSchemaToSpec(schema);
  const { value, changes } = coerceToSpec<T>(raw, spec, options);
  const validate = ajv.compile(schema);
  return { value, ok: validate(value) === true, changes };
}

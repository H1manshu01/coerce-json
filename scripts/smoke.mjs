// Cross-runtime smoke test against the BUILT output (dist/).
// Runs under both Node and Bun to confirm the published package loads and works.
import assert from "node:assert/strict";
import Ajv from "ajv";
import { z } from "zod";
import { coerceToSpec } from "../dist/index.js";
import { coerce as coerceJsonSchema, coerceWithAjv } from "../dist/json-schema.js";
import { coerce as coerceZod } from "../dist/zod.js";

// Core: coerce a raw JSON string toward a core Spec.
{
  const spec = {
    kind: "object",
    required: ["id"],
    fields: { id: { kind: "number" } },
  };
  const { value, ok, changes } = coerceToSpec('{"id":"42"}', spec);
  assert.deepEqual(value, { id: 42 });
  assert.equal(ok, true);
  assert.ok(
    changes.some((c) => c.type === "string->number"),
    "expected a string->number change",
  );
}

// JSON Schema adapter (dependency-free validator).
{
  const schema = {
    type: "object",
    properties: { n: { type: "number" }, flag: { type: "boolean" } },
    required: ["n", "flag"],
  };
  const { value, ok } = coerceJsonSchema({ n: "7", flag: "true" }, schema);
  assert.deepEqual(value, { n: 7, flag: true });
  assert.equal(ok, true);
}

// JSON Schema adapter with authoritative Ajv validation.
{
  const schema = {
    type: "object",
    properties: { n: { type: "number" }, flag: { type: "boolean" } },
    required: ["n", "flag"],
    additionalProperties: false,
  };
  const ajv = new Ajv();
  const { value, ok } = coerceWithAjv({ n: "7", flag: "true" }, schema, ajv);
  assert.deepEqual(value, { n: 7, flag: true });
  assert.equal(ok, true);
}

// Zod adapter: stringified payload coerces and validates.
{
  const User = z.object({ id: z.number(), active: z.boolean() });
  const { value, ok, changes } = coerceZod('{"id":"42","active":"true"}', User);
  assert.deepEqual(value, { id: 42, active: true });
  assert.equal(ok, true);
  assert.ok(changes.length > 0, "expected non-empty changes");
}

// Idempotency: an already-valid value yields zero changes.
{
  const User = z.object({ id: z.number(), active: z.boolean() });
  const { ok, changes } = coerceZod({ id: 42, active: true }, User);
  assert.equal(ok, true);
  assert.equal(changes.length, 0);
}

// Prototype safety: a parsed __proto__ payload must not pollute Object.prototype.
{
  const payload = JSON.parse('{"__proto__":{"x":1},"a":1}');
  const spec = {
    kind: "object",
    required: ["a"],
    fields: { a: { kind: "number" } },
    unknownKeys: "passthrough",
  };
  const { value } = coerceToSpec(payload, spec);
  assert.equal({}.x, undefined);
  assert.equal(Object.prototype.x, undefined);
  assert.equal(Object.getPrototypeOf(value).x, undefined);
}

console.log(`smoke ok (${typeof Bun !== "undefined" ? "bun" : "node"})`);

import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import { coerce, coerceWithAjv, jsonSchemaToSpec } from "../src/json-schema.js";

describe("json-schema adapter", () => {
  const schema = {
    type: "object",
    properties: {
      id: { type: "integer" },
      active: { type: "boolean" },
      role: { type: "string", default: "user" },
    },
    required: ["id", "active"],
    additionalProperties: false,
  } as const;

  it("coerces primitives toward the schema", () => {
    const r = coerce('{"id":"5","active":"yes"}', schema);
    expect(r.value).toEqual({ id: 5, active: true, role: "user" });
    expect(r.ok).toBe(true);
  });

  it("strips unknown keys under additionalProperties:false", () => {
    const r = coerce({ id: 1, active: true, junk: "x" }, schema);
    expect(r.value).toEqual({ id: 1, active: true, role: "user" });
  });

  it("maps type arrays with null to nullable", () => {
    const spec = jsonSchemaToSpec({ type: ["string", "null"] });
    expect(spec).toEqual({ kind: "nullable", inner: { kind: "string" } });
  });

  it("maps enum and const", () => {
    expect(jsonSchemaToSpec({ enum: ["a", "b"] })).toEqual({ kind: "enum", values: ["a", "b"] });
    expect(jsonSchemaToSpec({ const: 5 })).toEqual({ kind: "literal", value: 5 });
  });

  it("treats a value-only additionalProperties as a record", () => {
    const spec = jsonSchemaToSpec({ type: "object", additionalProperties: { type: "number" } });
    expect(spec).toEqual({ kind: "record", value: { kind: "number" } });
  });

  it("validates authoritatively with Ajv", () => {
    const ajv = new Ajv();
    const r = coerceWithAjv('{"id":"5","active":"true"}', schema, ajv);
    expect(r.value).toEqual({ id: 5, active: true, role: "user" });
    expect(r.ok).toBe(true);
  });

  it("reports ok=false via Ajv when unrepairable", () => {
    const ajv = new Ajv();
    const r = coerceWithAjv('{"id":"abc","active":true}', schema, ajv);
    expect(r.ok).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { coerce } from "../src/index.js";
import { coerce as coerceZod, zodToSpec } from "../src/zod.js";

describe("zod adapter", () => {
  it("coerces stringified primitives and validates", () => {
    const User = z.object({ id: z.number(), active: z.boolean(), name: z.string() });
    const r = coerce('{"id":"42","active":"true","name":"Ada"}', User);
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ id: 42, active: true, name: "Ada" });
    expect(r.changes.map((c) => c.type).sort()).toEqual(
      ["parse-json-string", "string->boolean", "string->number"].sort(),
    );
  });

  it("gives a typed value", () => {
    const Schema = z.object({ n: z.number() });
    const r = coerceZod('{"n":"7"}', Schema);
    // Type-level: r.value is { n: number }
    const n: number = r.value.n;
    expect(n).toBe(7);
  });

  it("fills zod .default() for missing fields", () => {
    const Schema = z.object({ role: z.string().default("user"), id: z.number() });
    const r = coerce('{"id": 1}', Schema);
    expect(r.value).toEqual({ id: 1, role: "user" });
    expect(r.ok).toBe(true);
    expect(r.changes.some((c) => c.type === "fill-default")).toBe(true);
  });

  it("handles fenced + prose-wrapped output", () => {
    const Schema = z.object({ answer: z.number() });
    const r = coerce('The answer is:\n```json\n{"answer": "7"}\n```', Schema);
    expect(r.value).toEqual({ answer: 7 });
    expect(r.ok).toBe(true);
  });

  it("coerces enum near-miss only with fuzzy", () => {
    const Schema = z.object({ status: z.enum(["active", "inactive"]) });
    expect(coerce('{"status":"activ"}', Schema).ok).toBe(false);
    const r = coerce('{"status":"activ"}', Schema, { fuzzy: true });
    expect(r.value).toEqual({ status: "active" });
    expect(r.ok).toBe(true);
  });

  it("recurses nested objects and arrays", () => {
    const Schema = z.object({
      user: z.object({ id: z.number() }),
      tags: z.array(z.string()),
      scores: z.array(z.number()),
    });
    const r = coerce('{"user":{"id":"1"},"tags":["a","b"],"scores":["1","2","3"]}', Schema);
    expect(r.value).toEqual({ user: { id: 1 }, tags: ["a", "b"], scores: [1, 2, 3] });
    expect(r.ok).toBe(true);
  });

  it("is idempotent on valid input", () => {
    const Schema = z.object({ id: z.number(), tags: z.array(z.string()) });
    const r = coerce({ id: 1, tags: ["x"] }, Schema);
    expect(r.changes).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("handles optional and nullable", () => {
    const Schema = z.object({ a: z.number().optional(), b: z.string().nullable() });
    const r = coerce('{"b": null}', Schema);
    expect(r.value).toEqual({ b: null });
    expect(r.ok).toBe(true);
  });

  it("reports ok=false when it cannot repair", () => {
    const Schema = z.object({ id: z.number() });
    const r = coerce('{"id": "not-a-number"}', Schema);
    expect(r.ok).toBe(false);
    expect(r.value).toEqual({ id: "not-a-number" });
  });
});

describe("zodToSpec", () => {
  it("extracts enum values and int checks", () => {
    expect(zodToSpec(z.enum(["a", "b"]))).toEqual({ kind: "enum", values: ["a", "b"] });
    expect(zodToSpec(z.number().int())).toEqual({ kind: "number", int: true });
  });
  it("marks optional/default fields as not required", () => {
    const spec = zodToSpec(z.object({ a: z.number(), b: z.number().optional() }));
    expect(spec).toMatchObject({ kind: "object", required: ["a"] });
  });
  it("unwraps effects (refine/transform)", () => {
    const spec = zodToSpec(z.number().refine((n) => n > 0));
    expect(spec).toEqual({ kind: "number", int: false });
  });
});

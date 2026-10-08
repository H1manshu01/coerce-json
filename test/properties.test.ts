import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type Spec, coerceToSpec, isValid } from "../src/core.js";

const userSpec: Spec = {
  kind: "object",
  required: ["id", "name"],
  unknownKeys: "strip",
  fields: {
    id: { kind: "number" },
    name: { kind: "string" },
    active: { kind: "optional", inner: { kind: "boolean" } },
    tags: { kind: "array", element: { kind: "string" } },
  },
};

const jsonLeaf = fc.oneof(
  fc.string(),
  fc.integer(),
  fc.double({ noNaN: true, noDefaultInfinity: true }),
  fc.boolean(),
  fc.constant(null),
);
const jsonValue = fc.jsonValue();

describe("property: idempotency", () => {
  it("coercing an already-valid value is a no-op", () => {
    const validUser = fc.record({
      id: fc.integer(),
      name: fc.string(),
      tags: fc.array(fc.string()),
    });
    fc.assert(
      fc.property(validUser, (user) => {
        const r = coerceToSpec(user, userSpec);
        expect(r.changes).toEqual([]);
        expect(r.value).toEqual(user);
        expect(r.ok).toBe(true);
      }),
    );
  });
});

describe("property: fixpoint", () => {
  it("re-coercing the output yields no further changes, and the output validates or stays unrepairable", () => {
    fc.assert(
      fc.property(jsonValue, (raw) => {
        const first = coerceToSpec(raw, userSpec);
        const second = coerceToSpec(first.value, userSpec);
        expect(second.changes).toEqual([]);
        expect(second.value).toEqual(first.value);
        expect(isValid(first.value, userSpec)).toBe(first.ok);
      }),
    );
  });
});

describe("property: never invents data beyond defaults", () => {
  it("every output key existed in the input (schema has no defaults, fuzzy off)", () => {
    const dict = fc.dictionary(fc.string(), jsonLeaf);
    fc.assert(
      fc.property(dict, (raw) => {
        const r = coerceToSpec(raw, userSpec);
        if (typeof r.value !== "object" || r.value === null) return;
        for (const key of Object.keys(r.value)) {
          expect(Object.hasOwn(raw, key)).toBe(true);
        }
      }),
    );
  });
});

describe("property: every mutation is logged", () => {
  it("changes is empty iff the output deep-equals the (parsed) input", () => {
    fc.assert(
      fc.property(fc.array(jsonLeaf), (arr) => {
        const spec: Spec = { kind: "array", element: { kind: "string" } };
        const r = coerceToSpec(arr, spec);
        const unchanged = JSON.stringify(r.value) === JSON.stringify(arr);
        expect(r.changes.length === 0).toBe(unchanged);
      }),
    );
  });
});

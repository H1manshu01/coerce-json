import { describe, expect, it } from "vitest";
import { type Spec, coerceToSpec } from "../src/core.js";

describe("primitive coercion", () => {
  it("coerces stringified numbers", () => {
    const r = coerceToSpec("42", { kind: "number" });
    expect(r.value).toBe(42);
    expect(r.ok).toBe(true);
    expect(r.changes).toEqual([{ path: [], type: "string->number", from: "42", to: 42 }]);
  });

  it("respects integer targets", () => {
    const r = coerceToSpec("3.5", { kind: "number", int: true });
    expect(r.value).toBe("3.5"); // not an integer — left untouched, never fabricated
    expect(r.ok).toBe(false);
  });

  it("coerces stringified booleans (many spellings)", () => {
    for (const [input, out] of [
      ["true", true],
      ["TRUE", true],
      ["yes", true],
      ["on", true],
      ["false", false],
      ["no", false],
      ["off", false],
    ] as const) {
      expect(coerceToSpec(input, { kind: "boolean" }).value).toBe(out);
    }
  });

  it("coerces numbers and booleans to strings", () => {
    expect(coerceToSpec(42, { kind: "string" }).value).toBe("42");
    expect(coerceToSpec(true, { kind: "string" }).value).toBe("true");
  });

  it("handles null / empty string", () => {
    expect(coerceToSpec("", { kind: "null" }).value).toBe(null);
    expect(coerceToSpec("null", { kind: "null" }).value).toBe(null);
    expect(coerceToSpec("none", { kind: "null" }).value).toBe(null);
  });

  it("does not coerce non-numeric strings", () => {
    const r = coerceToSpec("hello", { kind: "number" });
    expect(r.value).toBe("hello");
    expect(r.changes).toEqual([]);
  });
});

describe("idempotency", () => {
  const spec: Spec = {
    kind: "object",
    required: ["id", "name"],
    fields: { id: { kind: "number" }, name: { kind: "string" } },
  };
  it("is a no-op on already-valid values", () => {
    const r = coerceToSpec({ id: 1, name: "a" }, spec);
    expect(r.changes).toEqual([]);
    expect(r.value).toEqual({ id: 1, name: "a" });
    expect(r.ok).toBe(true);
  });
  it("reaches a fixpoint: coercing the output again changes nothing", () => {
    const once = coerceToSpec({ id: "1", name: 2 }, spec);
    const twice = coerceToSpec(once.value, spec);
    expect(twice.changes).toEqual([]);
    expect(twice.value).toEqual(once.value);
  });
});

describe("structural repair", () => {
  const spec: Spec = {
    kind: "object",
    required: ["a"],
    fields: { a: { kind: "number" } },
  };

  it("strips markdown code fences", () => {
    const r = coerceToSpec('```json\n{"a": 1}\n```', spec);
    expect(r.value).toEqual({ a: 1 });
    expect(r.changes.some((c) => c.type === "strip-fence")).toBe(true);
    expect(r.ok).toBe(true);
  });

  it("extracts JSON embedded in prose", () => {
    const r = coerceToSpec('Sure! Here it is: {"a": "1"} — let me know.', spec);
    expect(r.value).toEqual({ a: 1 });
    expect(r.changes.some((c) => c.type === "extract-json")).toBe(true);
    expect(r.changes.some((c) => c.type === "string->number")).toBe(true);
    expect(r.ok).toBe(true);
  });

  it("does not parse strings when the schema wants a string", () => {
    const r = coerceToSpec('{"a":1}', { kind: "string" });
    expect(r.value).toBe('{"a":1}');
    expect(r.changes).toEqual([]);
  });
});

describe("defaults", () => {
  it("fills a documented default for a missing field", () => {
    const spec: Spec = {
      kind: "object",
      required: [],
      fields: { role: { kind: "default", inner: { kind: "string" }, value: "user" } },
    };
    const r = coerceToSpec({}, spec);
    expect(r.value).toEqual({ role: "user" });
    expect(r.changes).toEqual([{ path: ["role"], type: "fill-default", to: "user" }]);
  });

  it("never fabricates when fillDefaults is off", () => {
    const spec: Spec = {
      kind: "object",
      required: [],
      fields: { role: { kind: "default", inner: { kind: "string" }, value: "user" } },
    };
    const r = coerceToSpec({}, spec, { fillDefaults: false });
    expect(r.value).toEqual({});
    expect(r.changes).toEqual([]);
  });
});

describe("prototype pollution guard", () => {
  it("drops __proto__ / constructor keys from objects", () => {
    const spec: Spec = {
      kind: "object",
      required: ["a"],
      fields: { a: { kind: "number" } },
      unknownKeys: "passthrough",
    };
    const raw = JSON.parse('{"a": 1, "__proto__": {"polluted": true}, "constructor": {}}');
    const r = coerceToSpec(raw, spec);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.hasOwn(r.value as object, "__proto__")).toBe(false);
    expect(r.changes.some((c) => c.type === "drop-proto-key")).toBe(true);
  });

  it("drops dangerous keys from records too", () => {
    const spec: Spec = { kind: "record", value: { kind: "number" } };
    const raw = JSON.parse('{"ok": "1", "__proto__": {"x": 1}}');
    const r = coerceToSpec(raw, spec);
    expect(r.value).toEqual({ ok: 1 });
  });
});

describe("unknown keys", () => {
  const base = {
    kind: "object" as const,
    required: ["a"],
    fields: { a: { kind: "number" as const } },
  };
  it("strips unknown keys by default", () => {
    const r = coerceToSpec({ a: 1, extra: "x" }, { ...base, unknownKeys: "strip" });
    expect(r.value).toEqual({ a: 1 });
  });
  it("keeps unknown keys when passthrough", () => {
    const r = coerceToSpec({ a: 1, extra: "x" }, { ...base, unknownKeys: "passthrough" });
    expect(r.value).toEqual({ a: 1, extra: "x" });
  });
});

describe("enums", () => {
  const spec: Spec = { kind: "enum", values: ["active", "inactive", "pending"] };

  it("maps case-insensitive matches without fuzzy", () => {
    const r = coerceToSpec("ACTIVE", spec);
    expect(r.value).toBe("active");
    expect(r.changes[0]?.note).toBe("case-insensitive");
  });

  it("fixes near-misses only when fuzzy is enabled", () => {
    expect(coerceToSpec("activ", spec).value).toBe("activ"); // off by default
    expect(coerceToSpec("activ", spec, { fuzzy: true }).value).toBe("active");
  });

  it("refuses ambiguous fuzzy matches", () => {
    const amb: Spec = { kind: "enum", values: ["on", "in"] };
    expect(coerceToSpec("an", amb, { fuzzy: true }).value).toBe("an");
  });
});

describe("unions", () => {
  const spec: Spec = { kind: "union", options: [{ kind: "number" }, { kind: "boolean" }] };
  it("picks the coercible branch with the fewest changes", () => {
    expect(coerceToSpec("42", spec).value).toBe(42);
    expect(coerceToSpec("true", spec).value).toBe(true);
  });
  it("leaves a value untouched if it already matches a branch", () => {
    const strOrNum: Spec = { kind: "union", options: [{ kind: "string" }, { kind: "number" }] };
    const r = coerceToSpec("42", strOrNum);
    expect(r.value).toBe("42");
    expect(r.changes).toEqual([]);
  });
});

describe("fuzzy key casing", () => {
  const spec: Spec = {
    kind: "object",
    required: ["firstName"],
    fields: { firstName: { kind: "string" } },
  };
  it("remaps snake_case to the schema's key when fuzzy", () => {
    const r = coerceToSpec({ first_name: "Jo" }, spec, { fuzzy: true });
    expect(r.value).toEqual({ firstName: "Jo" });
    expect(r.changes.some((c) => c.type === "key-casing")).toBe(true);
  });
  it("does not remap keys when fuzzy is off", () => {
    const r = coerceToSpec({ first_name: "Jo" }, spec);
    expect(r.value).toEqual({});
    expect(r.ok).toBe(false);
  });
});

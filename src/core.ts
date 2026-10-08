/**
 * coerce-json — core engine (zero runtime dependencies).
 *
 * The core is schema-agnostic: it coerces a raw value toward a normalized
 * {@link Spec} and reports every mutation it makes in a {@link Change} log.
 * Adapters (`./zod`, `./json-schema`) translate a real schema into a `Spec`.
 *
 * Design rules (enforced by tests):
 *  - Never fabricate data the schema does not imply. Only documented defaults
 *    are filled, and every fill is logged.
 *  - Idempotent: coercing an already-valid value produces zero changes.
 *  - Safe: `__proto__` / `constructor` / `prototype` keys are never copied.
 */

/** JSON-compatible value. */
export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** A normalized description of the type a raw value should be coerced toward. */
export type Spec =
  | { kind: "unknown" }
  | { kind: "string" }
  | { kind: "number"; int?: boolean }
  | { kind: "boolean" }
  | { kind: "null" }
  | { kind: "literal"; value: unknown }
  | { kind: "enum"; values: string[] }
  | { kind: "array"; element: Spec }
  | {
      kind: "object";
      fields: Record<string, Spec>;
      /** Keys that must be present (not optional / not defaulted). */
      required: string[];
      /** Documented defaults for missing keys, filled only when `fillDefaults`. */
      defaults?: Record<string, unknown>;
      /** How to treat keys not in `fields`. Mirrors Zod object modes. */
      unknownKeys?: "strip" | "passthrough" | "strict";
    }
  | { kind: "record"; value: Spec }
  | { kind: "union"; options: Spec[] }
  | { kind: "optional"; inner: Spec }
  | { kind: "nullable"; inner: Spec }
  | { kind: "default"; inner: Spec; value: unknown };

/** The kind of fix that was applied, for the `changes` log. */
export type ChangeType =
  | "strip-fence"
  | "extract-json"
  | "parse-json-string"
  | "trim"
  | "string->number"
  | "string->boolean"
  | "string->null"
  | "number->string"
  | "boolean->string"
  | "empty->null"
  | "fill-default"
  | "enum-fuzzy"
  | "key-casing"
  | "strip-unknown-key"
  | "drop-proto-key";

/** One reported mutation. `path` is the location within the value. */
export interface Change {
  path: (string | number)[];
  type: ChangeType;
  from?: unknown;
  to?: unknown;
  note?: string;
}

export interface CoerceOptions {
  /**
   * Enable lossy, best-guess fixes: enum near-miss matching and object key
   * re-casing. Off by default — these can change meaning, so they are opt-in.
   */
  fuzzy?: boolean;
  /** Max Levenshtein distance for a fuzzy enum match. Default 2. */
  fuzzyEnumMaxDistance?: number;
  /** Fill documented schema defaults for missing object fields. Default true. */
  fillDefaults?: boolean;
  /**
   * When the input is a string but the schema wants a structured value, strip
   * markdown fences and extract the JSON embedded in surrounding prose.
   * Default true.
   */
  unwrapText?: boolean;
  /** Recursion guard. Default 100. */
  maxDepth?: number;
}

export interface CoerceResult<T = unknown> {
  /** Best-effort value coerced toward the schema. */
  value: T;
  /** Did the value satisfy the schema after coercion? */
  ok: boolean;
  /** Every mutation applied, in order — for logging and debugging. */
  changes: Change[];
}

const PROTO_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const DEFAULTS: Required<CoerceOptions> = {
  fuzzy: false,
  fuzzyEnumMaxDistance: 2,
  fillDefaults: true,
  unwrapText: true,
  maxDepth: 100,
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** Peel wrapper specs to the underlying base spec. */
function baseKind(spec: Spec): Spec["kind"] {
  let s = spec;
  while (s.kind === "optional" || s.kind === "nullable" || s.kind === "default") {
    s = s.inner;
  }
  if (s.kind === "union") {
    // A union is "structured" if any branch is.
    return s.options.some((o) => {
      const k = baseKind(o);
      return k === "object" || k === "array" || k === "record";
    })
      ? "object"
      : s.options[0]
        ? baseKind(s.options[0])
        : "unknown";
  }
  return s.kind;
}

function wantsStructured(spec: Spec): boolean {
  const k = baseKind(spec);
  return k === "object" || k === "array" || k === "record" || k === "unknown";
}

// --- structural text repair ---------------------------------------------

/** Strip a single surrounding markdown code fence, if present. */
function stripFence(text: string): string | undefined {
  const t = text.trim();
  // ```lang\n ... \n```  (lang optional)
  const m = t.match(/^```[^\n`]*\n([\s\S]*?)\n?```$/);
  if (m?.[1] !== undefined) return m[1];
  // Bare `inline` fence around JSON
  const inline = t.match(/^`([^`]*)`$/);
  if (inline?.[1] !== undefined) return inline[1];
  return undefined;
}

/**
 * Extract the first balanced JSON object or array embedded in `text`,
 * respecting strings and escapes. Returns the substring or undefined.
 */
function extractBalanced(text: string): string | undefined {
  const start = text.search(/[{[]/);
  if (start === -1) return undefined;
  const open = text[start] as "{" | "[";
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

/** Turn a raw model string into a parsed value, logging each structural fix. */
function unwrapText(
  raw: string,
  path: (string | number)[],
  changes: Change[],
): { value: unknown; handled: boolean } {
  let text = raw;

  const fenced = stripFence(text);
  if (fenced !== undefined) {
    changes.push({ path, type: "strip-fence", from: raw });
    text = fenced;
  }

  const trimmed = text.trim();

  // Direct parse first.
  const direct = tryParse(trimmed);
  if (direct.ok) {
    if (fenced === undefined) changes.push({ path, type: "parse-json-string", from: raw });
    return { value: direct.value, handled: true };
  }

  // Extract JSON embedded in prose.
  const slice = extractBalanced(text);
  if (slice !== undefined) {
    const parsed = tryParse(slice);
    if (parsed.ok) {
      changes.push({ path, type: "extract-json", from: raw, to: slice });
      return { value: parsed.value, handled: true };
    }
  }

  return { value: raw, handled: false };
}

function tryParse(s: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(s) };
  } catch {
    return { ok: false };
  }
}

// --- primitive coercion --------------------------------------------------

const NUMBER_RE = /^[+-]?(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?$/;
const TRUE_WORDS = new Set(["true", "yes", "y", "on", "1"]);
const FALSE_WORDS = new Set(["false", "no", "n", "off", "0"]);

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n]!;
}

/** Find the single closest enum value within `maxDistance`, or undefined if ambiguous/none. */
function closestEnum(input: string, values: string[], maxDistance: number): string | undefined {
  const lc = input.toLowerCase();
  let best: string | undefined;
  let bestDist = Number.POSITIVE_INFINITY;
  let tie = false;
  for (const v of values) {
    const d = levenshtein(lc, v.toLowerCase());
    if (d < bestDist) {
      bestDist = d;
      best = v;
      tie = false;
    } else if (d === bestDist) {
      tie = true;
    }
  }
  if (best === undefined || bestDist > maxDistance || tie) return undefined;
  return best;
}

// --- the recursive walk --------------------------------------------------

interface Ctx {
  changes: Change[];
  opts: Required<CoerceOptions>;
}

function walk(
  value: unknown,
  spec: Spec,
  path: (string | number)[],
  ctx: Ctx,
  depth: number,
): unknown {
  if (depth > ctx.opts.maxDepth) return value;

  switch (spec.kind) {
    case "optional":
      if (value === undefined) return undefined;
      return walk(value, spec.inner, path, ctx, depth);

    case "nullable":
      if (value === null) return null;
      if (value === undefined) return value;
      return walk(value, spec.inner, path, ctx, depth);

    case "default":
      if (value === undefined) {
        if (ctx.opts.fillDefaults) {
          const filled = structuredClone(spec.value);
          ctx.changes.push({ path, type: "fill-default", to: filled });
          return filled;
        }
        return undefined;
      }
      return walk(value, spec.inner, path, ctx, depth);

    case "string":
      return coerceString(value, path, ctx);

    case "number":
      return coerceNumber(value, spec.int ?? false, path, ctx);

    case "boolean":
      return coerceBoolean(value, path, ctx);

    case "null":
      return coerceNull(value, path, ctx);

    case "literal":
      return coerceLiteral(value, spec.value, path, ctx);

    case "enum":
      return coerceEnum(value, spec.values, path, ctx);

    case "array":
      return coerceArray(value, spec.element, path, ctx, depth);

    case "object":
      return coerceObject(value, spec, path, ctx, depth);

    case "record":
      return coerceRecord(value, spec.value, path, ctx, depth);

    case "union":
      return coerceUnion(value, spec.options, path, ctx, depth);

    default:
      return value;
  }
}

function coerceString(value: unknown, path: (string | number)[], ctx: Ctx): unknown {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) {
    const to = String(value);
    ctx.changes.push({ path, type: "number->string", from: value, to });
    return to;
  }
  if (typeof value === "boolean") {
    const to = String(value);
    ctx.changes.push({ path, type: "boolean->string", from: value, to });
    return to;
  }
  return value;
}

function coerceNumber(value: unknown, int: boolean, path: (string | number)[], ctx: Ctx): unknown {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed !== "" && NUMBER_RE.test(trimmed)) {
      const n = Number(trimmed);
      if (Number.isFinite(n) && (!int || Number.isInteger(n))) {
        ctx.changes.push({ path, type: "string->number", from: value, to: n });
        return n;
      }
    }
  }
  return value;
}

function coerceBoolean(value: unknown, path: (string | number)[], ctx: Ctx): unknown {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const lc = value.trim().toLowerCase();
    if (TRUE_WORDS.has(lc)) {
      ctx.changes.push({ path, type: "string->boolean", from: value, to: true });
      return true;
    }
    if (FALSE_WORDS.has(lc)) {
      ctx.changes.push({ path, type: "string->boolean", from: value, to: false });
      return false;
    }
  }
  return value;
}

function coerceNull(value: unknown, path: (string | number)[], ctx: Ctx): unknown {
  if (value === null) return null;
  if (typeof value === "string") {
    const lc = value.trim().toLowerCase();
    if (value === "") {
      ctx.changes.push({ path, type: "empty->null", from: value, to: null });
      return null;
    }
    if (lc === "null" || lc === "nil" || lc === "none") {
      ctx.changes.push({ path, type: "string->null", from: value, to: null });
      return null;
    }
  }
  return value;
}

function coerceLiteral(
  value: unknown,
  literal: unknown,
  path: (string | number)[],
  ctx: Ctx,
): unknown {
  if (value === literal) return value;
  if (typeof literal === "number") return coerceNumber(value, Number.isInteger(literal), path, ctx);
  if (typeof literal === "boolean") return coerceBoolean(value, path, ctx);
  if (typeof literal === "string" && typeof value !== "string")
    return coerceString(value, path, ctx);
  return value;
}

function coerceEnum(
  value: unknown,
  values: string[],
  path: (string | number)[],
  ctx: Ctx,
): unknown {
  if (typeof value !== "string") return value;
  if (values.includes(value)) return value;

  const trimmed = value.trim();
  if (trimmed !== value && values.includes(trimmed)) {
    ctx.changes.push({ path, type: "trim", from: value, to: trimmed });
    return trimmed;
  }

  // Case-insensitive exact match is safe enough to always apply.
  const ciExact = values.find((v) => v.toLowerCase() === trimmed.toLowerCase());
  if (ciExact !== undefined) {
    ctx.changes.push({
      path,
      type: "enum-fuzzy",
      from: value,
      to: ciExact,
      note: "case-insensitive",
    });
    return ciExact;
  }

  if (ctx.opts.fuzzy) {
    const near = closestEnum(trimmed, values, ctx.opts.fuzzyEnumMaxDistance);
    if (near !== undefined) {
      ctx.changes.push({ path, type: "enum-fuzzy", from: value, to: near, note: "near-miss" });
      return near;
    }
  }
  return value;
}

function coerceArray(
  value: unknown,
  element: Spec,
  path: (string | number)[],
  ctx: Ctx,
  depth: number,
): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((item, i) => walk(item, element, [...path, i], ctx, depth + 1));
}

function coerceObject(
  value: unknown,
  spec: Extract<Spec, { kind: "object" }>,
  path: (string | number)[],
  ctx: Ctx,
  depth: number,
): unknown {
  if (!isPlainObject(value)) return value;

  const out: Record<string, unknown> = {};
  const source = value;
  const unknownKeys = spec.unknownKeys ?? "strip";

  // Optional fuzzy key re-casing: map incoming keys onto known field names.
  const keyMap = new Map<string, string>(); // incoming key -> field name
  if (ctx.opts.fuzzy) {
    const fieldNames = Object.keys(spec.fields);
    for (const incoming of Object.keys(source)) {
      if (PROTO_KEYS.has(incoming)) continue;
      if (Object.hasOwn(spec.fields, incoming)) continue;
      const norm = normalizeKey(incoming);
      const match = fieldNames.find((f) => normalizeKey(f) === norm && !Object.hasOwn(source, f));
      if (match !== undefined) keyMap.set(incoming, match);
    }
  }

  // Walk known fields.
  for (const [field, fieldSpec] of Object.entries(spec.fields)) {
    if (PROTO_KEYS.has(field)) continue;

    let present = Object.hasOwn(source, field);
    let raw = present ? source[field] : undefined;

    if (!present) {
      // Pull from a fuzzily re-cased incoming key.
      for (const [incoming, target] of keyMap) {
        if (target === field) {
          present = true;
          raw = source[incoming];
          ctx.changes.push({
            path: [...path, field],
            type: "key-casing",
            from: incoming,
            to: field,
          });
          break;
        }
      }
    }

    if (!present) {
      const explicit = spec.defaults?.[field];
      const def = explicit !== undefined ? { has: true, value: explicit } : findDefault(fieldSpec);
      if (def.has && ctx.opts.fillDefaults) {
        const filled = structuredClone(def.value);
        ctx.changes.push({ path: [...path, field], type: "fill-default", to: filled });
        out[field] = filled;
      }
      // else: leave absent (optional) — never fabricate.
      continue;
    }

    out[field] = walk(raw, fieldSpec, [...path, field], ctx, depth + 1);
  }

  // Handle unknown keys.
  for (const key of Object.keys(source)) {
    if (Object.hasOwn(spec.fields, key) || keyMap.has(key)) continue;
    if (PROTO_KEYS.has(key)) {
      ctx.changes.push({ path: [...path, key], type: "drop-proto-key", from: key });
      continue;
    }
    if (unknownKeys === "passthrough") {
      out[key] = source[key];
      continue;
    }
    // "strict" forbids extras — repair toward validity by dropping them, and
    // log it (a meaningful mutation). "strip" is the schema's own default
    // behavior, so it is removed silently.
    if (unknownKeys === "strict") {
      ctx.changes.push({ path: [...path, key], type: "strip-unknown-key", from: source[key] });
    }
  }

  return out;
}

function coerceRecord(
  value: unknown,
  valueSpec: Spec,
  path: (string | number)[],
  ctx: Ctx,
  depth: number,
): unknown {
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    if (PROTO_KEYS.has(key)) {
      ctx.changes.push({ path: [...path, key], type: "drop-proto-key", from: key });
      continue;
    }
    out[key] = walk(value[key], valueSpec, [...path, key], ctx, depth + 1);
  }
  return out;
}

function coerceUnion(
  value: unknown,
  options: Spec[],
  path: (string | number)[],
  ctx: Ctx,
  depth: number,
): unknown {
  // If the value already validates against a branch, keep it untouched.
  for (const opt of options) {
    if (isValid(value, opt)) return value;
  }
  // Otherwise try each branch on a throwaway change log and pick the branch
  // that both validates and needed the fewest changes.
  let best: { value: unknown; changes: Change[] } | undefined;
  for (const opt of options) {
    const local: Change[] = [];
    const localCtx: Ctx = { changes: local, opts: ctx.opts };
    const coerced = walk(structuredClone(value), opt, path, localCtx, depth + 1);
    if (isValid(coerced, opt)) {
      if (best === undefined || local.length < best.changes.length) {
        best = { value: coerced, changes: local };
      }
    }
  }
  if (best !== undefined) {
    ctx.changes.push(...best.changes);
    return best.value;
  }
  return value;
}

function normalizeKey(k: string): string {
  return k.replace(/[-_\s]/g, "").toLowerCase();
}

/** Unwrap optional/nullable layers to find a documented default, if any. */
function findDefault(spec: Spec): { has: boolean; value?: unknown } {
  let s = spec;
  while (true) {
    if (s.kind === "default") return { has: true, value: s.value };
    if (s.kind === "optional" || s.kind === "nullable") {
      s = s.inner;
      continue;
    }
    return { has: false };
  }
}

// --- dependency-free validator (used for `ok` without an external schema) --

/** Does `value` satisfy `spec`? A light, dependency-free structural check. */
export function isValid(value: unknown, spec: Spec): boolean {
  switch (spec.kind) {
    case "unknown":
      return value !== undefined;
    case "string":
      return typeof value === "string";
    case "number":
      return (
        typeof value === "number" &&
        Number.isFinite(value) &&
        (!spec.int || Number.isInteger(value))
      );
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    case "literal":
      return value === spec.value;
    case "enum":
      return typeof value === "string" && spec.values.includes(value);
    case "optional":
      return value === undefined || isValid(value, spec.inner);
    case "nullable":
      return value === null || isValid(value, spec.inner);
    case "default":
      return value === undefined || isValid(value, spec.inner);
    case "array":
      return Array.isArray(value) && value.every((v) => isValid(v, spec.element));
    case "union":
      return spec.options.some((o) => isValid(value, o));
    case "record":
      return isPlainObject(value) && Object.values(value).every((v) => isValid(v, spec.value));
    case "object": {
      if (!isPlainObject(value)) return false;
      for (const req of spec.required) {
        if (!Object.hasOwn(value, req)) return false;
      }
      for (const [field, fieldSpec] of Object.entries(spec.fields)) {
        if (Object.hasOwn(value, field) && !isValid(value[field], fieldSpec)) return false;
      }
      if ((spec.unknownKeys ?? "strip") === "strict") {
        for (const key of Object.keys(value)) {
          if (!Object.hasOwn(spec.fields, key)) return false;
        }
      }
      return true;
    }
    default:
      return false;
  }
}

/**
 * Coerce `raw` toward a normalized {@link Spec}. The engine is schema-agnostic;
 * adapters build the `Spec`. `ok` is computed with the dependency-free
 * {@link isValid} checker — adapters with a real validator (Zod `safeParse`,
 * Ajv) should recompute `ok` themselves for exact semantics.
 */
export function coerceToSpec<T = unknown>(
  raw: unknown,
  spec: Spec,
  options?: CoerceOptions,
): CoerceResult<T> {
  const opts = { ...DEFAULTS, ...options };
  const changes: Change[] = [];
  const ctx: Ctx = { changes, opts };

  let input = raw;
  // Structural repair: only when we got a string but want a structured value.
  if (typeof raw === "string" && opts.unwrapText && wantsStructured(spec)) {
    const unwrapped = unwrapText(raw, [], changes);
    if (unwrapped.handled) input = unwrapped.value;
  }

  const value = walk(input, spec, [], ctx, 0) as T;
  return { value, ok: isValid(value, spec), changes };
}

export { isPlainObject };

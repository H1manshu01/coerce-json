/**
 * Benchmark corpus: real, realistic mistakes that language models make when
 * asked to emit JSON for a schema. Each case pairs a `raw` model output (often
 * a string, exactly as it would arrive off the wire) with the Zod `schema` it
 * was supposed to satisfy.
 *
 * The harness (bench/index.ts) feeds every `raw` to PLAIN Zod first (the
 * baseline — can the output validate as-is?) and then to `coerce(...)`, with
 * fuzzy off and fuzzy on, to measure how many become schema-valid after repair.
 *
 * These are hand-built to be representative of the failure modes seen in LLM
 * structured output; they are an illustrative suite, not a scientific sample.
 */
import { z } from "zod";
import type { CoerceOptions } from "../src/core.js";

export interface Case {
  /** Short label for the table. */
  name: string;
  /** The raw model output, as it would arrive (usually an undecoded string). */
  raw: unknown;
  /** The Zod schema the output was meant to satisfy. */
  schema: z.ZodTypeAny;
  /** Optional per-case coerce options. */
  options?: CoerceOptions;
}

// A few schemas reused across several cases.
const User = z.object({ id: z.number(), active: z.boolean() });
const Priority = z.enum(["low", "medium", "high", "urgent"]);
const ToolCall = z.object({
  name: z.string(),
  arguments: z.object({ query: z.string(), maxPrice: z.number(), inStock: z.boolean() }),
});

export const corpus: Case[] = [
  // ── stringified numbers ───────────────────────────────────────────────
  {
    name: "stringified number",
    raw: '{"id":"42","active":true}',
    schema: User,
  },
  {
    name: "number as string, decimal",
    raw: '{"temperature":"0.7","maxTokens":"2048"}',
    schema: z.object({ temperature: z.number(), maxTokens: z.number().int() }),
  },
  {
    name: "numbers as strings in array",
    raw: '{"scores":["1","2","3","4","5"]}',
    schema: z.object({ scores: z.array(z.number()) }),
  },
  {
    name: "integer with thousands/commas intent",
    raw: '{"count":"1000","ratio":"-3.14"}',
    schema: z.object({ count: z.number().int(), ratio: z.number() }),
  },

  // ── stringified booleans, many spellings ──────────────────────────────
  {
    name: "boolean 'true'/'false' strings",
    raw: '{"id":1,"active":"false"}',
    schema: User,
  },
  {
    name: "boolean 'yes'/'no'",
    raw: '{"subscribed":"yes","verified":"no"}',
    schema: z.object({ subscribed: z.boolean(), verified: z.boolean() }),
  },
  {
    name: "boolean 'on'/'off'",
    raw: '{"notifications":"on","darkMode":"off"}',
    schema: z.object({ notifications: z.boolean(), darkMode: z.boolean() }),
  },
  {
    name: "boolean '1'/'0'",
    raw: '{"flagA":"1","flagB":"0"}',
    schema: z.object({ flagA: z.boolean(), flagB: z.boolean() }),
  },

  // ── markdown-fenced JSON ──────────────────────────────────────────────
  {
    name: "markdown ```json fence",
    raw: '```json\n{"id":"7","active":"true"}\n```',
    schema: User,
  },
  {
    name: "bare ``` fence, no language",
    raw: '```\n{"status":"ok","code":"200"}\n```',
    schema: z.object({ status: z.string(), code: z.number() }),
  },
  {
    name: "fence around already-valid JSON",
    raw: '```json\n{"id":5,"active":false}\n```',
    schema: User,
  },

  // ── JSON embedded in prose ────────────────────────────────────────────
  {
    name: "JSON embedded in prose",
    raw: 'Sure! Here is the object you asked for:\n\n{"id":"99","active":"yes"}\n\nLet me know if you need anything else.',
    schema: User,
  },
  {
    name: "prose + fenced JSON together",
    raw: 'Of course. The result is:\n```json\n{"temperature":"0.2","maxTokens":"512"}\n```\nHope that helps!',
    schema: z.object({ temperature: z.number(), maxTokens: z.number().int() }),
  },
  {
    name: "leading apology then JSON",
    raw: 'I apologize for the confusion. Here\'s the corrected output: {"name":"search","arguments":{"query":"shoes","maxPrice":"50","inStock":"true"}}',
    schema: ToolCall,
  },

  // ── enum typos / near-misses (need fuzzy) ─────────────────────────────
  {
    name: "enum near-miss typo",
    raw: '{"priority":"hihg"}',
    schema: z.object({ priority: Priority }),
    options: { fuzzy: true },
  },
  {
    name: "enum near-miss (one edit)",
    raw: '{"priority":"medum"}',
    schema: z.object({ priority: Priority }),
    options: { fuzzy: true },
  },

  // ── enum wrong-casing (handled even without fuzzy) ────────────────────
  {
    name: "enum UPPERCASE",
    raw: '{"priority":"HIGH"}',
    schema: z.object({ priority: Priority }),
  },
  {
    name: "enum Mixed-Case",
    raw: '{"priority":"Urgent"}',
    schema: z.object({ priority: Priority }),
  },
  {
    name: "enum padded + cased",
    raw: '{"priority":"  Low  "}',
    schema: z.object({ priority: Priority }),
  },

  // ── snake_case vs camelCase keys (need fuzzy for re-casing) ───────────
  {
    name: "snake_case keys → camelCase",
    raw: '{"max_price":199.99,"in_stock":true}',
    schema: z.object({ maxPrice: z.number(), inStock: z.boolean() }),
    options: { fuzzy: true },
  },
  {
    name: "snake_case nested tool args",
    raw: '{"name":"search_products","arguments":{"query":"headphones","max_price":"199.99","in_stock":"yes"}}',
    schema: ToolCall,
    options: { fuzzy: true },
  },

  // ── missing fields with defaults ──────────────────────────────────────
  {
    name: "missing field with default",
    raw: '{"query":"laptops"}',
    schema: z.object({ query: z.string(), limit: z.number().default(10) }),
  },
  {
    name: "missing nested defaults",
    raw: '{"model":"gpt-4"}',
    schema: z.object({
      model: z.string(),
      temperature: z.number().default(1),
      stream: z.boolean().default(false),
    }),
  },

  // ── nested objects / arrays ───────────────────────────────────────────
  {
    name: "nested object, mixed coercions",
    raw: '{"name":"search","arguments":{"query":"tv","maxPrice":"899","inStock":"1"}}',
    schema: ToolCall,
  },
  {
    name: "array of records, stringified fields",
    raw: '{"items":[{"id":"1","done":"true"},{"id":"2","done":"false"}],"total":"2"}',
    schema: z.object({
      items: z.array(z.object({ id: z.number(), done: z.boolean() })),
      total: z.number().int(),
    }),
  },
  {
    name: "deeply nested coercion",
    raw: '{"a":{"b":{"c":{"value":"3.5","ok":"yes"}}}}',
    schema: z.object({
      a: z.object({ b: z.object({ c: z.object({ value: z.number(), ok: z.boolean() }) }) }),
    }),
  },

  // ── extra junk keys ───────────────────────────────────────────────────
  {
    name: "extra junk keys (stripped)",
    raw: '{"id":"3","active":"true","_comment":"here you go","debug":{"tokens":17}}',
    schema: User,
  },
  {
    name: "chatty extra keys + fence",
    raw: '```json\n{"status":"ok","code":"201","note":"created successfully","latency_ms":42}\n```',
    schema: z.object({ status: z.string(), code: z.number() }),
  },

  // ── __proto__ injection (dropped) ─────────────────────────────────────
  {
    name: "__proto__ injection",
    raw: '{"id":"8","active":"true","__proto__":{"admin":true}}',
    schema: User,
  },
  {
    name: "constructor key injection",
    raw: '{"status":"ok","code":"200","constructor":{"polluted":1}}',
    schema: z.object({ status: z.string(), code: z.number() }),
  },

  // ── null / empty handling ─────────────────────────────────────────────
  {
    name: "empty string → null (nullable)",
    raw: '{"note":"","id":"1","active":"true"}',
    schema: z.object({ note: z.string().nullable(), id: z.number(), active: z.boolean() }),
  },
  {
    name: "string 'null' → null",
    raw: '{"result":"null","id":"1","active":"no"}',
    schema: z.object({ result: z.string().nullable(), id: z.number(), active: z.boolean() }),
  },

  // ── to-string (number/boolean where string expected) ──────────────────
  {
    name: "number where string expected",
    raw: '{"zip":94107,"code":200}',
    schema: z.object({ zip: z.string(), code: z.string() }),
  },

  // ── big combined / realistic envelope ─────────────────────────────────
  {
    name: "kitchen-sink envelope (fuzzy)",
    raw: 'Here\'s your structured result:\n```json\n{\n  "user_id": "1024",\n  "is_active": "yes",\n  "priority": "Hihg",\n  "tags": ["a","b"],\n  "__proto__": {"x": 1},\n  "extra_note": "ignore me"\n}\n```',
    schema: z.object({
      userId: z.number().int(),
      isActive: z.boolean(),
      priority: Priority,
      tags: z.array(z.string()),
    }),
    options: { fuzzy: true },
  },

  // ── already-valid payloads (idempotency / no-op) ──────────────────────
  {
    name: "already-valid object (no-op)",
    raw: '{"id":1,"active":true}',
    schema: User,
  },
  {
    name: "already-valid nested (no-op)",
    raw: '{"name":"search","arguments":{"query":"tv","maxPrice":899,"inStock":true}}',
    schema: ToolCall,
  },
  {
    name: "already-valid array (no-op)",
    raw: '{"scores":[1,2,3],"total":3}',
    schema: z.object({ scores: z.array(z.number()), total: z.number().int() }),
  },
];

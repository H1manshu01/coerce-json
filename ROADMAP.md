# Roadmap

`coerce-json` ships `M0–M5` as **v0.1** — the core engine, both adapters, the
structural repair heuristics, tests, and docs are all in place. It is the
second package in a streaming structured-output suite; the first is
[`trickle-json`](https://github.com/H1manshu01/trickle-json).

## M0 — Validate & name ✅
- [x] Competitor scan: `z.coerce`, `jsonrepair`, `json-repair`,
      `best-effort-json-parser`, `instructor-js`, provider structured outputs
      (see [COMPETITORS.md](./COMPETITORS.md))
- [x] Confirmed the gap: schema-aware coercion **+** a reported change log **+**
      opt-in fuzzy, in one zero-dependency library
- [x] Named and scoped as the "repair/coerce to schema" step of the pipeline

## M1 — Core coercion engine ✅
- [x] Schema-agnostic `Spec` model and a recursive `walk` coercer (`src/core.ts`)
- [x] Primitive coercion: string↔number, string↔boolean (many spellings),
      to-string, trim, null / empty-string / `"null"` / `"none"` handling
- [x] Structural kinds: object, array, record, union (picks the coercible branch
      with the fewest changes), optional, nullable, default, literal, enum
- [x] `CoerceResult` with an ordered `changes` log; dependency-free `isValid`
- [x] Guardrails: never fabricate beyond defaults, every mutation logged,
      idempotent fixpoint, prototype-pollution safe

## M2 — Zod adapter + JSON-Schema / Ajv ✅
- [x] `coerce-json/zod`: `zodToSpec` reads a schema's public structure (Zod v3
      `_def`) **without importing `zod`**; `ok` from the schema's own `safeParse`
- [x] Typed `coerce` via `z.infer` (value typed as the schema's output)
- [x] `coerce-json/json-schema`: `jsonSchemaToSpec` (type/enum/const/properties/
      required/additionalProperties/items/anyOf/oneOf/default/nullable)
- [x] `coerceWithAjv` for authoritative draft-07 `ok` via an injected Ajv
      instance (Ajv optional peer, never imported by the core)
- [x] Root `coerce` auto-detects Zod schema vs. JSON Schema vs. core `Spec`

## M3 — Structural repair heuristics ✅
- [x] Strip a surrounding markdown code fence (```` ```lang ```` or inline `` ` ``)
- [x] Extract the first balanced JSON object/array embedded in prose
      (string- and escape-aware)
- [x] Parse a raw JSON string into a structured value
- [x] Fill documented schema defaults for missing fields
- [x] Opt-in fuzzy: enum near-miss (Levenshtein, refuses ambiguous ties) and
      object key re-casing (snake_case ↔ camelCase); case-insensitive exact enum
      match always on
- [x] Repair only runs when the input is a string and the schema wants a
      structured value — never mangles a value that was meant to be a string

## M4 — Tests & benchmark ✅
- [x] Unit tests for primitives, defaults, unknown keys, enums, unions, fuzzy,
      prototype guard (`test/core.test.ts`)
- [x] Zod + JSON-Schema adapter tests, incl. Ajv authoritative validation
- [x] Property tests (fast-check): idempotency, fixpoint, "never invents data
      beyond defaults", "changes empty iff output == input" (`test/properties.test.ts`)
- [x] Benchmark harness comparing coercion correctness vs. incumbents
      (see [BENCHMARKS.md](./BENCHMARKS.md))

## M5 — Docs / CI / release ✅
- [x] README with quick start, comparison table, full API, options, the complete
      `ChangeType` list, guardrails, and a worked `trickle-json → coerce-json`
      pipeline example
- [x] `COMPETITORS.md`, `CHANGELOG.md`, launch post draft
- [x] ESM + CJS + `.d.ts` build (tsup); `size-limit` gate on the core
- [ ] npm publish with `--provenance` — needs an `NPM_TOKEN` secret and a
      `v0.1.0` tag (owner action)

## Post-1.0 ideas
- **More adapters.** Valibot and ArkType adapters — same structural approach,
  each reusing the core `Spec` and the schema's own validator.
- **Streaming / partial coercion.** Coerce `trickle-json` snapshots *as they
  stream* (coerce the partial value on each chunk, reconcile the change log),
  so a progressive UI shows typed, schema-fitted values before the stream ends.
- **Locale-aware number parsing.** Thousands separators and comma decimals
  (`"1.234,56"`, `"1,234.56"`) behind an opt-in flag.
- **Date / timestamp coercion.** Opt-in ISO-8601 and epoch handling for
  `z.date()` and `format: "date-time"` fields.
- **Richer union disambiguation.** Discriminated-union fast path keyed on the
  discriminant literal.

## Known trade-offs (document, don't hide)
- `zodToSpec` reads Zod **v3** `_def` structurally. Unrecognized schema kinds
  fall back to `{ kind: "unknown" }` (coerced leniently); the authoritative `ok`
  still comes from the schema's own `safeParse`, so correctness is never at risk.
- The built-in JSON-Schema validator is a light structural checker. For full
  draft-07 semantics (formats, numeric bounds, `patternProperties`, …) use
  `coerceWithAjv`.
- Fuzzy fixes are lossy by nature and therefore opt-in; an ambiguous enum
  near-miss is deliberately left unchanged rather than guessed.

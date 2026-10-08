# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/) and the project adheres to
[Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-10-08

Initial public release — repair & coerce almost-valid LLM JSON to fit a schema,
with every fix logged.

### Added
- **Core engine** (`coerce-json`, zero runtime dependencies):
  - `coerce(raw, schema, options?)` — auto-detects a Zod schema, a JSON Schema
    object, or a core `Spec`, and returns `{ value, ok, changes }`.
  - `coerceToSpec(raw, spec, options?)` — coerce directly against a normalized
    core `Spec`.
  - `isValid(value, spec)` — dependency-free structural validator.
  - Exported helpers `jsonSchemaToSpec`, `zodToSpec`, `isZodSchema`, and the
    types `Spec`, `Change`, `ChangeType`, `CoerceOptions`, `CoerceResult`,
    `Json`, `JsonSchema`, `ZodLike`.
- **Type coercion:** string↔number, string↔boolean (`true/false/yes/no/on/off/
  y/n/1/0`, case-insensitive), number/boolean→string, trim, and null handling
  for empty strings and `"null"` / `"nil"` / `"none"`.
- **Structural repair** (string input → structured value): strip a surrounding
  markdown code fence, extract the first balanced JSON object/array embedded in
  prose, parse a raw JSON string, and fill documented schema defaults.
- **Opt-in fuzzy fixes** (`fuzzy: true`, off by default): enum near-miss
  matching (Levenshtein, refuses ambiguous ties) and object key re-casing
  (snake_case ↔ camelCase). Case-insensitive exact enum matching is always on.
- **`coerce-json/zod`** — Zod adapter. Fully typed via `z.infer`; reads a
  schema's public structure (Zod v3 `_def`) **without importing `zod`** and
  uses the schema's own `safeParse` for the authoritative `ok`. Exports
  `zodToSpec`, `isZodSchema`, `ZodLike`. `zod` is an optional peer dependency.
- **`coerce-json/json-schema`** — JSON Schema adapter: `coerce` (`ok` via the
  built-in validator) and `coerceWithAjv` (`ok` via an injected Ajv instance).
  Exports `jsonSchemaToSpec`, `JsonSchema`, `AjvLike`. `ajv` is an optional peer
  dependency, never imported by the library.
- **Guardrails:** never fabricates data beyond documented defaults, logs every
  mutation in `changes`, is idempotent (coercing a valid value is a no-op and
  the output reaches a fixpoint), and is prototype-pollution safe
  (`__proto__` / `constructor` / `prototype` keys are dropped and logged).
- **Options:** `fuzzy`, `fuzzyEnumMaxDistance`, `fillDefaults`, `unwrapText`,
  `maxDepth`.

### Verified
- Property tests (fast-check): idempotency, re-coercion fixpoint, "never invents
  data beyond defaults", and "`changes` is empty iff the output equals the
  input".
- Unit tests across primitives, defaults, unknown-key handling, enums, unions,
  fuzzy matching, and the prototype-pollution guard, plus Zod and JSON-Schema
  (incl. Ajv) adapter tests.
- ESM + CJS builds with type declarations; zero-dependency core under the
  `size-limit` budget.

[0.1.0]: https://github.com/H1manshu01/coerce-json/releases/tag/v0.1.0

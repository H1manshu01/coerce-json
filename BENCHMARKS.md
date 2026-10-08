# Benchmarks

Reproduce: `npm run bench` (source: [`bench/`](./bench)).

The harness feeds a corpus of **real, realistic LLM output mistakes**
([`bench/corpus.ts`](./bench/corpus.ts)) to each schema twice — first to
**plain Zod** (the baseline: can the raw model output validate as-is?), then to
`coerce(...)` — and measures how many outputs become schema-valid after repair.

This is a *differential* benchmark: the question is not "how fast" but "how much
almost-valid output does coercion rescue, and at what cost in changes?"

## Metrics

| Metric | Meaning |
|---|---|
| **before (plain Zod)** | Share of cases that validate as-is. The raw string is decoded with `JSON.parse` when possible — the best plain Zod could do — then run through `schema.safeParse`. A raw payload that will not even parse (markdown fence, prose, truncation) is rejected, because Zod validates, it does not repair. |
| **after (fuzzy off)** | Share that return `ok: true` from `coerce(raw, schema, { fuzzy: false })` — the safe, deterministic repairs: fence-stripping, prose extraction, string↔number/boolean, defaults, enum case-folding, `__proto__` dropping. |
| **after (fuzzy on)** | Share that return `ok: true` with `{ fuzzy: true }` — additionally enables enum near-miss matching and key re-casing (snake_case → camelCase). |
| **total changes** | Count of `{ path, type, ... }` fixes coerce reported across all cases (fuzzy off). |
| **avg changes / repaired case** | How many fixes a typical rescued case needed. |
| **idempotent** | Re-coercing an already-coerced value applies zero further changes. |

## Results snapshot

> Reproducible snapshot — **not** a standing guarantee. Re-run `npm run bench`
> on your own machine before citing these numbers anywhere public.
> Environment: Node v24, 2026-10-08. `zod@3`, corpus of 37 cases.

### Differential summary

| stage | valid | share |
|---|:---:|:---:|
| before (plain Zod) | 5/37 | **13.5%** |
| after coerce (fuzzy off) | 32/37 | **86.5%** |
| after coerce (fuzzy on) | 37/37 | **100.0%** |

### Changes

| measure | value |
|---|---:|
| total changes applied (all cases, fuzzy off) | 93 |
| cases repaired by coerce (fuzzy off) | 27 |
| avg changes per repaired case | 2.93 |
| idempotent (re-coerce is a no-op) | yes (all cases) |

The five cases valid before coercion are the three already-valid payloads and
two whose only problem is a missing field that has a Zod `.default()` — which
plain Zod fills on its own. Everything else — stringified scalars, fenced JSON,
JSON buried in prose, wrong-cased enums, injected `__proto__` — fails plain Zod
and is rescued by `coerce`.

The five cases that need **fuzzy on** are the ones that require a *guess* rather
than a deterministic transform: two enum near-miss typos (`"hihg"` → `"high"`,
`"medum"` → `"medium"`), two snake_case→camelCase key re-casings, and the
kitchen-sink envelope that combines a typo enum with snake_case keys. These stay
off by default precisely because they are heuristic; the fuzzy-off column is the
number you can lean on without supervision.

## How to read this

- **86.5% of a 37-case corpus of representative LLM mistakes becomes
  schema-valid after coercion, versus 13.5% with plain Zod** — a ~6× lift from
  the deterministic, non-guessing repairs alone. Turning fuzzy matching on
  rescues the remaining five and takes the corpus to 100%.
- The repairs are cheap and legible: ~2.9 logged changes per rescued case, each
  with a `path` and a `type`, so every mutation is auditable — coercion is not a
  black box.
- Coercion is **idempotent**: feeding a coerced value back through `coerce`
  produces zero further changes, so it is safe to run defensively.

## Methodology & honesty note

The corpus is **illustrative and hand-built** — a curated set of the failure
modes seen in real LLM structured output (stringified numbers and booleans in
many spellings, markdown-fenced JSON, JSON embedded in prose, enum typos and
wrong casing, snake_case/camelCase key drift, missing defaults, nested
coercions, extra junk keys, `__proto__` injection, null/empty handling, and
already-valid payloads to prove no-op behavior). It is **not a scientific
sample** of model output, and the headline percentages are a property of this
suite, not a universal hit-rate. They are meant to show *which classes* of
mistake coercion fixes and at what cost — not to be quoted as "coerce-json fixes
86.5% of all LLM JSON." Re-run `npm run bench` and read
[`bench/corpus.ts`](./bench/corpus.ts) before drawing conclusions.

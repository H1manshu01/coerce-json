# Competitor scan (M0)

Why `coerce-json` exists: taking almost-valid LLM JSON and making it fit a
schema is solved today only in slices. One tool casts primitives, another fixes
syntax, another re-prompts the model. None of them combine **schema-aware
coercion**, a **reported change log**, and **opt-in fuzzy repair** in a single
zero-dependency library — which is exactly the gap `coerce-json` fills.

Where a specific detail of a third-party library could have changed, claims are
dated "as of early 2026" and kept general rather than invented. Re-check current
behavior against each project before quoting it.

---

## Zod `.coerce`

**What it does.** Zod's built-in coercion primitives (`z.coerce.number()`,
`z.coerce.boolean()`, etc.) wrap the value in the corresponding JS constructor
(`Number(x)`, `Boolean(x)`, …) before validating. You opt in per field.

**What it misses.**
- **Not structural.** It operates on an already-parsed value. It cannot strip a
  markdown fence, pull a JSON object out of surrounding prose, or parse a JSON
  string — the input has to already be the right shape.
- **Blunt primitive rules.** `Boolean("false")` is `true`, and
  `Boolean("")` is `false` — `z.coerce.boolean()` follows JS truthiness, not the
  `yes/no/on/off` spellings a model actually emits. `coerce-json` matches those
  spellings and refuses to cast a non-numeric string to a number.
- **No change log.** Coercion is silent — you can't tell what was rewritten, so
  you can't audit or warn on it.
- **Opt-in per field, by hand.** You annotate every field you want coerced.
  `coerce-json` reads the schema you already have and coerces structurally.

`coerce-json/zod` is complementary: it reads your plain (non-`.coerce`) schema,
repairs the value, then hands it to the schema's own `safeParse`.

## `jsonrepair`

**What it does.** Repairs malformed JSON *text* — closes open braces/brackets,
adds missing quotes, fixes trailing commas, converts single quotes — and returns
a valid JSON string (or parsed value). Widely used, actively maintained as of
early 2026.

**What it misses.**
- **Schema-blind.** It fixes syntax, not types. Given `{"id":"42"}` it returns
  `{"id":"42"}` because that is already valid JSON — the string-vs-number
  mismatch against your schema is invisible to it.
- **No defaults, enums, or key normalization.** It has no schema, so it can't
  fill a documented default, snap an enum to a known value, or re-case a key.
- **No change log keyed to your data.** It repairs text; it doesn't report "cast
  `id` from string to number" at a path.

`jsonrepair` and `coerce-json` sit at different layers: repair the *syntax* with
one, coerce to the *schema* with the other. (`coerce-json` also handles the
common fence/prose wrapping itself.)

## `json-repair` (and the Python-origin family)

**What it does.** The same idea as `jsonrepair` — tolerant parsing of broken
JSON, popular in LLM-output pipelines (the name is shared by packages across
Python and JS, as of early 2026). Returns a best-effort parsed value.

**What it misses.** The same axis as `jsonrepair`: it is a **syntax** repairer
with **no schema awareness**, **no type coercion toward a target**, **no
documented-default filling**, and **no reported change log**. It answers "is
this parseable?", not "does this match my schema, and what did you change to get
there?".

## `best-effort-json-parser`

**What it does.** Parses incomplete or slightly malformed JSON and returns
whatever value it can recover — aimed at partial/streaming output. (It is also
one of the parsers benchmarked by the sibling package `trickle-json`.)

**What it misses.**
- **A parser, not a coercer.** Its job ends at "produce a value". It does no
  schema-directed type coercion, default filling, enum snapping, or key
  re-casing.
- **No schema, no change log.** Nothing ties its output to your Zod / JSON
  Schema, and it doesn't report the fixes it made.

It is a reasonable *input* to `coerce-json`: recover a value, then coerce it to
the schema. For streaming specifically, `trickle-json` is the parser this suite
pairs with.

## `instructor-js`

**What it does.** Wraps an LLM call to return schema-validated structured output:
you give it a Zod (or JSON) schema, it adds the schema to the prompt, validates
the response, and on a validation failure **re-prompts the model** with the
error so it can try again (retry/"reask" loop). As of early 2026 it is a
well-established pattern on top of the provider SDKs.

**What it misses.**
- **Fixes by network round trip, not locally.** A `"42"` that a one-line cast
  would fix becomes another model call — slower, costs tokens, and is
  non-deterministic. `coerce-json` repairs deterministically, offline, in
  microseconds.
- **Coupled to the call.** It owns the request/response loop. `coerce-json` is a
  pure function over a value, so it drops into any pipeline — streaming, batch,
  replayed logs, a value you already have on disk.
- **No itemized change log.** You get a validated object or a retry; you don't
  get an ordered record of every fix applied to the raw output.

The two compose well: let `coerce-json` absorb the mechanical mismatches so the
expensive re-prompt is reserved for genuinely wrong content.

## TanStack AI / provider structured outputs (brief)

**What they do.** Modern AI client libraries (e.g. the TanStack AI effort, as of
early 2026) and first-party **structured outputs** (OpenAI JSON-schema / strict
mode, Anthropic tool-use schemas) constrain generation to a schema at the
source, so the model is far more likely to return a value that already fits.

**What they miss — and why the niche survives.** Constrained decoding reduces
the need for post-hoc repair, but doesn't eliminate it:
- **Not universal.** Local and open-weight models, older or self-hosted
  endpoints, and many providers don't offer strict schema enforcement.
- **Streaming partials.** A value assembled from a token stream is only valid at
  the end; intermediate snapshots still need coercing.
- **Prose / fence wrapping.** Plenty of flows still ask for JSON in a normal
  completion and get it wrapped in a ```` ```json ```` fence or a sentence.
- **Type drift at the edges.** Even strict modes leave gaps — a date as a
  string, an enum emitted with different casing, a number rendered as a string.

`coerce-json`'s niche is precisely those cases: the output you *didn't* get from
a strict-schema endpoint, or got only as a stream or wrapped in text. When the
provider already returns a clean value, `coerce-json` is a near no-op (idempotent
by design) — so it's safe to leave in the pipeline either way.

---

## The gap, in one line

| Capability | coerce-json | `z.coerce` | `jsonrepair` / `json-repair` | `best-effort-json-parser` | `instructor-js` | provider strict outputs |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| Schema-aware type coercion | ✅ | ⚠️ manual | — | — | ✅ (via re-prompt) | ✅ (at source) |
| Structural repair (fence / prose / parse) | ✅ | — | ⚠️ syntax only | ⚠️ parse only | — | — |
| Fills documented defaults | ✅ | ✅ | — | — | ✅ | ⚠️ depends |
| Fuzzy enum / key re-casing | ✅ opt-in | — | — | — | — | — |
| Reported change log | ✅ | — | — | — | — | — |
| Fixes offline (no model call) | ✅ | ✅ | ✅ | ✅ | — | n/a |
| Zero-dependency core | ✅ | — | ✅ | ✅ | — | n/a |

`coerce-json` is the only row that is schema-aware, reports every fix, keeps
fuzzy guesses opt-in, and does it all offline in a zero-dependency core.

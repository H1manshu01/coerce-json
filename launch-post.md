---
title: "Your LLM returned almost-valid JSON. Stop hand-patching it."
published: false
description: "Models hand back JSON that's structurally close but type-wrong — numbers as strings, booleans as \"yes\", wrapped in a code fence. Here's coerce-json: a zero-dependency library that repairs it to fit your Zod (or JSON Schema) schema and logs every single fix."
tags: javascript, typescript, ai, opensource
cover_image: https://raw.githubusercontent.com/H1manshu01/coerce-json/main/assets/cover.png
series: "Streaming structured output"
canonical_url: https://dev.to/h1manshu01/your-llm-returned-almost-valid-json-stop-hand-patching-it
---

You asked the model for `{ id: number, active: boolean }`. Here's what came
back:

````text
```json
{"id": "42", "active": "true", "role": "admin"}
```
````

Every field is *almost* right. `id` is a string. `active` is a string. There's
a `role` you never asked for. And the whole thing is wrapped in a markdown code
fence. So this:

```ts
const user = User.parse(JSON.parse(raw)); // 💥
```

throws twice — once on the fence, and again on the types. So you start writing
the patches by hand:

```ts
const unfenced = raw.replace(/```json\n?|\n?```/g, "");
const obj = JSON.parse(unfenced);
obj.id = Number(obj.id);
obj.active = obj.active === "true"; // and "yes"? and "on"? and "1"?
// ...and now do it again for the next schema
```

This is the part of every LLM integration nobody writes a blog post about. Let's
fix it properly.

## The usual fixes (and where they hurt)

**1. `z.coerce`.** Zod can coerce primitives — `z.coerce.number()`,
`z.coerce.boolean()`. But you opt in field by field, it can't touch the fence or
the prose, and `z.coerce.boolean()` just calls `Boolean(x)` — so `"false"`
becomes `true`. Worse: when it does coerce, it does it **silently**. You can't
log what changed.

**2. `jsonrepair` / `json-repair`.** Great at fixing broken *syntax* — unclosed
braces, missing quotes, trailing commas. But they're **schema-blind**. Feed one
`{"id":"42"}` and it returns `{"id":"42"}`, because that's already valid JSON.
The string-vs-number mismatch is exactly the problem, and it can't see it.

**3. `instructor-js` and re-prompting.** Validate, and on failure send the error
back to the model to try again. It works — but you've turned a `"42"` → `42`
cast, which is a few microseconds of local work, into another network round
trip, more tokens, and a non-deterministic retry.

The common thread: each tool owns one slice. Cast primitives, *or* fix syntax,
*or* re-prompt. None of them read the schema you already have, coerce the value
to fit it, and **tell you what they changed**.

## coerce-json

[`coerce-json`](https://www.npmjs.com/package/coerce-json) is a
zero-dependency library that takes almost-valid model output and makes it fit
your schema — reporting every fix:

```ts
import { coerce } from "coerce-json";
import { z } from "zod";

const User = z.object({ id: z.number(), active: z.boolean(), role: z.string().default("user") });

const { value, ok, changes } = coerce('```json\n{"id":"42","active":"true"}\n```', User);
// value   → { id: 42, active: true, role: "user" }
// ok      → true
// changes → strip-fence, string->number @ id, string->boolean @ active, fill-default @ role
```

Three things make that line pull its weight:

- **It's schema-aware.** It reads your Zod schema (or a JSON Schema, or its own
  core spec) and coerces *toward it* — the fence comes off, `"42"` becomes a
  number because `id` wants a number, the missing `role` gets its documented
  default.
- **It reports every fix.** `changes` is an ordered, auditable log. A coercion
  is never a silent black box — you can log it, warn on it, or gate on it.
- **It never fabricates.** The only values it adds are **documented schema
  defaults**, and each one is logged. A missing optional field is left absent,
  not guessed.

How much does that actually buy you? I built a corpus of 37 representative LLM
mistakes — numbers as strings, `"yes"` booleans, fenced and prose-wrapped
objects, enum casing, missing defaults. Under plain Zod, **13.5%** of them
validate. Run them through `coerce` with defaults, and **86.5%** validate. Flip
on `fuzzy: true` and it's **100%**. (It's a hand-built, illustrative corpus, not
a scientific sample — the harness and the full breakdown are in
[BENCHMARKS.md](https://github.com/H1manshu01/coerce-json/blob/main/BENCHMARKS.md),
so re-run it before quoting the numbers.)

### It handles what models actually emit

```ts
// prose-wrapped output
coerce('Sure! Here it is: {"a":"1"}', z.object({ a: z.number() }));
// → { a: 1 }   (extract-json, then string->number)

// booleans the way models spell them
coerce('{"active":"yes"}', z.object({ active: z.boolean() })); // → { active: true }

// enum casing, always safe
coerce('{"status":"ACTIVE"}', z.object({ status: z.enum(["active","inactive"]) }));
// → { status: "active" }   (case-insensitive, on by default)
```

Lossier guesses — enum *near-misses* (`"activ"` → `"active"`) and key re-casing
(`first_name` → `firstName`) — are **opt-in** behind `{ fuzzy: true }`, because
they can change meaning. And an ambiguous fuzzy match is refused, not guessed.

### JSON Schema, too

Not a Zod shop? Same API, with an optional Ajv hook for authoritative
validation:

```ts
import { coerce, coerceWithAjv } from "coerce-json/json-schema";

coerce('{"id":"5","active":"yes"}', {
  type: "object",
  properties: { id: { type: "integer" }, active: { type: "boolean" }, role: { type: "string", default: "user" } },
  required: ["id", "active"],
  additionalProperties: false,
});
// → { id: 5, active: true, role: "user" }, ok: true
```

## The part I care about: trust

If a library silently rewrites your data, you can't trust it in a pipeline. So
`coerce-json` holds four invariants, checked by property tests:

- **Never fabricates** beyond documented defaults.
- **Every mutation is logged** — `changes` is empty *if and only if* the output
  equals the input.
- **Idempotent** — coercing an already-valid value is a no-op, and re-coercing
  any output changes nothing (it reaches a fixpoint).
- **Prototype-pollution safe** — `__proto__` / `constructor` / `prototype` keys
  are dropped and logged.

## It's the second half of a pipeline

This is a companion to [`trickle-json`](https://www.npmjs.com/package/trickle-json),
my incremental partial-JSON parser for LLM streams. Together they're the
backbone of a streaming structured-output flow:

```
fetch → SSE → parse partial JSON (trickle-json) → repair/coerce to schema (coerce-json) → validate
```

`trickle-json` gives you the best value available on every streamed chunk
without throwing; `coerce-json` makes that value fit your schema and hands you
the receipts:

```ts
import { StreamingJsonParser } from "trickle-json";
import { coerce } from "coerce-json/zod";

const parser = new StreamingJsonParser();
parser.on("snapshot", renderPreview);
for await (const chunk of res.body) parser.write(chunk);

const { value, ok, changes } = coerce(parser.end(), Answer);
if (ok) save(value);
else console.warn("could not fully repair:", changes);
```

"But provider structured outputs already fix this!" — they help, a lot. But they
don't cover local and open models, older endpoints, streamed partials, or
anything wrapped in prose or a fence. That's exactly `coerce-json`'s niche — and
when the output *is* already clean, it's a near no-op, so it's safe to leave in.

## Try it

```sh
npm install coerce-json
```

- **npm:** https://www.npmjs.com/package/coerce-json
- **GitHub:** https://github.com/H1manshu01/coerce-json
- Zero runtime dependencies, ESM + CJS, full types, published with provenance.
  `zod` and `ajv` are optional peers — bring them only if you use them.

If it mangles some input it shouldn't, open an issue with the string and the
schema — the change log and the "never fabricate" guarantee are the whole point,
so I want to know. ⭐ appreciated if it saves you a pile of hand-written casts.

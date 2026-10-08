/**
 * Benchmark harness: how much almost-valid LLM output does `coerce` rescue?
 *
 * Run: `npm run bench`  (or `npx tsx bench/index.ts`)
 *
 * This is a DIFFERENTIAL benchmark on the hand-built corpus (bench/corpus.ts).
 * For every case we ask three questions:
 *
 *   BEFORE (plain Zod)   : does the raw model output validate as-is? We decode
 *                          the raw string with JSON.parse when we can (that is
 *                          the best case plain Zod could hope for) and run
 *                          `schema.safeParse`. A raw string that will not even
 *                          JSON.parse — a markdown fence, prose, truncation — is
 *                          fed to safeParse directly, which rejects it. This is
 *                          the honest baseline: Zod validates, it does not repair.
 *
 *   AFTER (fuzzy off)    : `coerce(raw, schema, { fuzzy: false })` → ok?
 *   AFTER (fuzzy on)     : `coerce(raw, schema, { fuzzy: true })`  → ok?
 *
 * We also tally the total `changes` coerce reported and the average number of
 * fixes per repaired case, and we verify idempotency: coercing an
 * already-coerced value applies no further changes.
 *
 * NOTE: the corpus is an illustrative, hand-built suite of representative LLM
 * mistakes — not a scientific sample. Read the numbers as "on this suite",
 * and re-run before quoting them anywhere.
 */
import { coerce } from "../src/index.js";
import { type Case, corpus } from "./corpus.js";

/** The best shot plain Zod has: decode the raw if it is JSON, else pass through. */
function plainZodValid(c: Case): boolean {
  let candidate: unknown = c.raw;
  if (typeof c.raw === "string") {
    try {
      candidate = JSON.parse(c.raw);
    } catch {
      // Not parseable JSON (fence / prose / truncation) — plain Zod sees the raw string.
      candidate = c.raw;
    }
  }
  return c.schema.safeParse(candidate).success;
}

interface CaseRow {
  name: string;
  before: boolean;
  afterOff: boolean;
  afterOn: boolean;
  changesOff: number;
  idempotent: boolean;
}

function run(): CaseRow[] {
  return corpus.map((c) => {
    const before = plainZodValid(c);

    const off = coerce(c.raw, c.schema, { ...c.options, fuzzy: false });
    const on = coerce(c.raw, c.schema, { ...c.options, fuzzy: true });

    // Idempotency: re-coercing the coerced value applies no further changes.
    const useOn = on.ok && !off.ok;
    const first = useOn ? on : off;
    const second = coerce(first.value, c.schema, { ...c.options, fuzzy: useOn });
    const idempotent = second.changes.length === 0;

    return {
      name: c.name,
      before,
      afterOff: off.ok,
      afterOn: on.ok,
      changesOff: off.changes.length,
      idempotent,
    };
  });
}

function pct(n: number, d: number): string {
  if (d === 0) return "—";
  return `${((n / d) * 100).toFixed(1)}%`;
}

function pad(s: string, w: number): string {
  return s.length >= w ? s : s + " ".repeat(w - s.length);
}

function padLeft(s: string, w: number): string {
  return s.length >= w ? s : " ".repeat(w - s.length) + s;
}

function main(): void {
  const rows = run();
  const n = rows.length;

  const validBefore = rows.filter((r) => r.before).length;
  const validAfterOff = rows.filter((r) => r.afterOff).length;
  const validAfterOn = rows.filter((r) => r.afterOn).length;

  // Changes accounting (fuzzy-off repairs, the common path).
  const repairedOff = rows.filter((r) => !r.before && r.afterOff);
  const totalChanges = rows.reduce((s, r) => s + r.changesOff, 0);
  const changesOnRepaired = repairedOff.reduce((s, r) => s + r.changesOff, 0);
  const avgChanges = repairedOff.length ? changesOnRepaired / repairedOff.length : 0;
  const idempotentAll = rows.every((r) => r.idempotent);

  console.log(`\ncoerce-json differential benchmark — ${n} cases\n`);

  // Per-case table.
  const headers = ["case", "before", "after(off)", "after(on)", "fixes"];
  const widths = [34, 7, 11, 10, 6];
  console.log(headers.map((h, i) => pad(h, widths[i]!)).join("| "));
  console.log(widths.map((w) => "-".repeat(w)).join("+-"));
  const mark = (b: boolean) => (b ? "  ✓" : "  ·");
  for (const r of rows) {
    const row = [
      pad(r.name, widths[0]!),
      pad(mark(r.before), widths[1]!),
      pad(mark(r.afterOff), widths[2]!),
      pad(mark(r.afterOn), widths[3]!),
      padLeft(String(r.changesOff), widths[4]!),
    ];
    console.log(row.join("| "));
  }

  // Differential summary.
  console.log("\n=== DIFFERENTIAL SUMMARY ===\n");
  const sHeaders = ["stage", "valid", "share"];
  const sWidths = [28, 8, 8];
  console.log(sHeaders.map((h, i) => pad(h, sWidths[i]!)).join("| "));
  console.log(sWidths.map((w) => "-".repeat(w)).join("+-"));
  const srow = (label: string, valid: number) =>
    console.log(
      [
        pad(label, sWidths[0]!),
        padLeft(`${valid}/${n}`, sWidths[1]!),
        padLeft(pct(valid, n), sWidths[2]!),
      ].join("| "),
    );
  srow("before (plain Zod)", validBefore);
  srow("after coerce (fuzzy off)", validAfterOff);
  srow("after coerce (fuzzy on)", validAfterOn);

  console.log("\n=== CHANGES ===\n");
  console.log(`total changes applied (all cases, fuzzy off) : ${totalChanges}`);
  console.log(`cases repaired by coerce (fuzzy off)         : ${repairedOff.length}`);
  console.log(`avg changes per repaired case                : ${avgChanges.toFixed(2)}`);
  console.log(
    `idempotent (re-coerce is a no-op)            : ${idempotentAll ? "yes (all cases)" : "NO"}`,
  );

  const lift = validAfterOn - validBefore;
  console.log(
    `\nHeadline: ${pct(validBefore, n)} of the ${n}-case corpus validates under plain Zod; ` +
      `${pct(validAfterOff, n)} after coerce (fuzzy off), ${pct(validAfterOn, n)} with fuzzy on ` +
      `(+${lift} cases rescued).`,
  );
  console.log(
    "\nMethodology: illustrative hand-built corpus of representative LLM mistakes, not a " +
      "scientific sample. See the header in bench/index.ts. Re-run before quoting.\n",
  );
}

main();

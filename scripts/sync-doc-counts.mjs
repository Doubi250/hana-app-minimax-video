#!/usr/bin/env node
/**
 * scripts/sync-doc-counts.mjs — keep the documented test count honest.
 *
 * WHY THIS EXISTS
 *   The docs quote the size of the offline suite (`AGENTS.md`, `README.md`,
 *   `docs/test-and-tools.md`, `docs/test-report.md`, the top `CHANGELOG.md`
 *   entry). Hand-editing that number drifted three times (281 → 313 → 339),
 *   leaving "313" next to "339" inside one changelog entry. The count is now
 *   machine-owned: prose carries a marker pair and this script is the only
 *   writer of the digits between them.
 *
 * THE MARKER (grep-locatable)
 *   <!-- test-count -->N<!-- /test-count -->   (N = the live suite total)
 *   The number stays visible in rendered Markdown; the surrounding comments are
 *   invisible. `git grep -n 'test-count'` finds every guarded statement.
 *
 * WHAT IT DOES
 *   Collects the real total by running the suite with `node --test`, then
 *     node scripts/sync-doc-counts.mjs            rewrite every marker in place
 *     node scripts/sync-doc-counts.mjs --check    verify only; drift → exit 1
 *
 * NODE-VERSION TOLERANCE
 *   No Node release ships a built-in `json` test reporter — `node:test/reporters`
 *   exposes only `dot/junit/lcov/spec/tap`, so `--test-reporter=json` fails on
 *   the whole CI matrix (20/22) as well as locally. The script probes the
 *   module anyway (a future release or a custom reporter could add it), then
 *   falls back to `tap` (`# tests N`) and finally `spec`, so every runtime
 *   resolves the same number from whichever reporter it actually has.
 *
 * OUTPUT CONTRACT
 *   Last stdout line is single-line JSON: {"ok":true,"total":N,"source":…,…}
 *   Exit codes: 0 in sync/clean, 1 drift (--check), 2 environment error.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** Opening/closing marker pair; group 1/3 are the whitespace, group 2 the number. */
const MARKER_RE = /<!--\s*test-count\s*-->(\s*)(\d+)(\s*)<!--\s*\/test-count\s*-->/g;

const args = process.argv.slice(2);
const CHECK_ONLY = args.includes("--check");
const VERBOSE = args.includes("--verbose");

function fail(message, code = 2) {
  console.error(`sync-doc-counts: ${message}`);
  process.exit(code);
}

function repoRoot() {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  } catch {
    fail("not inside a git checkout — run this from the repository root.");
  }
}

/** Reporters this Node build can actually emit. Empty when the module is absent. */
async function availableReporters() {
  try {
    const mod = await import("node:test/reporters");
    return Object.keys(mod);
  } catch {
    return [];
  }
}

function runSuite(root, reporter) {
  return spawnSync(
    process.execPath,
    ["--test", `--test-reporter=${reporter}`],
    { cwd: root, encoding: "utf8", maxBuffer: 128 * 1024 * 1024 },
  );
}

/** `# tests 339` (TAP) or `1..339` fallback. */
function totalFromTap(text) {
  const named = text.match(/^#\s*tests\s+(\d+)\s*$/m);
  if (named) return Number(named[1]);
  const plan = text.match(/^1\.\.(\d+)\s*$/m);
  return plan ? Number(plan[1]) : null;
}

/** Newline-delimited JSON events; prefer the cumulative summary's `data.counts`. */
function totalFromJson(text) {
  let leafPasses = 0;
  let summaryTotal = null;
  let looseTotal = null;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let ev;
    try {
      ev = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!ev || typeof ev !== "object") continue;
    const counts = ev.data?.counts;
    if (ev.type === "test:summary" && counts) {
      // Emitted per file and once cumulatively under process isolation; the
      // last one wins, which is the run total.
      if (typeof counts.tests === "number") summaryTotal = counts.tests;
      else if (typeof counts.passed === "number") summaryTotal = counts.passed;
    }
    if (typeof ev.tests === "number") looseTotal = ev.tests;
    if (typeof ev.counts?.tests === "number") looseTotal = ev.counts.tests;
    // Last-resort tally: leaf results carry details.type !== 'suite'.
    if (ev.type === "test:pass" && ev.data?.details?.type !== "suite") leafPasses += 1;
  }
  return summaryTotal ?? looseTotal ?? (leafPasses > 0 ? leafPasses : null);
}

/** `ℹ tests 339` (spec reporter summary line). */
function totalFromSpec(text) {
  const m = text.match(/^\s*ℹ\s*tests\s+(\d+)\s*$/m) || text.match(/^\s*tests\s+(\d+)\s*$/m);
  return m ? Number(m[1]) : null;
}

async function collectTotal(root) {
  const reporters = await availableReporters();

  if (reporters.includes("json")) {
    const res = runSuite(root, "json");
    const total = totalFromJson(res.stdout || "");
    if (total != null) return { total, source: "json" };
    if (VERBOSE) console.error("sync-doc-counts: json reporter produced no readable total; falling back to tap.");
  }

  const tap = runSuite(root, "tap");
  const fromTap = totalFromTap(tap.stdout || "");
  if (fromTap != null) return { total: fromTap, source: "tap" };

  const spec = runSuite(root, "spec");
  const fromSpec = totalFromSpec(spec.stdout || "");
  if (fromSpec != null) return { total: fromSpec, source: "spec" };

  fail("could not determine the test total from the test runner output.");
}

/** Tracked Markdown files, the only docs allowed to carry the marker. */
function trackedMarkdown(root) {
  const out = execFileSync("git", ["ls-files", "-z", "*.md"], { cwd: root, encoding: "utf8" });
  return out.split("\0").filter(Boolean);
}

function markerLines(text) {
  const lines = [];
  const re = new RegExp(MARKER_RE.source, "g");
  let m;
  while ((m = re.exec(text)) !== null) {
    const upto = text.slice(0, m.index);
    const line = upto.split("\n").length;
    lines.push({ line, value: Number(m[2]) });
  }
  return lines;
}

function main() {
  const root = repoRoot();
  return collectTotal(root).then(({ total, source }) => {
    const files = trackedMarkdown(root);
    const drifts = [];
    let markers = 0;
    let written = 0;

    for (const rel of files) {
      const abs = path.join(root, rel);
      const original = fs.readFileSync(abs, "utf8");
      if (!original.includes("test-count")) continue;

      for (const found of markerLines(original)) {
        markers += 1;
        if (found.value !== total) drifts.push({ rel, line: found.line, found: found.value });
      }

      if (!CHECK_ONLY) {
        const updated = original.replace(MARKER_RE, (_full, pre, _num, post) => {
          const next = `${pre}${total}${post}`;
          if (_num !== String(total)) written += 1;
          return `<!-- test-count -->${next}<!-- /test-count -->`;
        });
        if (updated !== original) fs.writeFileSync(abs, updated, "utf8");
      }
    }

    if (markers === 0) {
      fail("no <!-- test-count --> markers found — nothing to guard.");
    }

    if (CHECK_ONLY) {
      if (drifts.length > 0) {
        console.error(`sync-doc-counts: ${drifts.length} stale count(s); the suite runs ${total} tests.`);
        for (const d of drifts) console.error(`  ${d.rel}:${d.line}  says ${d.found}, expected ${total}`);
        console.error("Fix: node scripts/sync-doc-counts.mjs");
        console.log(JSON.stringify({ ok: false, total, source, markers, drift: drifts.length }));
        process.exit(1);
      }
      console.log(`sync-doc-counts: ${markers} marker(s) match ${total} (${source}) — clean`);
      console.log(JSON.stringify({ ok: true, total, source, markers, drift: 0 }));
      return;
    }

    console.log(`sync-doc-counts: total ${total} (${source}); ${markers} marker(s), ${written} rewritten`);
    console.log(JSON.stringify({ ok: true, total, source, markers, rewritten: written }));
  });
}

main().catch((error) => fail(String(error?.message || error)));

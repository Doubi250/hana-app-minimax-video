#!/usr/bin/env node
/**
 * scripts/check-clean.mjs — machine-specific leak scan for tracked files.
 *
 * WHY THIS EXISTS
 *   This repository is public. A README once shipped local machine paths — a
 *   drive-letter user-profile path and the local checkout layout — into the
 *   public repository and into a release zip. The scan below is the cheap
 *   automated guard against that whole class of mistake; it runs from the
 *   pre-commit hook and (optionally) from CI.
 *
 * WHAT IT SCANS
 *   Every tracked file (`git ls-files`), line by line:
 *     - drive-letter user-profile paths and this machine's checkout layout
 *     - the local config directory (dot-hanako) and AppData paths
 *     - common credential shapes (API keys, GitHub tokens, JWTs, PEM headers)
 *   The detector itself carries no local usernames — it matches path SHAPES —
 *   so the guard can never become the leak it guards against.
 *
 * USAGE
 *   node scripts/check-clean.mjs             scan; exit 1 on any hit
 *   node scripts/check-clean.mjs --verbose   also list every scanned file
 *
 * WIRING (once per clone)
 *   git config core.hooksPath .githooks
 *   # .githooks/pre-commit runs this scan plus the offline unit suite
 *
 * ESCAPE HATCH
 *   When a match is intentional, put `check-clean:allow` on that line (or the
 *   line above it) and say why in the comment. Keep uses rare — a reviewer
 *   must see each one.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const ALLOW_MARKER = "check-clean:allow";

const PATTERNS = [
  { id: "windows-user-path", re: /[A-Za-z]:[\\/]{1,2}Users[\\/]{1,2}/i },
  { id: "openhanako-checkout", re: /[A-Za-z]:[\\/]{1,2}Openhanako\b/i },
  { id: "hanako-home-path", re: /\.hanako[\\/]/i },
  { id: "appdata-path", re: /AppData[\\/]/i },
  { id: "api-key", re: /sk-[A-Za-z0-9]{20,}/ },
  { id: "github-token", re: /(?:ghp|gho|ghu|ghs)_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/ },
  { id: "jwt", re: /eyJ[A-Za-z0-9_-]{20,}/ },
  { id: "private-key-header", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { id: "bearer-token", re: /Bearer\s+[A-Za-z0-9._~+/=-]{30,}/ },
];

const verbose = process.argv.includes("--verbose");

function listTrackedFiles() {
  const out = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" });
  return out.split("\0").filter(Boolean);
}

function looksBinary(buffer) {
  return buffer.subarray(0, 8000).includes(0);
}

function scanLine(line, prevLine) {
  if (line.includes(ALLOW_MARKER) || (prevLine || "").includes(ALLOW_MARKER)) return [];
  const hits = [];
  for (const { id, re } of PATTERNS) {
    if (re.test(line)) hits.push(id);
  }
  return hits;
}

function main() {
  let root;
  try {
    root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  } catch {
    console.error("check-clean: not inside a git checkout — run this from the repository root.");
    process.exit(2);
  }

  const files = listTrackedFiles();
  const findings = [];
  let scanned = 0;

  for (const rel of files) {
    const abs = path.join(root, rel);
    let buffer;
    try {
      const stat = fs.statSync(abs);
      if (stat.size > MAX_FILE_BYTES) {
        if (verbose) console.log(`skip (too large): ${rel}`);
        continue;
      }
      buffer = fs.readFileSync(abs);
    } catch {
      continue; // deleted in the worktree but still listed; nothing to scan
    }
    if (looksBinary(buffer)) {
      if (verbose) console.log(`skip (binary): ${rel}`);
      continue;
    }
    scanned += 1;

    const lines = buffer.toString("utf8").split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const ids = scanLine(lines[i], i > 0 ? lines[i - 1] : "");
      if (ids.length === 0) continue;
      const snippet = lines[i].trim().slice(0, 120);
      for (const id of ids) findings.push({ rel, line: i + 1, id, snippet });
    }
  }

  if (findings.length === 0) {
    console.log(`check-clean: scanned ${scanned} tracked files — clean`);
    process.exit(0);
  }

  console.error(`check-clean: ${findings.length} potential leak(s) in tracked files`);
  for (const f of findings) {
    console.error(`  ${f.rel}:${f.line}  [${f.id}]  ${f.snippet}`);
  }
  console.error("");
  console.error("Fix: replace machine-specific values with placeholders (<HANA_HOME>, <dist-dir>, ...).");
  console.error(`If a match is intentional, add "${ALLOW_MARKER}" on that line (or the line above) with a reason.`);
  process.exit(1);
}

main();

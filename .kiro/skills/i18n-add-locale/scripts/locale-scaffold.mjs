#!/usr/bin/env node
// locale-scaffold.mjs — deterministic step for /i18n-add-locale.
// Walks .claude/skills/* (and a small whitelist of other files) and scaffolds
// missing `.<locale>.hbs` siblings from their English masters.
//
// Usage:
//   locale-scaffold.mjs --locale vi [--dry-run] [--root .claude/skills]
//
// A "master" file is either:
//   - <stem>.md.hbs        → scaffold sibling <stem>.md.<locale>.hbs
//   - <stem>.md            → scaffold sibling <stem>.md.<locale>.hbs
//                            (rare; only when no .hbs counterpart exists)
//
// Idempotent: if the sibling already exists, the script leaves it alone.

import { readFileSync, existsSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join, dirname, basename, relative } from "node:path";

const ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();

function parseArgs(argv) {
  const out = { locale: null, dryRun: false, roots: [".claude/skills", ".claude/agents"] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--locale") out.locale = argv[++i];
    else if (argv[i] === "--dry-run") out.dryRun = true;
    else if (argv[i] === "--root") out.roots = [argv[++i]];
  }
  if (!out.locale || !/^[a-z]{2,5}(-[A-Z]{2})?$/.test(out.locale)) {
    console.error("usage: locale-scaffold.mjs --locale <code> [--dry-run] [--root <dir>]");
    console.error("  <code> = 2-5 lowercase letters, optional region (e.g. vi, ja, fr-CA)");
    process.exit(2);
  }
  return out;
}

function* walk(dir) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); }
  catch { return; }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else yield full;
  }
}

function isMaster(path, locale) {
  // English masters: *.md or *.md.hbs (but NOT *.md.<locale>.hbs already).
  const name = basename(path);
  if (!/\.md(?:\.hbs)?$/.test(name)) return false;
  // Skip locale-specific files of any code.
  if (/\.md\.[a-z]{2,5}(?:-[A-Z]{2})?\.hbs$/.test(name)) return false;
  return true;
}

function siblingPath(masterPath, locale) {
  // Preserve the master's Handlebars-ness in the variant. Master .md.hbs
  // → variant .md.<lang>.hbs (Handlebars-active). Master .md (plain) →
  // variant .md.<lang> (no Handlebars). This matters because plain-md
  // masters often contain literal `{{...}}` strings as examples (e.g.
  // XSS demos in security-reviewer.md); promoting them to .hbs would
  // make Handlebars choke on the example text.
  const name = basename(masterPath);
  if (name.endsWith(".md.hbs")) {
    return join(dirname(masterPath), name.replace(/\.md\.hbs$/, `.md.${locale}.hbs`));
  }
  if (name.endsWith(".md")) {
    return join(dirname(masterPath), name.replace(/\.md$/, `.md.${locale}`));
  }
  return null;
}

function scaffold(masterPath, siblingPathAbs, locale, dryRun) {
  if (existsSync(siblingPathAbs)) return { status: "skip", reason: "exists" };
  if (dryRun) return { status: "would-create" };
  const body = readFileSync(masterPath, "utf8");
  const banner =
`<!-- LOCALE_TODO: translate body to ${locale} -->
<!-- Source: ${relative(ROOT, masterPath)} -->
<!-- Edit only the markdown body — keep frontmatter verbatim so the kit's renderer + Claude Code parse it identically across locales. -->

`;
  writeFileSync(siblingPathAbs, banner + body);
  return { status: "created" };
}

function main() {
  const { locale, dryRun, roots } = parseArgs(process.argv.slice(2));
  const masters = [];
  for (const r of roots) {
    const abs = resolve(ROOT, r);
    if (!existsSync(abs)) continue;
    for (const f of walk(abs)) {
      if (isMaster(f, locale)) masters.push(f);
    }
  }
  let created = 0;
  let skipped = 0;
  const wouldCreate = [];
  for (const m of masters) {
    const sib = siblingPath(m, locale);
    if (!sib) continue;
    const res = scaffold(m, sib, locale, dryRun);
    if (res.status === "created") created++;
    else if (res.status === "would-create") wouldCreate.push(relative(ROOT, sib));
    else skipped++;
  }
  const payload = {
    locale,
    dry_run: dryRun,
    scaffolded: dryRun ? wouldCreate.length : created,
    already_present: skipped,
    scanned_masters: masters.length,
    would_create: dryRun ? wouldCreate : undefined,
    register_in: "src/core/render-templates.mjs#SUPPORTED_HUMAN_LANGS",
  };
  process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
}

main();

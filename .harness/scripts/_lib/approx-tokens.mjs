#!/usr/bin/env node
// approx-tokens.mjs — heuristic token counter for CLAUDE.md cap.
//
// Why this exists: the original `claudeMd.maxInstructions` cap counts
// bullets and numbered list items. For ASCII-heavy English content, 200
// bullets ≈ ~3000 tokens (the threshold HumanLayer measured). But for
// CJK or accent-heavy languages (Vietnamese, Thai), the same 200 bullets
// can carry 2–3× more tokens, so the bullet count alone can let drift
// past the model's "follow CLAUDE.md reliably" budget without firing.
//
// Heuristic: Anthropic's tokenizer charges roughly:
//   - 1 token per ~4 ASCII chars (English/code)
//   - 1 token per ~2 chars for non-ASCII (Vietnamese, CJK, etc.)
//
// We approximate by walking code points, classifying each into
// "latin-1" (codepoint < 0x100, ~4 chars/token) vs "other" (~2 chars/
// token), and dividing accordingly. Off by maybe 10–20% vs the real
// tokenizer — close enough for a Stop-hook cap.
//
// Output: a single integer (the approximate token count).

import { readFileSync } from "node:fs";

const path = process.argv[2];
if (!path) {
  console.error("usage: approx-tokens.mjs <file>");
  process.exit(1);
}

let text;
try {
  text = readFileSync(path, "utf8");
} catch (e) {
  console.error(`approx-tokens: cannot read ${path}: ${e.message}`);
  process.exit(1);
}

// Write a raw integer (no console.log: Node colorizes numbers under
// FORCE_COLOR, and this value is parsed by shell integer comparisons).
process.stdout.write(`${approxTokens(text)}\n`);

export function approxTokens(text) {
  let latin = 0;
  let other = 0;
  for (const ch of text) {
    if (ch.codePointAt(0) < 0x100) latin++;
    else other++;
  }
  return Math.ceil(latin / 4 + other / 2);
}

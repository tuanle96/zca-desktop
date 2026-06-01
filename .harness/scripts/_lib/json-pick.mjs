#!/usr/bin/env node
// json-pick.mjs — tiny jq-subset for Stop hook + pre-push hook.
//
// Why this exists: harness hooks shell out to `jq` for path queries against
// .harness/config.json. On minimal CI images and on Windows without WSL+brew,
// `jq` is missing — the hooks used to silently skip the whole check (return
// 0 from a stub branch), which left the user unprotected. This script is a
// pure-Node fallback so a `node` binary is the only hard requirement (which
// the kit already has via the `engines` field).
//
// Usage:
//   node json-pick.mjs <jq-expr> <file>
//   node json-pick.mjs <jq-expr> < json-on-stdin
//
// Supported subset (the only constructs the hooks actually use today):
//   .                                 — identity
//   .a.b.c                            — dotted path
//   .a[3]                             — array index
//   .a[]                              — iterate array (one value per line)
//   .a | length                       — length of array / object / string
//   .a // "fallback"                  — alternative when missing/null/false
//   .a // empty                       — emit nothing when missing (jq idiom)
//   length                            — length of root value
//
// Output format matches `jq -r`: strings are unquoted, booleans/numbers are
// raw. Missing/null prints empty string when used with `// default` else
// prints `null` (same as `jq -r`).
//
// Exit codes:
//   0 — value resolved (may be empty string)
//   1 — parse / IO error
//
// Hard-coded subset by design. Adding new operators here forces an update to
// the hook scripts, which keeps the surface auditable.

import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("usage: json-pick.mjs <expr> [<file>]");
  process.exit(1);
}
const expr = args[0];
const file = args[1];

let raw;
try {
  raw = file ? readFileSync(file, "utf8") : readFileSync(0, "utf8");
} catch (e) {
  console.error(`json-pick: cannot read ${file ?? "stdin"}: ${e.message}`);
  process.exit(1);
}

let root;
try {
  root = JSON.parse(raw);
} catch (e) {
  console.error(`json-pick: invalid JSON in ${file ?? "stdin"}: ${e.message}`);
  process.exit(1);
}

function tokenize(src) {
  const toks = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n") { i++; continue; }
    if (c === ".") { toks.push({ t: "dot" }); i++; continue; }
    if (c === "|") { toks.push({ t: "pipe" }); i++; continue; }
    if (c === "[") { toks.push({ t: "lbrack" }); i++; continue; }
    if (c === "]") { toks.push({ t: "rbrack" }); i++; continue; }
    if (c === "/" && src[i + 1] === "/") { toks.push({ t: "fallback" }); i += 2; continue; }
    if (c === '"') {
      let j = i + 1, val = "";
      while (j < src.length && src[j] !== '"') {
        if (src[j] === "\\" && j + 1 < src.length) { val += src[j + 1]; j += 2; continue; }
        val += src[j]; j++;
      }
      if (src[j] !== '"') throw new Error("unterminated string");
      toks.push({ t: "string", v: val });
      i = j + 1; continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9-]/.test(src[j])) j++;
      toks.push({ t: "number", v: parseInt(src.slice(i, j), 10) });
      i = j; continue;
    }
    if (/[a-zA-Z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[a-zA-Z0-9_]/.test(src[j])) j++;
      const word = src.slice(i, j);
      if (word === "length" || word === "null" || word === "true" || word === "false") {
        toks.push({ t: "keyword", v: word });
      } else {
        toks.push({ t: "ident", v: word });
      }
      i = j; continue;
    }
    throw new Error(`unexpected char '${c}' at ${i}`);
  }
  return toks;
}

// Parse and apply against root. Returns array of result rows (each printed on
// its own line) — `[]` may produce many, `.` produces one.
function evalExpr(src, value) {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const eat = (t) => {
    if (!toks[p] || toks[p].t !== t) throw new Error(`expected ${t}, got ${toks[p]?.t ?? "EOF"}`);
    return toks[p++];
  };

  // pipeline = primary ( "|" filter )*    and `// default` is parsed at the path level.
  // We unify "// default" handling: any path can have `// LITERAL` appended.
  function parsePrimary() {
    // Special case: starting with `length` alone → length of root.
    if (peek() && peek().t === "keyword" && peek().v === "length") {
      p++;
      return { kind: "length", inner: { kind: "identity" } };
    }
    return parsePath();
  }

  function parsePath() {
    // Must start with "."
    if (!peek() || peek().t !== "dot") throw new Error("expr must start with '.'");
    p++;
    const steps = [];
    // Allow `.` alone (identity).
    while (peek()) {
      const cur = peek();
      if (cur.t === "ident") {
        steps.push({ kind: "key", v: cur.v });
        p++;
        // optional `.next` chain
        while (peek() && peek().t === "dot" && toks[p + 1] && toks[p + 1].t === "ident") {
          p++; // dot
          steps.push({ kind: "key", v: toks[p].v });
          p++;
        }
        continue;
      }
      if (cur.t === "lbrack") {
        p++;
        if (peek() && peek().t === "rbrack") {
          steps.push({ kind: "iter" });
          p++;
        } else if (peek() && peek().t === "number") {
          const n = toks[p].v;
          p++;
          eat("rbrack");
          steps.push({ kind: "index", v: n });
        } else {
          throw new Error("expected number or ']' after '['");
        }
        // dot after `]` is allowed: `.a[0].b`
        if (peek() && peek().t === "dot") {
          p++;
        }
        continue;
      }
      break;
    }
    return { kind: "path", steps };
  }

  let node = parsePrimary();

  // ( | length )* and ( // literal )?
  while (peek()) {
    if (peek().t === "pipe") {
      p++;
      if (peek() && peek().t === "keyword" && peek().v === "length") {
        p++;
        node = { kind: "length", inner: node };
      } else {
        throw new Error("only 'length' is supported after '|'");
      }
      continue;
    }
    if (peek().t === "fallback") {
      p++;
      const lit = peek();
      if (!lit) throw new Error("expected literal after //");
      let v;
      let drop = false;
      if (lit.t === "string") v = lit.v;
      else if (lit.t === "number") v = lit.v;
      else if (lit.t === "keyword") {
        if (lit.v === "true") v = true;
        else if (lit.v === "false") v = false;
        else if (lit.v === "null") v = null;
        else throw new Error("unexpected literal");
      } else if (lit.t === "ident" && lit.v === "empty") {
        drop = true;
      } else {
        throw new Error("expected literal after //");
      }
      p++;
      node = { kind: "fallback", inner: node, default: v, drop };
      continue;
    }
    break;
  }

  if (p !== toks.length) {
    throw new Error("trailing tokens");
  }

  // Now interpret.
  function run(n, v) {
    if (n.kind === "identity") return [v];
    if (n.kind === "path") {
      let cur = [v];
      for (const step of n.steps) {
        const next = [];
        for (const item of cur) {
          if (step.kind === "key") {
            next.push(item == null ? null : item[step.v]);
          } else if (step.kind === "index") {
            next.push(Array.isArray(item) ? item[step.v] : null);
          } else if (step.kind === "iter") {
            if (Array.isArray(item)) for (const e of item) next.push(e);
            else if (item && typeof item === "object") for (const e of Object.values(item)) next.push(e);
            else next.push(null);
          }
        }
        cur = next;
      }
      if (n.steps.length === 0) return [v]; // bare `.`
      return cur;
    }
    if (n.kind === "length") {
      const inner = run(n.inner, v);
      return inner.map((x) => {
        if (x == null) return 0;
        if (Array.isArray(x)) return x.length;
        if (typeof x === "string") return x.length;
        if (typeof x === "object") return Object.keys(x).length;
        return 0;
      });
    }
    if (n.kind === "fallback") {
      const inner = run(n.inner, v);
      const out = [];
      for (const x of inner) {
        const missing = x === null || x === undefined || x === false;
        if (missing && n.drop) continue;
        out.push(missing ? n.default : x);
      }
      return out;
    }
    throw new Error("unknown node kind");
  }

  return run(node, value);
}

let rows;
try {
  rows = evalExpr(expr, root);
} catch (e) {
  console.error(`json-pick: ${e.message} (expr: ${expr})`);
  process.exit(1);
}

for (const r of rows) {
  if (r === null || r === undefined) {
    console.log("null");
  } else if (typeof r === "string") {
    console.log(r);
  } else {
    console.log(JSON.stringify(r));
  }
}

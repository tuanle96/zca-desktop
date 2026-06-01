#!/usr/bin/env node
// statusLine — "Dashboard Style" (Variant 4).
//
// LINE 1 — vitals with rich icons (always emitted when any segment resolves):
//   ▶ Opus 4.7 │ 📝 terse │ ⏱ 1h12m │ ⎇ main(±3) │ ✓ clean │ ▓▓▓▓░ 42% │ $0.83 │ +156/-23
//
// LINE 2 — alerts with clear segmentation (only when ≥1 trigger fires):
//   ⚠ >200K — auto-compact next msg │ ⏳ 5h limit 78%, resets in 1h12m │ 🚫 last-block: <title>
//
// Payload (Claude Code v2.1.132+ schema):
//   model.display_name, output_style.name, session_id, version,
//   cost.{total_cost_usd, total_duration_ms, total_lines_added, total_lines_removed},
//   context_window.{used_percentage, context_window_size, total_input_tokens},
//   exceeds_200k_tokens, rate_limits.five_hour.{used_percentage, resets_at}
//
// Behaviour gates:
//   - NO_COLOR env or non-TTY → ANSI escapes stripped, plain text only.
//   - .harness/config.json#statusline.compact = true → line 2 dropped.
//   - .harness/config.json#statusline.{lang,showLines,showRateLimit,showLastBlock}
//     toggle individual segments. Defaults: full features, lang from
//     claudeMd.humanLanguage.
//
// Caching:
//   - Git branch / dirty count cached 5s per session_id.
//   - .harness/feature_list.json cached 30s.
//   - telemetry tail cached 10s.
//   - .harness/config.json cached 60s.
//
// Failure mode: print nothing rather than crash. The TUI never breaks
// because of a statusline bug.

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { cached } from "./_lib/statusline-cache.mjs";

const CWD = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const GIT_TIMEOUT_MS = 5_000;
const NO_COLOR =
  process.env.NO_COLOR != null && process.env.NO_COLOR !== "" ||
  process.env.AHK_STATUSLINE_NO_COLOR === "1";

// ---------------------------------------------------------------------------
// Tiny helpers.
// ---------------------------------------------------------------------------
function safeRead(rel) {
  try { return readFileSync(resolve(CWD, rel), "utf8"); }
  catch { return null; }
}
function safeJSON(rel) {
  const raw = safeRead(rel);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
function readStdinSync() {
  try { return readFileSync(0, "utf8"); } catch { return ""; }
}
function num(x, def = 0) {
  return typeof x === "number" && Number.isFinite(x) ? x : def;
}

// ANSI wrappers. When NO_COLOR is set, return the bare string — every caller
// produces uncoloured output without branching.
const RESET = NO_COLOR ? "" : "\x1b[0m";
function c(code, s) {
  if (NO_COLOR || !s) return s ?? "";
  return `\x1b[${code}m${s}${RESET}`;
}
const cyan    = (s) => c("36", s);
const green   = (s) => c("32", s);
const yellow  = (s) => c("33", s);
const red     = (s) => c("31", s);
const magenta = (s) => c("35", s);
const dim     = (s) => c("2", s);
const dimGreen = (s) => c("2;32", s);
const dimRed   = (s) => c("2;31", s);

// Color the context bar gradient by percentage band.
function ctxColor(pct) {
  if (pct >= 80) return red;
  if (pct >= 50) return yellow;
  return cyan;
}

// Color the cost by tier — under $1 dim, $1–5 default, $5+ yellow.
function costStr(usd) {
  const v = num(usd, 0);
  const str = "$" + (v < 1 ? v.toFixed(2) : v < 10 ? v.toFixed(2) : v.toFixed(1));
  if (v < 1) return dim(str);
  if (v < 5) return str;
  return yellow(str);
}

// ---------------------------------------------------------------------------
// Config & locale.
// ---------------------------------------------------------------------------
const DEFAULT_CONFIG = {
  compact: false,
  lang: null,
  showLines: true,
  showRateLimit: true,
  showLastBlock: true,
};

function readConfig(sessionId) {
  const raw = cached(
    { sessionId, key: "config", ttlMs: 60_000 },
    () => safeRead(".harness/config.json") ?? "",
  );
  if (!raw) return { config: DEFAULT_CONFIG, humanLanguage: "en" };
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return { config: DEFAULT_CONFIG, humanLanguage: "en" }; }
  const config = { ...DEFAULT_CONFIG, ...(parsed?.statusline ?? {}) };
  const humanLanguage = parsed?.claudeMd?.humanLanguage || "en";
  return { config, humanLanguage };
}

const STRINGS = {
  en: {
    compact_soon: " — /compact soon",
    over_200k: ">200K — auto-compact next msg",
    rate_resets: ", resets in ",
    last_block: "last-block: ",
  },
  vi: {
    compact_soon: " — /compact sắp tới",
    over_200k: ">200K — sắp auto-compact",
    rate_resets: ", reset trong ",
    last_block: "vừa block: ",
  },
};

function pickLang(config, humanLanguage) {
  const lang = config.lang || humanLanguage;
  return STRINGS[lang] ? lang : "en";
}

// ---------------------------------------------------------------------------
// Segment data fetchers (cached).
// ---------------------------------------------------------------------------
function fetchGit(sessionId) {
  const raw = cached(
    { sessionId, key: "git", ttlMs: 5_000 },
    () => {
      const br = spawnSync("git", ["branch", "--show-current"], {
        cwd: CWD, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: GIT_TIMEOUT_MS,
      });
      if (br.status !== 0 || !br.stdout) return "";
      const branch = br.stdout.trim();
      if (!branch) return "";
      const st = spawnSync("git", ["status", "--short"], {
        cwd: CWD, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: GIT_TIMEOUT_MS,
      });
      const dirty = st.stdout ? st.stdout.split("\n").filter(Boolean).length : 0;
      // Conflict marker check — short and cheap on already-fetched output.
      const conflict = /^(UU|AA|DD)/m.test(st.stdout || "");
      return JSON.stringify({ branch, dirty, conflict });
    },
  );
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function fetchFeature(sessionId) {
  const raw = cached(
    { sessionId, key: "feat", ttlMs: 30_000 },
    () => safeRead(".harness/feature_list.json") ?? "",
  );
  if (!raw) return null;
  let features;
  try { features = JSON.parse(raw); } catch { return null; }
  if (!features?.features || !Array.isArray(features.features)) return null;
  const open = features.features.find((f) => f.passes === false);
  return { open: open?.id ?? null, clean: !open };
}

function isLastBlockRecord(rec) {
  const event = String(rec?.event || "").toLowerCase();
  if (event === "block_remediated" || event === "remediation" || event === "precompletion_loop_guard") return false;
  if (["precompletion_block", "permission_denied", "userprompt_block", "structural_test_fail"].includes(event)) return true;
  if (rec?.type === "tool_blocked" || rec?.decision === "block") return true;
  if (event === "notification" || rec?.hook === "Notification") {
    return /\b(block|blocked|denied|failed|failure)\b/i.test(`${rec?.type || ""} ${rec?.title || ""} ${rec?.body || ""} ${rec?.reason || ""}`);
  }
  return false;
}

function lastBlockTitle(rec) {
  const failures = Array.isArray(rec?.failures) ? rec.failures.join(", ") : String(rec?.failures || "");
  return rec?.title || rec?.reason || rec?.rule || rec?.source || failures || rec?.body || rec?.type || rec?.event || "block";
}

// Returns the most recent block record from .harness/telemetry.jsonl. Returns
// {ts, title} if found within the last 5 min, else null. Caching avoids
// re-reading the JSONL on every refresh.
function fetchLastBlock(sessionId) {
  const raw = cached(
    { sessionId, key: "tele", ttlMs: 10_000 },
    () => {
      const body = safeRead(".harness/telemetry.jsonl");
      if (!body) return "";
      const lines = body.split("\n").filter(Boolean);
      for (let i = lines.length - 1; i >= 0 && i >= lines.length - 50; i--) {
        try {
          const rec = JSON.parse(lines[i]);
          if (isLastBlockRecord(rec)) {
            return JSON.stringify({ ts: rec.ts, title: lastBlockTitle(rec) });
          }
        } catch { /* skip malformed */ }
      }
      return "";
    },
  );
  if (!raw) return null;
  let rec;
  try { rec = JSON.parse(raw); } catch { return null; }
  if (!rec?.ts) return null;
  const ageMs = Date.now() - new Date(rec.ts).getTime();
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > 5 * 60_000) return null;
  return rec;
}

// ---------------------------------------------------------------------------
// Format helpers.
// ---------------------------------------------------------------------------
function fmtDuration(ms) {
  const s = Math.floor(num(ms, 0) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h${String(rm).padStart(2, "0")}m`;
}

function fmtCountdown(epochSeconds) {
  const target = Number(epochSeconds) * 1000;
  if (!Number.isFinite(target)) return "?";
  const ms = target - Date.now();
  if (ms <= 0) return "0m";
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h${String(rm).padStart(2, "0")}m`;
}

function bar(pct, width = 10) {
  const p = Math.max(0, Math.min(100, num(pct, 0)));
  const filled = Math.round((p / 100) * width);
  return "▓".repeat(filled) + "░".repeat(width - filled);
}

// ---------------------------------------------------------------------------
// Line 1 — vitals (Dashboard Style with rich icons).
// ---------------------------------------------------------------------------
function renderLine1(payload, git, feat, config) {
  const segments = [];

  // Segment 1: Model with play icon
  const modelName = payload?.model?.display_name;
  if (modelName) {
    segments.push(`${green("▶")} ${cyan(modelName)}`);
  }

  // Segment 2: Output style with document icon
  const styleName = payload?.output_style?.name;
  if (styleName && styleName !== "default") {
    segments.push(`${dim("📝")} ${dim(styleName)}`);
  }

  // Segment 3: Duration with timer icon
  const durMs = payload?.cost?.total_duration_ms;
  if (durMs && durMs >= 1000) {
    segments.push(`${dim("⏱")} ${dim(fmtDuration(durMs))}`);
  }

  // Segment 4: Branch with git icon
  if (git?.branch) {
    const branchIcon = dim("⎇");
    const branchText = git.conflict ? red(`${git.branch}!CONFLICT`)
                     : git.dirty > 0 ? `${yellow(git.branch)}${dim("(")}${yellow(`±${git.dirty}`)}${dim(")")}`
                     : yellow(git.branch);
    segments.push(`${branchIcon} ${branchText}`);
  }

  // Segment 5: Feature status with checkmark/cross icon
  if (feat) {
    const featIcon = feat.open ? red("✗") : green("✓");
    const featText = feat.open ? magenta(feat.open) : green("clean");
    segments.push(`${featIcon} ${featText}`);
  }

  // Segment 6: Context usage (bar + percentage)
  const pct = payload?.context_window?.used_percentage;
  if (typeof pct === "number") {
    const col = ctxColor(pct);
    segments.push(`${col(bar(pct))} ${col(`${Math.round(pct)}%`)}`);
  }

  // Segment 7: Cost
  const cost = payload?.cost?.total_cost_usd;
  if (typeof cost === "number" && cost > 0) {
    segments.push(costStr(cost));
  }

  // Segment 8: Lines changed
  if (config.showLines) {
    const add = num(payload?.cost?.total_lines_added, 0);
    const rem = num(payload?.cost?.total_lines_removed, 0);
    if (add > 0 || rem > 0) {
      segments.push(`${green("+" + add)}/${dimRed("-" + rem)}`);
    }
  }

  return segments.join(` ${dim("│")} `);
}

// ---------------------------------------------------------------------------
// Line 2 — alerts (Dashboard Style with rich icons and clear segmentation).
// ---------------------------------------------------------------------------
function renderLine2(payload, sessionId, config, lang) {
  if (config.compact) return "";
  const t = STRINGS[lang];
  const alerts = [];

  // Order by severity: hardest stop first.
  if (payload?.exceeds_200k_tokens === true) {
    alerts.push(`${red("⚠")} ${red(t.over_200k)}`);
  }

  const pct = payload?.context_window?.used_percentage;
  if (typeof pct === "number" && pct >= 80 && payload?.exceeds_200k_tokens !== true) {
    alerts.push(`${red("⚠")} ${red(`ctx ${Math.round(pct)}%${t.compact_soon}`)}`);
  }

  if (config.showRateLimit) {
    const five = payload?.rate_limits?.five_hour;
    if (five && typeof five.used_percentage === "number" && five.used_percentage >= 75) {
      const resetTxt = five.resets_at ? `${t.rate_resets}${fmtCountdown(five.resets_at)}` : "";
      alerts.push(`${yellow("⏳")} ${yellow(`5h limit ${Math.round(five.used_percentage)}%${resetTxt}`)}`);
    }
  }

  if (config.showLastBlock) {
    const lb = fetchLastBlock(sessionId);
    if (lb) {
      const title = String(lb.title || "").slice(0, 40);
      alerts.push(`${red("🚫")} ${red(`${t.last_block}${title}`)}`);
    }
  }

  return alerts.join(` ${dim("│")} `);
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------
function main() {
  const raw = readStdinSync();
  let payload = {};
  if (raw) {
    try { payload = JSON.parse(raw) || {}; } catch { payload = {}; }
  }
  const sessionId = payload?.session_id || "no-session";
  const { config, humanLanguage } = readConfig(sessionId);
  const lang = pickLang(config, humanLanguage);

  const git = fetchGit(sessionId);
  const feat = fetchFeature(sessionId);

  const line1 = renderLine1(payload, git, feat, config);
  const line2 = renderLine2(payload, sessionId, config, lang);

  const out = [];
  if (line1) out.push(line1);
  if (line2) out.push(line2);
  if (out.length) process.stdout.write(out.join("\n"));
}

try { main(); } catch { /* swallow — never crash the TUI */ }

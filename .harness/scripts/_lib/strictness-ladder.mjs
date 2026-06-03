export const STRICTNESS_TIER_ORDER = ["starter", "standard", "strict", "release", "team"];

export const STRICTNESS_TIERS = {
  starter: {
    title: "Starter",
    intendedUser: "New solo project",
    behavior: "Warn-first, minimal friction.",
    gateIds: [
      "structural-baseline",
      "hook-integrity",
      "runtime-surface",
      "structural",
      "skill-contracts",
      "permissions-drift",
      "architecture-fitness",
    ],
    optionalGateIds: [
      "structural-baseline",
      "hook-integrity",
      "runtime-surface",
      "structural",
      "skill-contracts",
      "permissions-drift",
      "architecture-fitness",
    ],
  },
  standard: {
    title: "Standard",
    intendedUser: "Active solo project",
    behavior: "Evidence and reviews enforced for normal work.",
    gateIds: [
      "structural-baseline",
      "hook-integrity",
      "runtime-surface",
      "structural",
      "skill-contracts",
      "skill-examples",
      "trace-corpus",
      "review-coverage",
      "architecture-fitness",
      "stable-schemas",
      "permissions-drift",
      "task-evidence",
      "evidence-attestation",
      "harness-report",
      "bypass-audit",
    ],
    optionalGateIds: ["skill-examples", "trace-corpus", "harness-report", "bypass-audit"],
  },
  strict: {
    title: "Strict",
    intendedUser: "Serious repo",
    behavior: "High-risk isolation, attestation, bypass approval, PR gates.",
    gateIds: [
      "structural-baseline",
      "hook-integrity",
      "runtime-surface",
      "structural",
      "skill-contracts",
      "skill-examples",
      "trace-corpus",
      "review-coverage",
      "architecture-fitness",
      "policy-packs",
      "stable-schemas",
      "permissions-drift",
      "bypass-audit",
      "operational-state",
      "harness-report",
      "session-isolation",
      "task-evidence",
      "evidence-attestation",
      "model-routing",
      "runtime-parity",
      "runtime-conformance",
    ],
    optionalGateIds: ["model-routing", "runtime-parity", "runtime-conformance"],
  },
  release: {
    title: "Release",
    intendedUser: "Package or production release",
    behavior: "Adversarial evals, runtime parity, no unreviewed bypasses.",
    gateIds: [
      "structural-baseline",
      "hook-integrity",
      "runtime-surface",
      "structural",
      "skill-contracts",
      "skill-examples",
      "trace-corpus",
      "review-coverage",
      "architecture-fitness",
      "policy-packs",
      "stable-schemas",
      "permissions-drift",
      "bypass-audit",
      "eval-tasks",
      "adversarial-suite",
      "failure-records",
      "operational-state",
      "harness-report",
      "orchestration-contracts",
      "session-isolation",
      "task-evidence",
      "evidence-attestation",
      "model-routing",
      "runtime-parity",
      "runtime-conformance",
    ],
    optionalGateIds: ["model-routing"],
  },
  team: {
    title: "Team",
    intendedUser: "Multi-developer repo",
    behavior: "PR annotations, policy packs, retention, state export.",
    gateIds: [
      "structural-baseline",
      "hook-integrity",
      "runtime-surface",
      "structural",
      "skill-contracts",
      "skill-examples",
      "trace-corpus",
      "review-coverage",
      "architecture-fitness",
      "policy-packs",
      "stable-schemas",
      "permissions-drift",
      "bypass-audit",
      "eval-tasks",
      "adversarial-suite",
      "failure-records",
      "operational-state",
      "harness-report",
      "orchestration-contracts",
      "session-isolation",
      "task-evidence",
      "evidence-attestation",
      "model-routing",
      "runtime-parity",
      "runtime-conformance",
    ],
    optionalGateIds: [],
  },
};

const KNOWN_STRICTNESS_GATE_IDS = new Set(
  Object.values(STRICTNESS_TIERS).flatMap((tier) => tier.gateIds),
);

export function normalizeStrictnessTier(value, fallback = "standard") {
  const tier = String(value || fallback).trim().toLowerCase();
  return STRICTNESS_TIERS[tier] ? tier : fallback;
}

export function validateStrictnessTier(value) {
  const tier = String(value || "").trim().toLowerCase();
  if (!STRICTNESS_TIERS[tier]) {
    throw new Error(`Unsupported strictness tier "${value}". Supported: ${STRICTNESS_TIER_ORDER.join(", ")}`);
  }
  return tier;
}

export function defaultStrictnessConfig(tier = "standard") {
  return {
    tier: normalizeStrictnessTier(tier),
    availableTiers: STRICTNESS_TIER_ORDER,
    migrationCommand: "node .harness/scripts/strictness.mjs set <tier>",
  };
}

export function compileGatesForStrictness(gates, tierInput) {
  const tier = normalizeStrictnessTier(tierInput);
  const spec = STRICTNESS_TIERS[tier];
  const byId = new Map((Array.isArray(gates) ? gates : []).map((gate) => [gate?.id, gate]).filter(([id]) => id));
  const missing = [];
  const compiled = [];
  for (const id of spec.gateIds) {
    const gate = byId.get(id);
    if (!gate) {
      missing.push(id);
      continue;
    }
    compiled.push({
      ...gate,
      required: !spec.optionalGateIds.includes(id),
    });
  }
  const custom = [];
  for (const gate of Array.isArray(gates) ? gates : []) {
    if (!gate?.id || KNOWN_STRICTNESS_GATE_IDS.has(gate.id)) continue;
    custom.push(gate);
  }
  return {
    tier,
    spec,
    gates: [...compiled, ...custom],
    missing,
    customGateIds: custom.map((gate) => gate.id),
  };
}

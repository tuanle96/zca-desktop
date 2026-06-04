#!/usr/bin/env node

/**
 * Feature classification script
 * Deterministically classifies feature requests into tiny/normal/high-risk
 * based on keyword signals and heuristics.
 */

const HIGH_RISK_SIGNALS = [
  // Security & Auth
  'auth', 'authentication', 'authorization', 'permission', 'role', 'access control',
  'security', 'encrypt', 'decrypt', 'token', 'session', 'oauth', 'saml', 'jwt',
  'password', 'credential', 'secret', 'api key', 'private key',

  // Data & Schema
  'database', 'schema', 'migration', 'alter table', 'drop table', 'rename column',
  'add column', 'remove column', 'index', 'foreign key', 'constraint',

  // Breaking Changes
  'breaking', 'breaking change', 'remove', 'delete', 'deprecate', 'rename api',
  'change signature', 'modify interface', 'alter contract',

  // Infrastructure
  'deploy', 'deployment', 'infrastructure', 'docker', 'kubernetes', 'terraform',
  'cloud', 'aws', 'gcp', 'azure', 'cdn', 'load balancer', 'scaling',

  // Cross-cutting
  'logging', 'monitoring', 'observability', 'telemetry', 'tracing', 'metrics',
  'error handling', 'retry', 'circuit breaker', 'rate limit', 'throttle',

  // Performance
  'performance', 'optimize', 'cache', 'caching', 'redis', 'memcached',
  'query optimization', 'n+1', 'batch', 'async', 'queue', 'worker',

  // External Dependencies
  'new dependency', 'add package', 'third party', 'external service', 'api integration',
  'webhook', 'payment', 'stripe', 'billing',

  // Sensitive Data
  'pii', 'personal data', 'gdpr', 'compliance', 'audit', 'privacy',
  'user data', 'sensitive', 'confidential'
];

const TINY_SIGNALS = [
  // Simple UI
  'button', 'label', 'text', 'color', 'style', 'css', 'margin', 'padding',
  'font', 'icon', 'tooltip', 'placeholder',

  // Simple Logic
  'typo', 'fix typo', 'rename variable', 'format', 'lint', 'comment',
  'log message', 'error message', 'validation message',

  // Documentation
  'readme', 'documentation', 'doc', 'comment', 'jsdoc', 'docstring',

  // Config
  'config value', 'environment variable', 'constant', 'default value'
];


// Phase 2.3: Explicit ADR-trigger detector. Returns the list of canonical
// architectural triggers found in a description. Used both inside classify()
// (high-risk uplift) and exported so reviewers/skills can answer
// "does this need an ADR?" without re-implementing the keyword list.
const ADR_TRIGGERS = [
  { id: 'new-layer', pattern: /\b(new|add|introduce)\s+(a\s+)?(layer|domain|module|service|provider|adapter|boundary)\b/ },
  { id: 'layer-order', pattern: /\b(re-?order|swap|change|invert)\s+(the\s+)?layer(s)?\b/ },
  { id: 'breaking-api', pattern: /\b(breaking|break)\s+(api|contract|schema|interface)\b/ },
  { id: 'auth-boundary', pattern: /\b(auth|authn|authz|authentication|authorization|rbac|permission|session|jwt)\b/ },
  { id: 'security-boundary', pattern: /\b(security|secret|credential|encryption|crypto|tls|csrf|xss|sql injection)\b/ },
  { id: 'data-migration', pattern: /\b(migrate|migration|schema change|data model|drop\s+(table|column)|rename\s+(table|column))\b/ },
  { id: 'deployment', pattern: /\b(deploy|deployment|release strategy|rollout|blue.?green|canary|infra(structure)?)\b/ },
  { id: 'dependency-swap', pattern: /\b(swap|replace|switch)\s+(out\s+)?(framework|library|database|orm|provider|vendor)\b/ },
  { id: 'major-dependency', pattern: /\b(adopt|introduce|add)\s+(a\s+)?(framework|database|orm|message queue|cache|provider)\b/ },
  { id: 'naming-convention', pattern: /\b(naming convention|rename across|global rename)\b/ },
  { id: 'performance-critical', pattern: /\b(performance.?critical|hot path|p99|latency budget|throughput)\b/ },
  { id: 'external-service', pattern: /\b(integrate|integration with|new external service|3rd.?party|third.?party)\b/ },
];

export function detectAdrTriggers(description) {
  if (typeof description !== 'string' || description.length === 0) return [];
  const lower = description.toLowerCase();
  const hits = [];
  for (const trigger of ADR_TRIGGERS) {
    if (trigger.pattern.test(lower)) hits.push(trigger.id);
  }
  return hits;
}

const COMPLEXITY_MULTIPLIERS = {
  'refactor': 1.5,
  'rewrite': 2.0,
  'migrate': 2.0,
  'upgrade': 1.5,
  'multiple': 1.3,
  'all': 1.3,
  'every': 1.3,
  'across': 1.5
};

function classify(description) {
  const lower = description.toLowerCase();
  const words = lower.split(/\s+/);

  // Count signals
  let highRiskScore = 0;
  let tinyScore = 0;
  const foundSignals = [];

  // Phase 2.3: explicit ADR triggers — each match is treated as a high-risk
  // signal and surfaced separately in the result so callers can route to
  // /add-adr without re-parsing the description.
  const adrTriggers = detectAdrTriggers(description);
  for (const t of adrTriggers) {
    highRiskScore++;
    foundSignals.push(`adr-trigger: "${t}"`);
  }

  for (const signal of HIGH_RISK_SIGNALS) {
    if (lower.includes(signal)) {
      highRiskScore++;
      foundSignals.push(`high-risk: "${signal}"`);
    }
  }

  for (const signal of TINY_SIGNALS) {
    if (lower.includes(signal)) {
      tinyScore++;
      foundSignals.push(`tiny: "${signal}"`);
    }
  }

  // Apply complexity multipliers
  let complexityMultiplier = 1.0;
  for (const [keyword, multiplier] of Object.entries(COMPLEXITY_MULTIPLIERS)) {
    if (lower.includes(keyword)) {
      complexityMultiplier = Math.max(complexityMultiplier, multiplier);
      foundSignals.push(`complexity: "${keyword}" (${multiplier}x)`);
    }
  }

  // Estimate hours based on description length and complexity
  const baseHours = Math.min(words.length / 10, 8); // Cap at 8 hours
  const estimatedHours = Math.round(baseHours * complexityMultiplier * 10) / 10;

  // Classification logic
  let classification;
  let reasoning;

  if (highRiskScore >= 2) {
    classification = 'high-risk';
    reasoning = `Multiple high-risk signals detected (${highRiskScore}). Requires ADR + story packet + mandatory review.`;
  } else if (highRiskScore >= 1 && estimatedHours > 2) {
    classification = 'high-risk';
    reasoning = `High-risk signal detected with significant complexity (${estimatedHours}h estimated). Requires ADR + story packet + mandatory review.`;
  } else if (estimatedHours > 4) {
    classification = 'high-risk';
    reasoning = `Estimated time exceeds 4 hours (${estimatedHours}h). Requires ADR + story packet + mandatory review.`;
  } else if (tinyScore >= 2 && highRiskScore === 0) {
    classification = 'tiny';
    reasoning = `Multiple tiny signals (${tinyScore}), no risk signals. Straight to code.`;
  } else if (words.length <= 5 && highRiskScore === 0 && tinyScore >= 1) {
    classification = 'tiny';
    reasoning = `Simple, short description with tiny signals and no risk. Straight to code.`;
  } else if (estimatedHours < 0.5 && highRiskScore === 0 && tinyScore >= 1) {
    classification = 'tiny';
    reasoning = `Quick fix (< 30 min) with tiny signals. Straight to code.`;
  } else {
    classification = 'normal';
    reasoning = `Standard feature (${estimatedHours}h estimated). Requires story packet with acceptance criteria.`;
  }

  return {
    classification,
    reasoning,
    estimatedHours,
    signals: foundSignals,
    adrTriggers,
    adrRequired: adrTriggers.length > 0 || classification === 'high-risk',
    scores: {
      highRisk: highRiskScore,
      tiny: tinyScore,
      complexityMultiplier
    }
  };
}

// CLI interface
if (import.meta.url === `file://${process.argv[1]}`) {
  const description = process.argv[2];

  if (!description) {
    console.error('Usage: node classify.mjs "feature description"');
    process.exit(1);
  }

  const result = classify(description);
  console.log(JSON.stringify(result, null, 2));
}

export { classify };

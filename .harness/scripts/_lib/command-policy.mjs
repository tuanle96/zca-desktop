const PLACEHOLDER_COMMAND_RE = /^(tbd|todo|n\/a|na|fill me|replace me)$/i;

const RISKY_PROOF_COMMANDS = [
  { id: "git-push", pattern: /(^|[\s;&|])git\s+push(?:\s|$)/i },
  { id: "git-reset-hard", pattern: /(^|[\s;&|])git\s+reset(?:\s+[^\n;&|]+)*\s+--hard(?:\s|$)/i },
  { id: "git-clean-force", pattern: /(^|[\s;&|])git\s+clean(?:\s+-[^\n;&|]*f[^\n;&|]*)(?:\s|$)/i },
  { id: "no-verify", pattern: /(^|[\s;&|])--no-verify(?:\s|$)/i },
  { id: "recursive-rm", pattern: /(^|[\s;&|])rm\s+-[^\n;&|]*r[^\n;&|]*(?:\s|$)/i },
  {
    id: "disable-harness-executable",
    pattern: /(^|[\s;&|])chmod\s+(?:-[Rrf]+\s+)?-[^\s]*x[^\s]*\s+(?:\.harness|\.claude)(?:\/|\s|$)/i,
  },
];

export function concreteCommand(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (PLACEHOLDER_COMMAND_RE.test(trimmed)) return "";
  return trimmed;
}

export function findRiskyProofCommand(value) {
  const text = concreteCommand(value);
  if (!text) return null;
  return RISKY_PROOF_COMMANDS.find(({ pattern }) => pattern.test(text)) || null;
}

export function validateProofCommand(value, { prefix = "command", requireConcrete = true, context = "proof commands" } = {}) {
  const errors = [];
  const text = concreteCommand(value);
  if (!text) {
    if (requireConcrete) errors.push(`${prefix} must be a concrete command`);
    return errors;
  }
  if (findRiskyProofCommand(text)) {
    errors.push(`${prefix} uses a risky command that is not allowed in ${context}`);
  }
  return errors;
}

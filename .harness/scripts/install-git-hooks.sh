#!/usr/bin/env bash
# Install .harness/scripts/pre-push.sh as the git pre-push hook for this repo.
set -e

if [ ! -d .git ]; then
  echo "Not a git repo — run this script from the repo root." >&2
  exit 1
fi

mkdir -p .git/hooks

cat > .git/hooks/pre-push <<'HOOK'
#!/usr/bin/env bash
exec bash .harness/scripts/pre-push.sh "$@"
HOOK
chmod +x .git/hooks/pre-push

echo "✓ git pre-push hook installed (delegates to .harness/scripts/pre-push.sh)"

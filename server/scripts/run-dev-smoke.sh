#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

docker compose -f docker-compose.dev.yml up -d postgres minio mailhog create-bucket

for _ in $(seq 1 80); do
  if docker compose -f docker-compose.dev.yml exec -T postgres pg_isready -U zca -d zca_cloud >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done

for _ in $(seq 1 80); do
  if curl -fsS "http://127.0.0.1:37885/api/v2/messages" >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done

export DATABASE_URL="${DATABASE_URL:-postgres://zca:zca@127.0.0.1:37881/zca_cloud}"
export ZCA_CLOUD_BIND="${ZCA_CLOUD_BIND:-127.0.0.1:37880}"
export ZCA_CLOUD_DEV_RETURN_MAGIC_TOKENS=1
export ZCA_CLOUD_PUBLIC_BASE_URL="${ZCA_CLOUD_PUBLIC_BASE_URL:-http://${ZCA_CLOUD_BIND}}"
export ZCA_CLOUD_MASTER_KEY="${ZCA_CLOUD_MASTER_KEY:-dev-smoke-master-key-change-me}"
export ZCA_CLOUD_OBJECT_STORE=s3
export ZCA_CLOUD_S3_ENDPOINT="${ZCA_CLOUD_S3_ENDPOINT:-http://127.0.0.1:37882}"
export ZCA_CLOUD_S3_ALLOW_HTTP=1
export ZCA_CLOUD_S3_BUCKET="${ZCA_CLOUD_S3_BUCKET:-zca-cloud-dev}"
export AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-zca}"
export AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-zca-password}"

docker compose -f docker-compose.dev.yml exec -T postgres psql -U zca -d zca_cloud >/dev/null <<SQL
DROP SCHEMA public CASCADE;
CREATE SCHEMA public;
SQL

ZCA_CLOUD_MIGRATE_ONLY=1 cargo run --manifest-path Cargo.toml >/tmp/zca-cloud-server-migrate.log 2>&1
ZCA_CLOUD_MIGRATE_DOWN_ONLY=1 cargo run --manifest-path Cargo.toml >/tmp/zca-cloud-server-migrate-down.log 2>&1
if docker compose -f docker-compose.dev.yml exec -T postgres psql -U zca -d zca_cloud -tAc "SELECT to_regclass('public.users')" | grep -q users; then
  echo "expected migration down to drop users table" >&2
  exit 1
fi
ZCA_CLOUD_MIGRATE_ONLY=1 cargo run --manifest-path Cargo.toml >/tmp/zca-cloud-server-migrate.log 2>&1
export ZCA_CLOUD_MIGRATION_ROUNDTRIP_PROVED=1

broken_user_id="00000000-0000-4000-8000-000000000101"
broken_account_id="00000000-0000-4000-8000-000000000202"
docker compose -f docker-compose.dev.yml exec -T postgres psql -U zca -d zca_cloud >/dev/null <<SQL
INSERT INTO users
    (id, email, recovery_key_hash, wrapped_data_key, server_key_nonce, server_wrapped_data_key)
VALUES
    ('$broken_user_id', 'restore-broken@example.com', 'invalid-hash',
     decode('00', 'hex'),
     decode('000000000000000000000000', 'hex'),
     decode('00', 'hex'))
ON CONFLICT (email) DO NOTHING;

INSERT INTO cloud_accounts
    (id, user_id, zalo_account_id, display_name, state, enc_credentials, credentials_nonce)
VALUES
    ('$broken_account_id', '$broken_user_id', 'restore-broken-zalo', 'Restore Broken', 'active',
     decode('00', 'hex'),
     decode('000000000000000000000000', 'hex'))
ON CONFLICT (user_id, zalo_account_id) DO UPDATE SET
    state = 'active',
    enc_credentials = excluded.enc_credentials,
    credentials_nonce = excluded.credentials_nonce,
    updated_at = now();
SQL

server_pid=""
cleanup() {
  if [[ -n "$server_pid" ]]; then
    kill "$server_pid" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

wait_for_health() {
  for _ in $(seq 1 80); do
    if curl -fsS "http://${ZCA_CLOUD_BIND}/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.25
  done
  echo "server did not become healthy" >&2
  return 1
}

start_server() {
  local log_path="$1"
  cargo run --manifest-path Cargo.toml > "$log_path" 2>&1 &
  server_pid=$!
  wait_for_health
}

stop_server() {
  if [[ -n "$server_pid" ]]; then
    kill "$server_pid" >/dev/null 2>&1 || true
    wait "$server_pid" >/dev/null 2>&1 || true
    server_pid=""
  fi
  if curl -fsS "http://${ZCA_CLOUD_BIND}/health" >/dev/null 2>&1; then
    for _ in $(seq 1 40); do
      if ! curl -fsS "http://${ZCA_CLOUD_BIND}/health" >/dev/null 2>&1; then
        return 0
      fi
      sleep 0.25
    done
  fi
}

start_server /tmp/zca-cloud-server-smoke.log

restored_state="$(docker compose -f docker-compose.dev.yml exec -T postgres psql -U zca -d zca_cloud -tAc "SELECT state FROM cloud_accounts WHERE id = '$broken_account_id'")"
if [[ "$restored_state" != "reauth-needed" ]]; then
  echo "expected broken restore account to become reauth-needed, got: $restored_state" >&2
  exit 1
fi
export ZCA_CLOUD_REAUTH_RESTORE_PROVED=1

tmp_smoke_json="$(mktemp)"
ZCA_CLOUD_BASE_URL="http://${ZCA_CLOUD_BIND}" node scripts/smoke-dev.mjs > "$tmp_smoke_json"

audit_count="$(docker compose -f docker-compose.dev.yml exec -T postgres psql -U zca -d zca_cloud -tAc "SELECT count(*) FROM audit_events WHERE event_kind IN ('magic_link_requested', 'magic_link_rate_limited', 'magic_link_verified_device_registered', 'device_recovery_key_required', 'device_revoked')")"
if [[ "$audit_count" -lt 5 ]]; then
  echo "expected auth/device audit events, got: $audit_count" >&2
  exit 1
fi

ZCA_CLOUD_AUDIT_EVENTS_PROVED=1 node - "$tmp_smoke_json" <<'JS'
const fs = require("node:fs");
const path = process.argv[2];
const body = JSON.parse(fs.readFileSync(path, "utf8"));
body.auditEventsProved = process.env.ZCA_CLOUD_AUDIT_EVENTS_PROVED === "1";
body.migrationRoundtripProved = process.env.ZCA_CLOUD_MIGRATION_ROUNDTRIP_PROVED === "1";
fs.writeFileSync(path, JSON.stringify(body, null, 2));
JS

stop_server
export ZCA_CLOUD_DEV_RETURN_MAGIC_TOKENS=0
export ZCA_CLOUD_SMTP_ADDR="${ZCA_CLOUD_SMTP_ADDR:-127.0.0.1:37884}"
export ZCA_CLOUD_MAGIC_LINK_FROM="${ZCA_CLOUD_MAGIC_LINK_FROM:-ZCA Cloud <no-reply@zca.local>}"

tmp_mailhog_json="$(mktemp)"
start_server /tmp/zca-cloud-server-mailhog-smoke.log
ZCA_CLOUD_BASE_URL="http://${ZCA_CLOUD_BIND}" \
  ZCA_CLOUD_MAILHOG_API="http://127.0.0.1:37885" \
  node scripts/smoke-mailhog.mjs > "$tmp_mailhog_json"

node - "$tmp_smoke_json" "$tmp_mailhog_json" <<'JS'
const fs = require("node:fs");
const devSmoke = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const mailhogSmoke = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
console.log(JSON.stringify({
  ...devSmoke,
  mailhogProvider: mailhogSmoke,
  providerLiveProved: mailhogSmoke.sentViaMailHog === true && mailhogSmoke.devMagicTokenReturned === false,
}, null, 2));
JS

# zca-cloud-server

Cloud backend for the Zalo desktop client — hosts Zalo sessions, syncs conversations, and
mirrors media. Built with **Rust** (axum + sqlx) on **Postgres** + **S3-compatible** storage.
Default port **37880**; database migrations run automatically on boot.

## Dev (hot-reload)

Brings up the infra (Postgres + MinIO) and the server, rebuilding on every change.
Login-code emails are sent with Resend from `apps/server/.env`:

```bash
ZCA_CLOUD_RESEND_API_KEY=re_...
ZCA_CLOUD_MAGIC_LINK_FROM="ZCA Cloud <no-reply@zca.tuanle.dev>"
ZCA_CLOUD_PUBLIC_BASE_URL=https://zca.tuanle.dev
```

```bash
docker compose -f docker-compose.dev.yml up -d --build
docker compose -f docker-compose.dev.yml logs -f server   # watch rebuilds
docker compose -f docker-compose.dev.yml down
```

Edit any `.rs` under `src/` -> `cargo-watch` rebuilds and restarts in a few seconds.
The direct API token return flag (`ZCA_CLOUD_DEV_RETURN_MAGIC_TOKENS=1`) is only
for trusted loopback-native debugging and is intentionally not enabled in the
compose service.

> Prefer running native? `docker compose -f docker-compose.dev.yml up -d postgres minio create-bucket`, then `cargo run` with the matching env.

## Deploy (prod)

Runs **only** the compiled server; Postgres and S3 are external managed services.

```bash
cp .env.prod.example .env     # fill in real values (never commit .env)
docker compose -f docker-compose.prod.yml up -d --build
```

Compose refuses to start if a required variable is missing. The server ships a `/health`
healthcheck, `restart: always`, and log rotation. To deploy on another host, point `image:`
at your registry and `docker compose -f docker-compose.prod.yml push`.

### Environment

**Required**

| Variable | Description |
|---|---|
| `DATABASE_URL` | External Postgres, e.g. `postgres://user:pass@host:5432/zca_cloud` |
| `ZCA_CLOUD_PUBLIC_BASE_URL` | Public URL clients & login-code emails use to reach the server |
| `ZCA_CLOUD_MASTER_KEY` | Encryption seed — strong & unique; **changing it makes stored data unreadable** (`openssl rand -base64 48`) |
| `ZCA_CLOUD_S3_BUCKET` | Object storage bucket |
| `ZCA_CLOUD_S3_ENDPOINT` | S3 endpoint (carries the region), e.g. `https://s3.ap-southeast-1.amazonaws.com` |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | S3 credentials |

**Recommended**

| Variable | Default | Description |
|---|---|---|
| `ZCA_CLOUD_RESEND_API_KEY` | — | Resend API key for production login-code email delivery; preferred over SMTP/webhook when set |
| `ZCA_CLOUD_SMTP_ADDR` | — | SMTP fallback `host:port` for sending login codes |
| `ZCA_CLOUD_MAGIC_LINK_FROM` | `ZCA Cloud <no-reply@zca.local>` | From address for login-code emails |

**Optional**

| Variable | Default | Description |
|---|---|---|
| `ZCA_CLOUD_PORT` | `37880` | Host port to publish (compose-only) |
| `ZCA_CLOUD_BIND` | `127.0.0.1:37880` | Bind address (compose sets `0.0.0.0:37880`) |
| `ZCA_CLOUD_OBJECT_STORE` | — | Set to `s3` to use S3 (compose does this; otherwise in-memory) |
| `ZCA_CLOUD_DEV_RETURN_MAGIC_TOKENS` | `0` | Return login codes in API responses — **dev only** |
| `ZCA_CLOUD_S3_ALLOW_HTTP` | `0` | Allow plain-HTTP S3 (internal MinIO only) |
| `ZCA_CLOUD_MAGIC_LINK_WEBHOOK_URL` | — | Webhook delivery fallback as an alternative to Resend/SMTP |
| `ZCA_CLOUD_MAGIC_LINK_TTL_SECS` | `600` | Login-code lifetime |
| `ZCA_CLOUD_MAGIC_LINK_RATE_LIMIT` | `5` | Max code requests per rate window |
| `ZCA_CLOUD_MAGIC_LINK_RATE_WINDOW_SECS` | `900` | Rate-limit window |
| `ZCA_CLOUD_MEDIA_MIRROR_MAX_BYTES` | `26214400` | Max mirrored media size (25 MiB) |

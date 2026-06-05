# zca dev tunnel (Cloudflare)

Exposes the local dev stack on public `*.tuanle.dev` subdomains via a Cloudflare
named tunnel — handy for testing magic-link emails with a real URL, the mobile
client against a public server, and webhooks. Mirrors the `lms-next` setup.

| Hostname | → service | Why |
|---|---|---|
| `zca.tuanle.dev` | cloud server (`:37880`) | the `/api/v1` API the clients hit |
| `mail-zca.tuanle.dev` | MailHog UI (`:8025`) | read magic-link emails |
| `minio-zca.tuanle.dev` | MinIO S3 (`:9000`) | media / pre-signed URLs |

Credentials live in `$HOME/.cloudflared/` and are **never committed** (this dir's
`.gitignore` blocks `*.json` / `*.pem`); only the `config*.yml` are in the repo.

## One-time setup (your Cloudflare account)

```bash
cloudflared tunnel login                       # browser auth → ~/.cloudflared/cert.pem
cloudflared tunnel create zca-dev              # prints the tunnel UUID + writes ~/.cloudflared/<UUID>.json
cloudflared tunnel route dns zca-dev zca.tuanle.dev
cloudflared tunnel route dns zca-dev mail-zca.tuanle.dev
cloudflared tunnel route dns zca-dev minio-zca.tuanle.dev
```

Then put the UUID where the configs expect it:
- `config.local.yml` → replace `<TUNNEL_UUID>` in `credentials-file`.
- Docker → export `ZCA_TUNNEL_UUID=<UUID>` (used by the compose volume mount).

## Run

**Via Docker (recommended — routes to compose service names):**
```bash
# from the repo root; bring up the stack first, then the tunnel profile
docker compose -f apps/server/docker-compose.dev.yml up -d --build
ZCA_TUNNEL_UUID=<UUID> ZCA_CLOUD_PUBLIC_BASE_URL=https://zca.tuanle.dev \
  docker compose -f apps/server/docker-compose.dev.yml --profile tunnel up -d cloudflared-zca
```
Set `ZCA_CLOUD_PUBLIC_BASE_URL=https://zca.tuanle.dev` so magic-link emails point at
the public domain (defaults to `http://127.0.0.1:37880` without it).

**Natively on the host (routes to published localhost ports):**
```bash
cloudflared tunnel --config cloudflared/zca-dev/config.local.yml run zca-dev
```

## Validate

```bash
cloudflared tunnel --config cloudflared/zca-dev/config.local.yml ingress validate
curl -fsS  https://zca.tuanle.dev/health
curl -fsSI https://mail-zca.tuanle.dev/
```

## This deployment (verified live)

- Tunnel **`zca-dev`** = `98071e8c-71ab-4b27-a247-c3c517cd3cc5`, creds at
  `~/.cloudflared/98071e8c-….json`. `ZCA_TUNNEL_UUID=98071e8c-71ab-4b27-a247-c3c517cd3cc5`.
- Confirmed 200: `zca.tuanle.dev`→server, `mail-zca.tuanle.dev`→MailHog,
  `minio-zca.tuanle.dev`→MinIO.

### Gotcha — `route dns` hijack
`~/.cloudflared/config.yml` defaults `tunnel:` to another tunnel (`mbp-ssh`), so a
bare `cloudflared tunnel route dns zca-dev <host>` routes to the WRONG tunnel (and
`-f` won't repoint a record already on one of your tunnels). Bypass the default
config and target by UUID:

```bash
cloudflared --config /dev/null tunnel route dns --overwrite-dns \
  98071e8c-71ab-4b27-a247-c3c517cd3cc5 zca.tuanle.dev
```


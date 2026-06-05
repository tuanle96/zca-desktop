# zca dev tunnel (Cloudflare)

Exposes the local dev stack on public hostnames via a Cloudflare named tunnel.
This is useful for testing magic-link emails with a real URL, the mobile client
against a public server, and webhooks.

| Hostname | → service | Why |
|---|---|---|
| `zca.example.com` | cloud server (`:37880`) | the `/api/v1` API the clients hit |
| `mail-zca.example.com` | MailHog UI (`:8025`) | read magic-link emails |
| `minio-zca.example.com` | MinIO S3 (`:9000`) | media / pre-signed URLs |

Credentials live in `$HOME/.cloudflared/` and are **never committed**. The local
host config is `config.local.yml`, which is gitignored; commit only example
configs with placeholder hostnames and tunnel IDs.

## One-time setup (your Cloudflare account)

```bash
cloudflared tunnel login                       # browser auth → ~/.cloudflared/cert.pem
cloudflared tunnel create zca-dev              # prints the tunnel UUID + writes ~/.cloudflared/<UUID>.json
cloudflared tunnel route dns zca-dev zca.example.com
cloudflared tunnel route dns zca-dev mail-zca.example.com
cloudflared tunnel route dns zca-dev minio-zca.example.com
```

Then put the UUID where the configs expect it:
- Native host runs: copy `config.local.example.yml` to `config.local.yml`, then
  replace the tunnel, credentials path, and hostnames.
- Docker → export `ZCA_TUNNEL_UUID=<UUID>` (used by the compose volume mount).

## Run

**Via Docker (recommended — routes to compose service names):**
```bash
# from the repo root; bring up the stack first, then the tunnel profile
docker compose -f apps/server/docker-compose.dev.yml up -d --build
ZCA_TUNNEL_UUID=<UUID> ZCA_CLOUD_PUBLIC_BASE_URL=https://zca.example.com \
  docker compose -f apps/server/docker-compose.dev.yml --profile tunnel up -d cloudflared-zca
```
Set `ZCA_CLOUD_PUBLIC_BASE_URL=https://zca.example.com` so magic-link emails point at
the public domain (defaults to `http://127.0.0.1:37880` without it).

**Natively on the host (routes to published localhost ports):**
```bash
cp cloudflared/zca-dev/config.local.example.yml cloudflared/zca-dev/config.local.yml
$EDITOR cloudflared/zca-dev/config.local.yml
cloudflared tunnel --config cloudflared/zca-dev/config.local.yml run zca-dev
```

## Validate

```bash
cloudflared tunnel --config cloudflared/zca-dev/config.local.yml ingress validate
curl -fsS  https://zca.example.com/health
curl -fsSI https://mail-zca.example.com/
```

## Public-repo hygiene

Do not commit real tunnel UUIDs, credential paths, or personal hostnames. If a
real tunnel UUID or hostname was committed before publication, recreate or rotate
the tunnel in Cloudflare and update only your gitignored local config.

### Gotcha — `route dns` hijack
`~/.cloudflared/config.yml` may default `tunnel:` to another tunnel, so a bare
`cloudflared tunnel route dns zca-dev <host>` can route to the wrong tunnel.
Bypass the default config and target by UUID:

```bash
cloudflared --config /dev/null tunnel route dns --overwrite-dns \
  <TUNNEL_UUID> zca.example.com
```

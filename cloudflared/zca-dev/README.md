# zca dev tunnel (Cloudflare)

Exposes the local dev stack on public hostnames via a Cloudflare named tunnel.
This is useful for testing magic-link emails with a real URL, the mobile client
against a public server, and webhooks.

| Hostname | → service | Why |
|---|---|---|
| `zca.tuanle.dev` | cloud server (`:37880`) | the `/api/v1` API the clients hit |

Credentials live in `$HOME/.cloudflared/` and are **never committed**. The local
host config is `config.local.yml`, which is gitignored; commit only example
configs without real tunnel IDs or credential paths.

MailHog and MinIO helper hostnames are intentionally not present in the
committed tunnel ingress. Keep those services on localhost, or add them only to
your gitignored `config.local.yml` behind Cloudflare Access or another auth
layer for short-lived dev testing.

## One-time setup (your Cloudflare account)

```bash
cloudflared tunnel login                       # browser auth → ~/.cloudflared/cert.pem
cloudflared tunnel create zca-dev              # prints the tunnel UUID + writes ~/.cloudflared/<UUID>.json
cloudflared --config /dev/null tunnel route dns --overwrite-dns <TUNNEL_UUID> zca.tuanle.dev
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
ZCA_TUNNEL_UUID=<UUID> ZCA_CLOUD_PUBLIC_BASE_URL=https://zca.tuanle.dev \
  docker compose -f apps/server/docker-compose.dev.yml --profile tunnel up -d cloudflared-zca
```
Set `ZCA_CLOUD_PUBLIC_BASE_URL=https://zca.tuanle.dev` so magic-link emails point at
the public domain.

**Natively on the host (routes to published localhost ports):**
```bash
cp cloudflared/zca-dev/config.local.example.yml cloudflared/zca-dev/config.local.yml
$EDITOR cloudflared/zca-dev/config.local.yml
cloudflared tunnel --config cloudflared/zca-dev/config.local.yml run zca-dev
```

## Validate

```bash
cloudflared tunnel --config cloudflared/zca-dev/config.local.yml ingress validate
curl -fsS  https://zca.tuanle.dev/health
```

## Public-repo hygiene

Do not commit real tunnel UUIDs or credential paths. MailHog and MinIO helper
hosts are for local development only; do not expose them publicly for production
unless they are protected by Cloudflare Access or another auth layer.

### Gotcha — `route dns` hijack
`~/.cloudflared/config.yml` may default `tunnel:` to another tunnel, so a bare
`cloudflared tunnel route dns zca-dev <host>` can route to the wrong tunnel.
Bypass the default config and target by UUID:

```bash
cloudflared --config /dev/null tunnel route dns --overwrite-dns \
  <TUNNEL_UUID> zca.tuanle.dev
```

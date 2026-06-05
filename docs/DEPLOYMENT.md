# Deployment Checklist

The cloud backend can be deployed with Docker Compose, external Postgres, and
S3-compatible object storage. Do not deploy the dev stack as-is to production.

## Required production inputs

- `DATABASE_URL`: external Postgres connection string.
- `ZCA_CLOUD_PUBLIC_BASE_URL`: public HTTPS URL for clients and magic-link emails.
- `ZCA_CLOUD_MASTER_KEY`: strong unique secret, at least 32 characters.
- `ZCA_CLOUD_S3_BUCKET`: object storage bucket.
- `ZCA_CLOUD_S3_ENDPOINT`: S3 endpoint/region URL.
- `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`: object storage credentials.

Generate the master key with a high-entropy source:

```bash
openssl rand -base64 48
```

## Production checklist

- Use HTTPS at the public edge.
- Set `ZCA_CLOUD_DEV_RETURN_MAGIC_TOKENS=0`.
- Configure SMTP or a private magic-link webhook.
- Set explicit `ZCA_CLOUD_ALLOWED_ORIGINS` only if a browser app needs CORS.
- Keep Postgres, S3, SMTP, and Cloudflare credentials out of Git.
- Do not expose MailHog, MinIO consoles, or dev-only tunnel configs publicly.
- Enable log rotation and monitor server errors.
- Back up Postgres and object storage together so encrypted metadata and blobs
  remain consistent.
- Document how users can revoke devices and request data deletion.

## Dev tunnels

Cloudflare tunnel credentials belong in `$HOME/.cloudflared` or another private
secret store. Commit only placeholder examples:

- `cloudflared/zca-dev/config.yml`
- `cloudflared/zca-dev/config.local.example.yml`

`cloudflared/zca-dev/config.local.yml` is gitignored and may contain local
hostnames, tunnel IDs, and credential paths.

If a real tunnel UUID, hostname, or credentials path was committed before public
release, recreate or rotate the tunnel in Cloudflare before relying on it.

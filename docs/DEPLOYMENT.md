# Deployment Checklist

The cloud backend can be deployed with Docker Compose, external Postgres, and
S3-compatible object storage. Do not deploy the dev stack as-is to production.

## Required production inputs

- `DATABASE_URL`: external Postgres connection string.
- `ZCA_CLOUD_PUBLIC_BASE_URL`: public HTTPS URL for clients and magic-link emails.
  Production defaults should use `https://zca.tuanle.dev`.
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
- Configure Resend, SMTP, or a private magic-link webhook.
- Set explicit `ZCA_CLOUD_ALLOWED_ORIGINS` only if a browser app needs CORS.
- Keep Postgres, S3, Resend, SMTP, and Cloudflare credentials out of Git.
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

## Magic-link email delivery

Cloudflare Email Routing is for inbound forwarding only; it does not provide an
SMTP server for outbound application mail. Cloudflare Email Service can send
transactional mail for a Cloudflare-managed domain, but it sends through the
Cloudflare REST API or Workers binding, not through SMTP.

For ZCA production login-code delivery, use one of these:

- Resend API delivery, preferred for production:
  `ZCA_CLOUD_RESEND_API_KEY=re_...` and
  `ZCA_CLOUD_MAGIC_LINK_FROM=ZCA Cloud <no-reply@zca.tuanle.dev>`.
  Verify `tuanle.dev` in Resend before sending from `@zca.tuanle.dev`.
- A conventional SMTP provider configured with `ZCA_CLOUD_SMTP_ADDR`,
  `ZCA_CLOUD_SMTP_USERNAME`, `ZCA_CLOUD_SMTP_PASSWORD`, and
  `ZCA_CLOUD_MAGIC_LINK_FROM=no-reply@zca.tuanle.dev`.
- A private `ZCA_CLOUD_MAGIC_LINK_WEBHOOK_URL` relay that receives
  `{ email, magicLink, expiresInSecs }` and calls Cloudflare Email Service's
  REST API.

Provider order is Resend first, then SMTP, then webhook. Do not expose
`ZCA_CLOUD_RESEND_API_KEY` to desktop or mobile client builds.

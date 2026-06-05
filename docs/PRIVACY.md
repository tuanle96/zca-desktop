# Privacy and Data Handling

zca-desktop is an unofficial personal-use client. It can process sensitive Zalo
account data, including contacts, conversations, message metadata, message
content, media references, and account/session credentials.

## Local desktop data

The desktop app may store:

- Account profile metadata.
- Conversation and message history.
- Contact/group metadata.
- Encrypted credential blobs.
- Diagnostic logs.

Local data is stored under the OS app data directory. Credential material is
encrypted before persistence and the master key is held by the OS keychain.

## Cloud backend data

When using the cloud backend, the server may store:

- User email addresses for magic-link sign-in.
- Linked device records and hashed device tokens.
- Hosted Zalo account metadata.
- Encrypted hosted account credentials.
- Conversation/message metadata and encrypted message fields.
- Mirrored media metadata and object blobs.
- Audit events for security-sensitive actions.

Object storage and Postgres are deployment-controlled. Operators are responsible
for backup, retention, access control, and deletion policies.

## Logs

The desktop core redacts common secret keys and cookie/token fields in raw API
captures by default. `ZCA_LOG_RAW=1` disables redaction and should only be used
for short local debugging sessions on a trusted machine.

The frontend logger records UI messages as-is. Do not log secrets in UI code.

## Data deletion

Deleting a local desktop account should remove the local persisted account and
encrypted credential. Cloud operators should provide a separate process for
deleting server-side users, devices, hosted accounts, mirrored media, and backups.

## Third parties

This project is not affiliated with Zalo or VNG. It communicates with
undocumented Zalo endpoints through the unofficial `zca-rust` client. Deployments
may also use third-party infrastructure such as SMTP providers, object storage,
Postgres hosting, and Cloudflare tunnels.

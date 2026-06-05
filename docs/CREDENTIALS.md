# Credential Handling

Zalo credentials are bearer tokens. A credential set contains:

- `imei`
- Zalo cookies
- `userAgent`
- `language`

Anyone with a valid credential set may be able to act as that Zalo session. Treat
these values like passwords.

## Rules

- Never commit real credentials.
- Never paste credentials into issues, pull requests, logs, screenshots, or chat.
- Never print full cookies, `imei`, device tokens, magic-link tokens, or recovery
  keys.
- Use `.zalo-cred.example.json` only as a placeholder template.
- Use `.zalo-cred.json` only for local ignored live tests.

## Desktop storage

The desktop app stores credentials encrypted at rest:

- A master key is kept in the OS keychain.
- Credential blobs are encrypted with AES-256-GCM before going into SQLite.
- The webview receives account metadata and status, not the raw credential set.

## Cloud storage

The cloud backend stores hosted account credentials under per-user encryption.
`ZCA_CLOUD_MASTER_KEY` is required and must be strong and unique. Changing it can
make existing encrypted data unreadable.

## Live tests

Ignored live tests may use real credentials and may send real messages. They must
be run explicitly and require operator-supplied environment variables:

```bash
ZALO_TEST_PHONE=<authorized-recipient-phone> \
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml -- --ignored send_text_live --nocapture
```

No live test should hard-code a real phone number, account ID, cookie, or tunnel
identifier.

## If a credential leaks

1. Stop using the leaked credential immediately.
2. Log out affected Zalo sessions from official clients where possible.
3. Rotate or recreate any cloud device tokens, recovery keys, tunnel credentials,
   and server secrets that may have been exposed.
4. Remove the value from Git history before publishing mirrors or archives.
5. Report the incident privately through GitHub private vulnerability reporting.

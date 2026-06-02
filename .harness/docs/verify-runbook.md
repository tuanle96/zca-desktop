# Live verification runbook (device-only steps)

What I (agent) already proved on this machine, and the exact steps left for you,
plus how to read the logs to confirm each one.

## Already proven (attested, offline + local keychain)

- `cargo build` / `cargo clippy --all-targets -D warnings` / `cargo test`
  (23 passed, 8 ignored) — green.
- **Keychain + AES-256-GCM credential roundtrip** — PROVEN live on the real
  macOS keychain: `cred_store_roundtrip OK: ciphertext on disk, decrypts in
  memory`. Attested in `.harness/evidence/secure-cred-store.json` (check `smoke`).

## Where the logs are

```
~/Library/Application Support/zca-desktop/logs/
  zca-desktop.log.<YYYY-MM-DD>   # structured events (this is the one to read)
  raw-<YYYY-MM-DD>.log           # raw API captures (redacted by default)
```

Tail the event log live while testing:

```bash
tail -f "$HOME/Library/Application Support/zca-desktop/logs/zca-desktop.log."*
```

For deep debugging with UNREDACTED raw payloads (local only):

```bash
ZCA_LOG=debug ZCA_LOG_RAW=1 bun run tauri dev
```

(Default `bun run tauri dev` already logs at info + redacted raw.)

## Step A — QR login end-to-end (qr-login)

1. `bun run tauri dev` (or your normal dev launch).
2. Scan the QR with your phone and confirm.
3. Expect the app to reach the chat shell ("đang lắng nghe").

Verify in `zca-desktop.log.*`:

```
start_qr_login: beginning interactive QR login
qr: cookies extracted from jar count=6 names=[..., "zpw_sek", ...]   <- zpw_sek MUST be present
start_qr_login: QR confirmed, establishing session
start_qr_login: session established account_id=...
persisted account credential account_id=...
```

Pass = `session established` + `persisted account credential`, and the cookie
names include `zpw_sek`.

## Step B — Session restore (secure-cred-store)

1. After Step A, fully quit the app.
2. Relaunch.
3. Expect: brief "Đang khôi phục phiên đăng nhập…" then the chat shell — NO QR.

Verify in the log:

```
local store opened ... saved_accounts=1        <- persistence happened
restore_sessions: restoring saved accounts count=1
start_qr_login is NOT called
restore_sessions: restore complete restored=1
```

Pass = `restored=1` and no QR screen.

## Step C — Message history survives restart (message-cache)

1. While logged in, receive and/or send a few messages.
2. Quit and relaunch (restore runs).
3. Expect the conversations + their messages to appear immediately.

Verify in the log:

```
persisted incoming message account_id=... thread_id=... msg_id=... body_len=NN
persisted outgoing message ...                 (if you sent one)
load_history: hydrated persisted history threads=N messages=M    <- N,M > 0 after relaunch
```

Pass = `load_history ... threads>0 messages>0` and the chat list is populated
before any new realtime message arrives.

## After you confirm

Paste the relevant log lines (they are non-secret) back to me. I will:
- flip the three reviewer decisions to `pass`,
- set evidence `status: pass` for `secure-cred-store` (+ author `qr-login` and
  `message-cache` bundles with your captured smoke),
- set `passes: true` for the proven features,
- run the readiness gate to green and commit.

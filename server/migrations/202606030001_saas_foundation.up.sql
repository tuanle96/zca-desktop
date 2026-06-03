CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT NOT NULL UNIQUE,
    recovery_key_hash TEXT NOT NULL,
    wrapped_data_key BYTEA NOT NULL,
    server_key_nonce BYTEA NOT NULL,
    server_wrapped_data_key BYTEA NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE magic_links (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX magic_links_email_idx ON magic_links(email);

CREATE TABLE devices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ
);

CREATE INDEX devices_user_id_idx ON devices(user_id);

CREATE TABLE cloud_accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    zalo_account_id TEXT NOT NULL,
    display_name TEXT,
    avatar TEXT,
    state TEXT NOT NULL DEFAULT 'reauth-needed',
    enc_credentials BYTEA,
    credentials_nonce BYTEA,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(user_id, zalo_account_id)
);

CREATE TABLE conversations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    account_id UUID NOT NULL REFERENCES cloud_accounts(id) ON DELETE CASCADE,
    thread_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    title TEXT,
    avatar TEXT,
    last_at TIMESTAMPTZ,
    unread INTEGER NOT NULL DEFAULT 0,
    UNIQUE(account_id, thread_id)
);

CREATE INDEX conversations_user_id_idx ON conversations(user_id);

CREATE TABLE messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    account_id UUID NOT NULL REFERENCES cloud_accounts(id) ON DELETE CASCADE,
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    msg_id TEXT NOT NULL,
    from_id TEXT,
    from_name TEXT,
    enc_body BYTEA,
    body_nonce BYTEA,
    outgoing BOOLEAN NOT NULL DEFAULT false,
    kind TEXT NOT NULL DEFAULT 'text',
    z_ts TEXT,
    observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted BOOLEAN NOT NULL DEFAULT false,
    UNIQUE(account_id, msg_id)
);

CREATE INDEX messages_conversation_idx ON messages(conversation_id, observed_at);

CREATE TABLE files (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    account_id UUID REFERENCES cloud_accounts(id) ON DELETE SET NULL,
    conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
    message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
    object_key TEXT NOT NULL UNIQUE,
    filename TEXT,
    mime TEXT,
    size_bytes BIGINT NOT NULL,
    content_sha256 TEXT NOT NULL,
    enc_file_key BYTEA NOT NULL,
    file_key_nonce BYTEA NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX files_user_id_idx ON files(user_id);

CREATE TABLE hosted_sessions (
    account_id UUID PRIMARY KEY REFERENCES cloud_accounts(id) ON DELETE CASCADE,
    state TEXT NOT NULL,
    generation BIGINT NOT NULL DEFAULT 0,
    started_at TIMESTAMPTZ,
    stopped_at TIMESTAMPTZ,
    last_error TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE audit_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    device_id UUID REFERENCES devices(id) ON DELETE SET NULL,
    event_kind TEXT NOT NULL,
    subject_id TEXT,
    meta JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX audit_events_user_id_idx ON audit_events(user_id, created_at DESC);

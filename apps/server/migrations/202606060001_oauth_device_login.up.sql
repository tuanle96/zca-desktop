CREATE TABLE oauth_login_states (
    state_hash TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    device_name TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX oauth_login_states_expires_idx ON oauth_login_states(expires_at);

CREATE TABLE oauth_user_identities (
    provider TEXT NOT NULL,
    provider_subject TEXT NOT NULL,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    email_verified BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY(provider, provider_subject)
);

CREATE INDEX oauth_user_identities_user_id_idx ON oauth_user_identities(user_id);

CREATE TABLE oauth_desktop_codes (
    code_hash TEXT PRIMARY KEY,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    provider_subject TEXT NOT NULL,
    email TEXT NOT NULL,
    email_verified BOOLEAN NOT NULL DEFAULT false,
    device_name TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX oauth_desktop_codes_user_id_idx ON oauth_desktop_codes(user_id);
CREATE INDEX oauth_desktop_codes_expires_idx ON oauth_desktop_codes(expires_at);

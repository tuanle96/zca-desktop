-- Track which client started an OAuth login so the landing page can return into
-- the right app: desktop (loopback callback) vs mobile (zca:// deep link).
ALTER TABLE oauth_login_states ADD COLUMN platform TEXT;

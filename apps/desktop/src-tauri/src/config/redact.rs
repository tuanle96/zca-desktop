//! Secret redaction for logs and raw API captures (`config` layer).
//!
//! Zalo credentials and login-response secrets are bearer tokens. Any raw
//! payload we persist for debugging is redacted by default so a log file can be
//! attached to an issue without leaking a session. Redaction is applied to:
//!   - JSON values: keys whose (case-insensitive) name matches a secret field
//!     have their value replaced with a masked placeholder that preserves only
//!     the length, never the content.
//!   - free-form strings: `key=value` / `"key":"value"` pairs for known secret
//!     keys are masked.
//!
//! The opt-in `ZCA_LOG_RAW=1` path bypasses this for local-only deep debugging.

use serde_json::Value;

/// Case-insensitive substrings that mark a field as secret. Conservative and
/// broad on purpose: better to over-redact a log than to leak a bearer token.
const SECRET_KEY_MARKERS: [&str; 12] = [
    "imei",
    "cookie",
    "zpw_enk",
    "enk",
    "secret",
    "secret_key",
    "secretkey",
    "token",
    "zpsid",
    "zpw_sek",
    "session",
    "password",
];

/// True when a JSON/field key denotes a secret value that must be masked.
fn is_secret_key(key: &str) -> bool {
    let k = key.to_ascii_lowercase();
    SECRET_KEY_MARKERS.iter().any(|m| k.contains(m))
}

/// Replace a secret value with a length-preserving placeholder, never content.
fn mask(value_len: usize) -> String {
    format!("***redacted({value_len})***")
}

/// Recursively redact secret-keyed values in a JSON document. Non-secret values
/// are preserved so the structure stays useful for debugging.
pub fn redact_json(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut out = serde_json::Map::with_capacity(map.len());
            for (k, v) in map {
                if is_secret_key(k) {
                    out.insert(k.clone(), Value::String(mask(value_text_len(v))));
                } else {
                    out.insert(k.clone(), redact_json(v));
                }
            }
            Value::Object(out)
        }
        Value::Array(items) => Value::Array(items.iter().map(redact_json).collect()),
        other => other.clone(),
    }
}

/// Approximate the byte length of a JSON value for the masked placeholder,
/// without revealing its content.
fn value_text_len(v: &Value) -> usize {
    match v {
        Value::String(s) => s.len(),
        Value::Array(a) => a.len(),
        Value::Object(o) => o.len(),
        other => other.to_string().len(),
    }
}

/// Redact a raw string body. Attempts JSON redaction first (most Zalo payloads
/// are JSON); falls back to masking `key=value` / `"key":"value"` secret pairs
/// in free-form text.
pub fn redact_str(raw: &str) -> String {
    if let Ok(value) = serde_json::from_str::<Value>(raw) {
        return redact_json(&value).to_string();
    }
    redact_pairs(raw)
}

/// Best-effort masking of secret `key=value` and `key: value` pairs in plain
/// text (cookie headers, form bodies, log lines).
fn redact_pairs(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    // Split on common separators while preserving them, then mask any token of
    // the form `<secret-key><sep><value>`.
    for (i, segment) in raw.split(';').enumerate() {
        if i > 0 {
            out.push(';');
        }
        out.push_str(&mask_pair(segment));
    }
    out
}

fn mask_pair(segment: &str) -> String {
    // Handle `key=value`, `key: value`, and `"key":"value"`.
    for sep in ['=', ':'] {
        if let Some(idx) = segment.find(sep) {
            let (key_part, value_part) = segment.split_at(idx);
            let key = key_part.trim().trim_matches('"').trim();
            if is_secret_key(key) {
                let value = &value_part[sep.len_utf8()..];
                return format!("{key_part}{sep}{}", mask(value.trim().len()));
            }
        }
    }
    segment.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn masks_secret_json_keys_and_keeps_structure() {
        let input = json!({
            "imei": "device-imei-1234",
            "userAgent": "Mozilla/5.0",
            "cookie": [{ "name": "zpsid", "value": "supersecret" }],
            "uid": "100000",
            "nested": { "zpw_enk": "enk-value", "label": "keep-me" }
        });
        let out = redact_json(&input);

        // Secret scalars masked, never echoed.
        assert!(out["imei"].as_str().unwrap().starts_with("***redacted("));
        assert_ne!(out["imei"], json!("device-imei-1234"));
        assert!(out["nested"]["zpw_enk"]
            .as_str()
            .unwrap()
            .starts_with("***redacted("));
        // The whole `cookie` array is keyed as secret → masked wholesale.
        assert!(out["cookie"].as_str().unwrap().starts_with("***redacted("));
        // Non-secret fields preserved.
        assert_eq!(out["uid"], json!("100000"));
        assert_eq!(out["nested"]["label"], json!("keep-me"));

        // No secret substring leaks into the serialized output.
        let serialized = out.to_string();
        for leaked in ["device-imei-1234", "supersecret", "enk-value"] {
            assert!(!serialized.contains(leaked), "leaked secret: {leaked}");
        }
    }

    #[test]
    fn redacts_cookie_header_string() {
        let raw = "zpsid=abc123; zpw_sek=def456; path=/";
        let out = redact_str(raw);
        assert!(!out.contains("abc123"), "zpsid value leaked: {out}");
        assert!(!out.contains("def456"), "zpw_sek value leaked: {out}");
        assert!(
            out.contains("path=/"),
            "non-secret pair must survive: {out}"
        );
    }

    #[test]
    fn redact_str_handles_json_body() {
        let raw = r#"{"data":{"zpw_enk":"leaked-key","uid":"42"}}"#;
        let out = redact_str(raw);
        assert!(!out.contains("leaked-key"), "zpw_enk leaked: {out}");
        assert!(out.contains("42"), "non-secret uid must survive: {out}");
    }
}

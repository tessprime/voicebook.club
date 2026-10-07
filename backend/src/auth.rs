//! Authentication: who is calling the API. See docs/design/auth.md.
//!
//! The browser signs in to the user's PDS with OAuth; that token is for the
//! PDS and never reaches us. To prove its identity to *this* service, the
//! browser asks the PDS for a short-lived service-auth token (a JWT signed with
//! the account's key, audience = our service DID, method = SESSION_LXM) and
//! exchanges it once for a session cookie.

use std::collections::HashMap;
use std::sync::Mutex;

use anyhow::{Context, Result, bail, ensure};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;

use crate::atproto;

/// The method a session-creating service-auth token must be bound to.
pub const SESSION_LXM: &str = "club.voicebook.auth.createSession";
/// The service ID within our DID document (`<serviceDid>#voicebook`).
pub const SERVICE_ID: &str = "voicebook";
/// The session cookie over HTTPS. Browsers accept a `__Host-` cookie only
/// from the same host, with `Secure`, `Path=/` and no `Domain`, so no other
/// subdomain can plant one (session fixation by "cookie tossing").
pub const SESSION_COOKIE: &str = "__Host-vb_session";
/// The session cookie on plain-HTTP loopback (local development), where
/// `__Host-` cookies can't be set because they require `Secure`.
pub const SESSION_COOKIE_LOOPBACK: &str = "vb_session";
pub const SESSION_DAYS: i64 = 30;
/// Tolerated clock difference between us and the user's PDS.
const CLOCK_SKEW_SECS: i64 = 60;
/// The PDS issues method-bound tokens for at most an hour.
const MAX_TOKEN_LIFETIME_SECS: i64 = 3600;
/// DID resolutions during sign-in, across all callers, per minute. Each one
/// is an outbound request (for `did:web`, to a host the token names); real
/// sign-ins happen once per user per 30 days.
pub const SIGN_IN_RESOLUTIONS_PER_MINUTE: u32 = 60;

/// Verifies service-auth tokens addressed to this service.
pub struct ServiceAuth {
    audience: String,
    client: atproto::Client,
    /// Token IDs already used, until they expire: a token creates one session.
    used: Mutex<HashMap<String, i64>>,
    /// Resolutions in the current minute: (window start, count).
    resolutions: Mutex<(i64, u32)>,
}

impl ServiceAuth {
    pub fn new(service_did: &str, client: atproto::Client) -> Self {
        Self {
            audience: format!("{service_did}#{SERVICE_ID}"),
            client,
            used: Mutex::new(HashMap::new()),
            resolutions: Mutex::new((0, 0)),
        }
    }

    /// What tokens must name as `aud`.
    pub fn audience(&self) -> &str {
        &self.audience
    }

    /// Verifies a token. `admits` is checked on the token's (still
    /// unverified) `iss` right after the cheap checks and before anything is
    /// fetched: anyone can post tokens naming any DID, and resolving it means
    /// network requests (`did:web` even to a host of their choosing). The
    /// cost: whether a DID is admitted becomes observable without a valid
    /// token, which is accepted (the allowlist is meant to become public).
    pub async fn verify(&self, token: &str, admits: impl Fn(&str) -> bool) -> Result<Verdict> {
        let token = Token::parse(token)?;
        let now = chrono::Utc::now().timestamp();
        token.claims.check(&self.audience, now)?;
        if !admits(&token.claims.iss) {
            return Ok(Verdict::NotAdmitted { unverified_did: token.claims.iss });
        }
        if !self.take_resolution(now) {
            return Ok(Verdict::Busy);
        }
        // Resolution goes through the SSRF-guarded client.
        let identity = self.client.resolve(&token.claims.iss).await?;
        let key = PublicKey::from_multikey(identity.signing_key.as_deref().context("DID document has no #atproto key")?)?;
        token.verify_signature(&key)?;
        // Only after the signature checks out, so forged tokens can't burn IDs.
        self.consume(&token.claims, now)?;
        Ok(Verdict::Verified(token.claims.iss))
    }

    /// Takes one DID resolution from this minute's budget, if any is left.
    fn take_resolution(&self, now: i64) -> bool {
        let mut window = self.resolutions.lock().expect("resolution budget lock");
        if now - window.0 >= 60 {
            *window = (now, 0);
        }
        if window.1 >= SIGN_IN_RESOLUTIONS_PER_MINUTE {
            return false;
        }
        window.1 += 1;
        true
    }

    fn consume(&self, claims: &Claims, now: i64) -> Result<()> {
        let jti = claims.jti.as_deref().context("token has no jti")?;
        let mut used = self.used.lock().expect("replay cache lock");
        used.retain(|_, exp| *exp + CLOCK_SKEW_SECS >= now);
        ensure!(used.insert(jti.to_owned(), claims.exp).is_none(), "token already used");
        Ok(())
    }
}

#[derive(Debug, PartialEq)]
pub enum Verdict {
    /// The token proves this DID.
    Verified(String),
    /// The token names a DID that isn't admitted; nothing was fetched and
    /// the signature wasn't checked, so the DID is only a claim.
    NotAdmitted { unverified_did: String },
    /// This minute's budget of sign-in resolutions is spent; nothing was
    /// fetched. Try again shortly.
    Busy,
}

#[derive(Debug, Deserialize)]
struct Header {
    alg: String,
}

#[derive(Debug, Deserialize)]
struct Claims {
    iss: String,
    aud: String,
    exp: i64,
    iat: Option<i64>,
    lxm: Option<String>,
    jti: Option<String>,
}

impl Claims {
    fn check(&self, audience: &str, now: i64) -> Result<()> {
        ensure!(
            (self.iss.starts_with("did:plc:") || self.iss.starts_with("did:web:")) && !self.iss.contains('#'),
            "iss must be an account DID"
        );
        ensure!(self.aud == audience, "token is for {:?}, not {audience:?}", self.aud);
        ensure!(self.lxm.as_deref() == Some(SESSION_LXM), "token is bound to {:?}, not {SESSION_LXM}", self.lxm);
        ensure!(self.exp + CLOCK_SKEW_SECS >= now, "token expired");
        ensure!(self.exp <= now + MAX_TOKEN_LIFETIME_SECS + CLOCK_SKEW_SECS, "token lifetime too long");
        if let Some(iat) = self.iat {
            ensure!(iat <= now + CLOCK_SKEW_SECS, "token issued in the future");
        }
        Ok(())
    }
}

struct Token {
    header: Header,
    claims: Claims,
    /// `base64url(header).base64url(payload)`, what the signature covers.
    signing_input: String,
    signature: Vec<u8>,
}

impl Token {
    fn parse(token: &str) -> Result<Self> {
        let mut parts = token.split('.');
        let (Some(header), Some(payload), Some(signature), None) = (parts.next(), parts.next(), parts.next(), parts.next())
        else {
            bail!("not a JWT");
        };
        Ok(Self {
            header: serde_json::from_slice(&URL_SAFE_NO_PAD.decode(header)?).context("JWT header")?,
            claims: serde_json::from_slice(&URL_SAFE_NO_PAD.decode(payload)?).context("JWT claims")?,
            signing_input: format!("{header}.{payload}"),
            signature: URL_SAFE_NO_PAD.decode(signature)?,
        })
    }

    fn verify_signature(&self, key: &PublicKey) -> Result<()> {
        use k256::ecdsa::signature::Verifier;
        let input = self.signing_input.as_bytes();
        // The algorithm must match the key; nothing else (e.g. "none") passes.
        // ATProto requires low-S signatures on both curves; ecdsa only
        // enforces that for secp256k1, so check explicitly.
        match (key, self.header.alg.as_str()) {
            (PublicKey::K256(key), "ES256K") => {
                let sig = k256::ecdsa::Signature::from_slice(&self.signature)?;
                ensure!(sig.normalize_s() == sig, "high-S signature");
                key.verify(input, &sig).context("bad signature")
            }
            (PublicKey::P256(key), "ES256") => {
                let sig = p256::ecdsa::Signature::from_slice(&self.signature)?;
                ensure!(sig.normalize_s() == sig, "high-S signature");
                key.verify(input, &sig).context("bad signature")
            }
            (_, alg) => bail!("algorithm {alg:?} doesn't match the account's key"),
        }
    }
}

enum PublicKey {
    K256(k256::ecdsa::VerifyingKey),
    P256(p256::ecdsa::VerifyingKey),
}

impl PublicKey {
    /// Decodes a Multikey (`z…`, base58btc), as in DID documents.
    fn from_multikey(multikey: &str) -> Result<Self> {
        let encoded = multikey.strip_prefix("did:key:").unwrap_or(multikey);
        let base58 = encoded.strip_prefix('z').context("multikey must be base58btc ('z')")?;
        let bytes = bs58::decode(base58).into_vec()?;
        match bytes.as_slice() {
            [0xe7, 0x01, key @ ..] => Ok(Self::K256(k256::ecdsa::VerifyingKey::from_sec1_bytes(key)?)),
            [0x80, 0x24, key @ ..] => Ok(Self::P256(p256::ecdsa::VerifyingKey::from_sec1_bytes(key)?)),
            _ => bail!("unsupported key type"),
        }
    }
}

// --- sessions -----------------------------------------------------------------

/// Creates a session for `did` and returns its token, for the cookie. Only a
/// hash of the token is stored.
pub async fn create_session(db: &SqlitePool, did: &str) -> Result<String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|err| anyhow::anyhow!("random: {err}"))?;
    let token = URL_SAFE_NO_PAD.encode(bytes);
    sqlx::query(
        "INSERT INTO sessions (token_hash, did, created_at, expires_at)
         VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?))",
    )
    .bind(token_hash(&token))
    .bind(did)
    .bind(format!("+{SESSION_DAYS} days"))
    .execute(db)
    .await?;
    Ok(token)
}

/// The DID a session token belongs to, if the session exists and is current.
pub async fn session_did(db: &SqlitePool, token: &str) -> Result<Option<String>> {
    Ok(sqlx::query_scalar("SELECT did FROM sessions WHERE token_hash = ? AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ')")
        .bind(token_hash(token))
        .fetch_optional(db)
        .await?)
}

pub async fn delete_session(db: &SqlitePool, token: &str) -> Result<()> {
    sqlx::query("DELETE FROM sessions WHERE token_hash = ?").bind(token_hash(token)).execute(db).await?;
    Ok(())
}

pub async fn delete_expired_sessions(db: &SqlitePool) -> Result<u64> {
    let result = sqlx::query("DELETE FROM sessions WHERE expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ')").execute(db).await?;
    Ok(result.rows_affected())
}

fn token_hash(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

#[cfg(test)]
mod tests {
    use k256::ecdsa::signature::Signer;

    use super::*;

    const AUD: &str = "did:web:voicebook.club#voicebook";
    const NOW: i64 = 1_800_000_000;

    fn claims(overrides: serde_json::Value) -> serde_json::Value {
        let mut claims = serde_json::json!({
            "iss": "did:plc:alice", "aud": AUD, "exp": NOW + 60, "iat": NOW, "lxm": SESSION_LXM, "jti": "abc123"
        });
        claims.as_object_mut().unwrap().extend(overrides.as_object().unwrap().clone());
        claims
    }

    fn encode(value: &serde_json::Value) -> String {
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(value).unwrap())
    }

    fn k256_key() -> k256::ecdsa::SigningKey {
        k256::ecdsa::SigningKey::from_slice(&[7u8; 32]).unwrap()
    }

    fn p256_key() -> p256::ecdsa::SigningKey {
        p256::ecdsa::SigningKey::from_slice(&[9u8; 32]).unwrap()
    }

    fn multikey(prefix: [u8; 2], sec1: &[u8]) -> String {
        format!("z{}", bs58::encode([&prefix[..], sec1].concat()).into_string())
    }

    fn k256_token(alg: &str, claims: &serde_json::Value) -> String {
        let input = format!("{}.{}", encode(&serde_json::json!({ "alg": alg, "typ": "JWT" })), encode(claims));
        let sig: k256::ecdsa::Signature = k256_key().sign(input.as_bytes());
        format!("{input}.{}", URL_SAFE_NO_PAD.encode(sig.to_bytes()))
    }

    fn k256_public() -> PublicKey {
        let point = k256_key().verifying_key().to_sec1_point(true);
        PublicKey::from_multikey(&multikey([0xe7, 0x01], point.as_bytes())).unwrap()
    }

    #[test]
    fn valid_k256_token_verifies() {
        let token = Token::parse(&k256_token("ES256K", &claims(serde_json::json!({})))).unwrap();
        token.claims.check(AUD, NOW).unwrap();
        token.verify_signature(&k256_public()).unwrap();
    }

    #[test]
    fn valid_p256_token_verifies_and_high_s_is_rejected() {
        let input = format!("{}.{}", encode(&serde_json::json!({ "alg": "ES256" })), encode(&claims(serde_json::json!({}))));
        let sig: p256::ecdsa::Signature = p256_key().sign(input.as_bytes());
        let low = sig.normalize_s();
        let point = p256_key().verifying_key().to_sec1_point(true);
        let key = PublicKey::from_multikey(&multikey([0x80, 0x24], point.as_bytes())).unwrap();

        let token = Token::parse(&format!("{input}.{}", URL_SAFE_NO_PAD.encode(low.to_bytes()))).unwrap();
        token.verify_signature(&key).unwrap();

        // The same signature with s replaced by n - s: valid ECDSA, but malleable.
        let high = p256::ecdsa::Signature::from_scalars(low.r(), -*low.s()).unwrap();
        let token = Token::parse(&format!("{input}.{}", URL_SAFE_NO_PAD.encode(high.to_bytes()))).unwrap();
        assert!(token.verify_signature(&key).unwrap_err().to_string().contains("high-S"));
    }

    #[test]
    fn tampering_and_algorithm_confusion_are_rejected() {
        let good = k256_token("ES256K", &claims(serde_json::json!({})));
        // Swap in different claims under the original signature.
        let parts: Vec<&str> = good.split('.').collect();
        let forged = format!("{}.{}.{}", parts[0], encode(&claims(serde_json::json!({ "iss": "did:plc:mallory" }))), parts[2]);
        assert!(Token::parse(&forged).unwrap().verify_signature(&k256_public()).is_err());
        // Claimed algorithm doesn't match the key type; "none" never passes.
        for alg in ["ES256", "none", "HS256"] {
            assert!(Token::parse(&k256_token(alg, &claims(serde_json::json!({})))).unwrap().verify_signature(&k256_public()).is_err());
        }
        assert!(Token::parse("not.a.jwt.at-all").is_err());
    }

    #[test]
    fn claims_are_checked() {
        let check = |overrides: serde_json::Value| {
            serde_json::from_value::<Claims>(claims(overrides)).unwrap().check(AUD, NOW)
        };
        assert!(check(serde_json::json!({})).is_ok());
        assert!(check(serde_json::json!({ "aud": "did:web:evil.example#voicebook" })).is_err());
        assert!(check(serde_json::json!({ "aud": "did:web:voicebook.club" })).is_err(), "service ID required");
        assert!(check(serde_json::json!({ "lxm": "com.atproto.repo.createRecord" })).is_err());
        assert!(check(serde_json::json!({ "lxm": null })).is_err(), "method-less tokens are refused");
        assert!(check(serde_json::json!({ "exp": NOW - 120 })).is_err(), "expired");
        assert!(check(serde_json::json!({ "exp": NOW + 7200 })).is_err(), "lifetime over an hour");
        assert!(check(serde_json::json!({ "iat": NOW + 600 })).is_err(), "issued in the future");
        assert!(check(serde_json::json!({ "iss": "did:plc:alice#atproto_labeler" })).is_err());
        assert!(check(serde_json::json!({ "iss": "alice.bsky.social" })).is_err());
    }

    #[test]
    fn a_token_id_works_once() {
        let auth = ServiceAuth::new(
            "did:web:voicebook.club",
            atproto::Client::new("http://127.0.0.1:1", crate::fetch_guard::FetchPolicy { allow_private: true }).unwrap(),
        );
        let claims: Claims = serde_json::from_value(claims(serde_json::json!({}))).unwrap();
        auth.consume(&claims, NOW).unwrap();
        assert!(auth.consume(&claims, NOW).is_err(), "replay");
        let no_jti: Claims = serde_json::from_value(claims_with_jti_null()).unwrap();
        assert!(auth.consume(&no_jti, NOW).is_err());
    }

    fn claims_with_jti_null() -> serde_json::Value {
        claims(serde_json::json!({ "jti": null }))
    }

    #[tokio::test]
    async fn sessions_round_trip() {
        let db = sqlx::sqlite::SqlitePoolOptions::new().max_connections(1).connect("sqlite::memory:").await.unwrap();
        sqlx::migrate!().run(&db).await.unwrap();
        let token = create_session(&db, "did:plc:alice").await.unwrap();
        assert_eq!(session_did(&db, &token).await.unwrap().as_deref(), Some("did:plc:alice"));
        assert_eq!(session_did(&db, "made-up").await.unwrap(), None);
        let stored: String = sqlx::query_scalar("SELECT token_hash FROM sessions").fetch_one(&db).await.unwrap();
        assert_ne!(stored, token, "only the hash is stored");
        delete_session(&db, &token).await.unwrap();
        assert_eq!(session_did(&db, &token).await.unwrap(), None);
    }

    #[tokio::test]
    async fn uninvited_issuers_are_turned_away_before_any_fetch() {
        // The PLC address goes nowhere: resolving anything would fail.
        let auth = ServiceAuth::new(
            "did:web:voicebook.club",
            atproto::Client::new("http://127.0.0.1:1", crate::fetch_guard::FetchPolicy { allow_private: true }).unwrap(),
        );
        let now = chrono::Utc::now().timestamp();
        let token = k256_token("ES256K", &claims(serde_json::json!({ "iss": "did:plc:mallory", "exp": now + 60, "iat": now })));
        let verdict = auth.verify(&token, |did| did == "did:plc:alice").await.unwrap();
        assert_eq!(verdict, Verdict::NotAdmitted { unverified_did: "did:plc:mallory".into() });
        // Its token ID wasn't used up either.
        assert!(auth.used.lock().unwrap().is_empty());
        // Bad claims are still rejected first, admitted or not.
        let wrong_aud = k256_token("ES256K", &claims(serde_json::json!({ "aud": "did:web:other#voicebook", "exp": now + 60 })));
        assert!(auth.verify(&wrong_aud, |_| false).await.is_err());
    }

    #[test]
    fn sign_in_resolutions_are_budgeted_per_minute() {
        let auth = ServiceAuth::new(
            "did:web:voicebook.club",
            atproto::Client::new("http://127.0.0.1:1", crate::fetch_guard::FetchPolicy { allow_private: true }).unwrap(),
        );
        for _ in 0..SIGN_IN_RESOLUTIONS_PER_MINUTE {
            assert!(auth.take_resolution(NOW));
        }
        assert!(!auth.take_resolution(NOW + 30), "spent for this minute");
        assert!(auth.take_resolution(NOW + 60), "a new minute");
    }
}

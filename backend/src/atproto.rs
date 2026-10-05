//! Minimal read-only ATProto client: DID resolution and record listing. All
//! the data it touches is public, so it never needs credentials.

use anyhow::{Context, Result, bail};
use serde::Deserialize;
use serde_json::Value;

pub const RECORDING: &str = "club.voicebook.recording";
pub const FOLLOW: &str = "app.bsky.graph.follow";

#[derive(Clone)]
pub struct Client {
    http: reqwest::Client,
    plc_url: String,
}

/// The parts of a DID document Voicebook uses.
#[derive(Debug, Clone, PartialEq)]
pub struct Identity {
    pub handle: Option<String>,
    pub pds_url: String,
}

#[derive(Debug, Clone)]
pub struct Record {
    pub uri: String,
    pub cid: String,
    pub value: Value,
}

#[derive(Deserialize)]
struct DidDocument {
    #[serde(default, rename = "alsoKnownAs")]
    also_known_as: Vec<String>,
    #[serde(default)]
    service: Vec<Service>,
}

#[derive(Deserialize)]
struct Service {
    id: String,
    #[serde(rename = "serviceEndpoint")]
    endpoint: Value,
}

#[derive(Deserialize)]
struct ListRecords {
    records: Vec<ListedRecord>,
    cursor: Option<String>,
}

#[derive(Deserialize)]
struct ListedRecord {
    uri: String,
    cid: String,
    value: Value,
}

impl Client {
    pub fn new(plc_url: &str) -> Self {
        Self {
            http: reqwest::Client::new(),
            plc_url: plc_url.trim_end_matches('/').to_owned(),
        }
    }

    pub async fn resolve(&self, did: &str) -> Result<Identity> {
        let url = if did.starts_with("did:plc:") {
            format!("{}/{did}", self.plc_url)
        } else if let Some(host) = did.strip_prefix("did:web:") {
            format!("https://{host}/.well-known/did.json")
        } else {
            bail!("unsupported DID method: {did}");
        };
        let doc: DidDocument = self
            .http
            .get(&url)
            .send()
            .await?
            .error_for_status()
            .with_context(|| format!("resolving {did}"))?
            .json()
            .await?;
        identity_from_doc(doc).with_context(|| format!("DID document for {did}"))
    }

    /// Lists every record in one collection of a repo, following pagination.
    pub async fn list_records(&self, pds_url: &str, did: &str, collection: &str) -> Result<Vec<Record>> {
        let url = format!("{}/xrpc/com.atproto.repo.listRecords", pds_url.trim_end_matches('/'));
        let mut records = Vec::new();
        let mut cursor: Option<String> = None;
        loop {
            let mut query = vec![("repo", did), ("collection", collection), ("limit", "100")];
            if let Some(c) = &cursor {
                query.push(("cursor", c));
            }
            let page: ListRecords = self
                .http
                .get(&url)
                .query(&query)
                .send()
                .await?
                .error_for_status()
                .with_context(|| format!("listRecords {did} {collection}"))?
                .json()
                .await?;
            let done = page.records.is_empty() || page.cursor.is_none();
            records.extend(page.records.into_iter().map(|r| Record { uri: r.uri, cid: r.cid, value: r.value }));
            if done {
                return Ok(records);
            }
            cursor = page.cursor;
        }
    }
}

fn identity_from_doc(doc: DidDocument) -> Result<Identity> {
    let handle = doc
        .also_known_as
        .iter()
        .find_map(|aka| aka.strip_prefix("at://"))
        .map(str::to_owned);
    let pds_url = doc
        .service
        .iter()
        .find(|s| s.id.ends_with("#atproto_pds"))
        .and_then(|s| s.endpoint.as_str())
        .context("no #atproto_pds service")?
        .to_owned();
    Ok(Identity { handle, pds_url })
}

/// Splits `at://did/collection/rkey`.
pub fn parse_at_uri(uri: &str) -> Option<(&str, &str, &str)> {
    let mut parts = uri.strip_prefix("at://")?.splitn(3, '/');
    Some((parts.next()?, parts.next()?, parts.next()?))
}

pub fn blob_url(pds_url: &str, did: &str, cid: &str) -> String {
    format!(
        "{}/xrpc/com.atproto.sync.getBlob?did={did}&cid={cid}",
        pds_url.trim_end_matches('/')
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_from_plc_document() {
        let doc: DidDocument = serde_json::from_value(serde_json::json!({
            "id": "did:plc:abc",
            "alsoKnownAs": ["at://alice.test"],
            "service": [{"id": "#atproto_pds", "type": "AtprotoPersonalDataServer", "serviceEndpoint": "http://localhost:2583"}]
        }))
        .unwrap();
        assert_eq!(
            identity_from_doc(doc).unwrap(),
            Identity { handle: Some("alice.test".into()), pds_url: "http://localhost:2583".into() }
        );
    }

    #[test]
    fn at_uri_parts() {
        assert_eq!(
            parse_at_uri("at://did:plc:abc/club.voicebook.recording/3mx"),
            Some(("did:plc:abc", "club.voicebook.recording", "3mx"))
        );
        assert_eq!(parse_at_uri("https://example.com"), None);
    }
}

//! Minimal read-only ATProto client: DID resolution and record listing. All
//! the data it touches is public, so it never needs credentials.

use std::time::Instant;

use anyhow::{Context, Result, bail};
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::Value;
use tracing::{Instrument, instrument};

pub const RECORDING: &str = "club.voicebook.recording";
pub const FOLLOW: &str = "app.bsky.graph.follow";

/// listRecords page size (the protocol's maximum).
const PAGE_SIZE: usize = 100;

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

    #[instrument(skip(self))]
    pub async fn resolve(&self, did: &str) -> Result<Identity> {
        let url = if did.starts_with("did:plc:") {
            format!("{}/{did}", self.plc_url)
        } else if let Some(host) = did.strip_prefix("did:web:") {
            format!("https://{host}/.well-known/did.json")
        } else {
            bail!("unsupported DID method: {did}");
        };
        let doc: DidDocument = self.get_json("resolve_did", &url, &[]).await.with_context(|| format!("resolving {did}"))?;
        identity_from_doc(doc).with_context(|| format!("DID document for {did}"))
    }

    /// Lists every record in one collection of a repo, following pagination.
    #[instrument(skip(self, pds_url))]
    pub async fn list_records(&self, pds_url: &str, did: &str, collection: &str) -> Result<Vec<Record>> {
        let url = format!("{}/xrpc/com.atproto.repo.listRecords", pds_url.trim_end_matches('/'));
        let mut records = Vec::new();
        let mut cursor: Option<String> = None;
        loop {
            let limit = PAGE_SIZE.to_string();
            let mut query = vec![("repo", did), ("collection", collection), ("limit", limit.as_str())];
            if let Some(c) = &cursor {
                query.push(("cursor", c));
            }
            let page: ListRecords = self
                .get_json("list_records", &url, &query)
                .await
                .with_context(|| format!("listRecords {did} {collection}"))?;
            // A PDS returns a cursor even on the last page; a short page means
            // there's nothing more, which saves a request per collection.
            let done = page.records.len() < PAGE_SIZE || page.cursor.is_none();
            records.extend(page.records.into_iter().map(|r| Record { uri: r.uri, cid: r.cid, value: r.value }));
            if done {
                return Ok(records);
            }
            cursor = page.cursor;
        }
    }
}

impl Client {
    /// One GET with a client span and the outbound latency metric.
    async fn get_json<T: DeserializeOwned>(&self, operation: &'static str, url: &str, query: &[(&str, &str)]) -> Result<T> {
        let host = reqwest::Url::parse(url).ok().and_then(|u| u.host_str().map(str::to_owned)).unwrap_or_default();
        let span = tracing::info_span!(
            "atproto request",
            otel.name = operation,
            otel.kind = "client",
            otel.status_code = tracing::field::Empty,
            http.request.method = "GET",
            server.address = %host,
            http.response.status_code = tracing::field::Empty,
        );
        let start = Instant::now();
        let result: Result<T> = async {
            let response = self.http.get(url).query(query).send().await?;
            tracing::Span::current().record("http.response.status_code", i64::from(response.status().as_u16()));
            Ok(response.error_for_status()?.json().await?)
        }
        .instrument(span.clone())
        .await;
        if result.is_err() {
            span.record("otel.status_code", "ERROR");
        }
        let outcome = if result.is_ok() { "ok" } else { "error" };
        metrics::histogram!("atproto_request_duration_seconds", "operation" => operation, "outcome" => outcome)
            .record(start.elapsed().as_secs_f64());
        result
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

use std::net::SocketAddr;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::Deserialize;

/// Runtime configuration, loaded from `environments/<name>.json`.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    /// The environment's name (the file name without `.json`); reported as
    /// the `deployment.environment.name` telemetry attribute.
    #[serde(skip)]
    pub environment: String,
    pub bind: SocketAddr,
    /// SQLite file, relative to the working directory.
    pub database: PathBuf,
    pub plc_url: String,
    pub jetstream_url: String,
    /// This service's DID (e.g. `did:web:voicebook.club`). Service-auth
    /// tokens must be addressed to `<serviceDid>#voicebook`.
    pub service_did: String,
    /// The site's public origin (e.g. `https://voicebook.club`), used for the
    /// OAuth client metadata. If unset, it's derived from each request's
    /// `Host` header, which the proxy in front must pass through.
    pub public_url: Option<String>,
    /// The built frontend (`frontend/dist`), served at `/`. Unset in
    /// development, where Vite serves it.
    pub frontend_dir: Option<PathBuf>,
    /// A separate listener for `/metrics`, kept off the public port. If
    /// unset, `/metrics` is served on `bind` (local development).
    pub metrics_bind: Option<SocketAddr>,
    #[serde(default)]
    pub telemetry: Telemetry,
    #[serde(default)]
    pub access: AccessConfig,
    #[serde(default)]
    pub network: NetworkConfig,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NetworkConfig {
    /// Let the backend fetch plain-HTTP and private/loopback addresses from
    /// DID documents. Only for the local network in dev/localnet; off, it
    /// guards against SSRF (see fetch_guard.rs).
    #[serde(default)]
    pub allow_private_addresses: bool,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AccessConfig {
    /// DIDs allowed to use this instance (closed beta). Unset: open to
    /// everyone. Changing it takes effect on restart; members no longer
    /// listed are removed from the index.
    pub allowlist: Option<Vec<String>>,
    /// DIDs that administer the instance: they may refresh any account and
    /// reindex. Admins are always admitted.
    #[serde(default)]
    pub admins: Vec<String>,
}

/// See docs/design/logging.md.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Telemetry {
    /// Base URL of an OTLP/HTTP collector (e.g. `http://localhost:4318`).
    /// Traces and logs are sent there; None disables OTLP export.
    pub otlp_endpoint: Option<String>,
    /// Filter for the stderr diagnostic channel, in `RUST_LOG` syntax.
    /// `VOICEBOOK_STDERR` overrides it for a session.
    #[serde(default = "default_stderr_filter")]
    pub stderr: String,
    /// The local JSON mirror of every log event plus per-request access
    /// lines, for debugging when OTLP isn't available. None disables it.
    pub file: Option<FileLog>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileLog {
    /// Directory for `backend-<environment>.<date>.jsonl` files, relative to
    /// the working directory.
    pub directory: PathBuf,
    /// Files rotate daily; this many days are kept.
    #[serde(default = "default_retention_days")]
    pub retention_days: usize,
}

fn default_retention_days() -> usize {
    3
}

fn default_stderr_filter() -> String {
    "warn,lifecycle=info".into()
}

impl Default for Telemetry {
    fn default() -> Self {
        Self { otlp_endpoint: None, stderr: default_stderr_filter(), file: None }
    }
}

impl Config {
    pub fn load(path: &Path) -> Result<Self> {
        let text = std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
        let mut config: Self = serde_json::from_str(&text).with_context(|| format!("parsing {}", path.display()))?;
        config.environment = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        Ok(config)
    }

    /// Picks the environment from `--environment <name>` (default
    /// `development`), or an explicit file from `--config <path>`.
    pub fn from_args() -> Result<Self> {
        let mut args = std::env::args().skip(1);
        let mut path = PathBuf::from("environments/development.json");
        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--environment" | "-e" => {
                    let name = args.next().context("--environment needs a name")?;
                    path = PathBuf::from(format!("environments/{name}.json"));
                }
                "--config" => path = args.next().context("--config needs a path")?.into(),
                other => anyhow::bail!("unknown argument {other:?}; usage: voicebook-backend [--environment <name> | --config <path>]"),
            }
        }
        Self::load(&path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checked_in_environments_parse() {
        for name in ["development", "local-bluesky", "droplet", "app-platform"] {
            Config::load(Path::new(&format!("environments/{name}.json"))).unwrap();
        }
    }
}

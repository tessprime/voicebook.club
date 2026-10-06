use std::net::SocketAddr;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::Deserialize;

/// Runtime configuration, loaded from `environments/<name>.json`.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    pub bind: SocketAddr,
    /// SQLite file, relative to the working directory.
    pub database: PathBuf,
    pub plc_url: String,
    pub jetstream_url: String,
}

impl Config {
    pub fn load(path: &Path) -> Result<Self> {
        let text = std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
        serde_json::from_str(&text).with_context(|| format!("parsing {}", path.display()))
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
        for name in ["development", "production"] {
            Config::load(Path::new(&format!("environments/{name}.json"))).unwrap();
        }
    }
}

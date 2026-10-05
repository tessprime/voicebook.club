use std::net::SocketAddr;

use anyhow::{Context, Result};

/// Runtime configuration, read from environment variables. The defaults point
/// at the local network in dev/localnet.
#[derive(Clone, Debug)]
pub struct Config {
    pub bind: SocketAddr,
    pub database_url: String,
    pub plc_url: String,
    pub jetstream_url: String,
}

impl Config {
    pub fn from_env() -> Result<Self> {
        let var = |name: &str, default: &str| std::env::var(name).unwrap_or_else(|_| default.to_owned());
        Ok(Self {
            bind: var("VOICEBOOK_BIND", "127.0.0.1:3000")
                .parse()
                .context("VOICEBOOK_BIND")?,
            database_url: var("VOICEBOOK_DATABASE_URL", "sqlite://data/voicebook.sqlite"),
            plc_url: var("VOICEBOOK_PLC_URL", "http://localhost:2582"),
            jetstream_url: var("VOICEBOOK_JETSTREAM_URL", "ws://localhost:6008"),
        })
    }
}

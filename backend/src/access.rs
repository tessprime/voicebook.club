//! Who may use this instance. During the closed beta, an allowlist of DIDs
//! from the environment config; without one, everyone (development).

use std::collections::HashSet;
use std::sync::Arc;

use anyhow::{Result, bail};

#[derive(Clone, Debug, Default)]
pub struct Access {
    /// None: open to everyone.
    allowlist: Option<Arc<HashSet<String>>>,
}

impl Access {
    pub fn new(allowlist: Option<&[String]>) -> Result<Self> {
        let Some(dids) = allowlist else { return Ok(Self::default()) };
        for did in dids {
            if !(did.starts_with("did:plc:") || did.starts_with("did:web:")) {
                bail!("allowlist entries must be DIDs (did:plc:… or did:web:…), not {did:?}; handles can change");
            }
        }
        Ok(Self { allowlist: Some(Arc::new(dids.iter().cloned().collect())) })
    }

    pub fn allows(&self, did: &str) -> bool {
        self.allowlist.as_ref().is_none_or(|list| list.contains(did))
    }

    pub fn invite_only(&self) -> bool {
        self.allowlist.is_some()
    }

    pub fn allowlist_len(&self) -> Option<usize> {
        self.allowlist.as_ref().map(|list| list.len())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_without_an_allowlist() {
        let access = Access::new(None).unwrap();
        assert!(access.allows("did:plc:anyone"));
        assert!(!access.invite_only());
    }

    #[test]
    fn allowlist_admits_only_listed_dids() {
        let access = Access::new(Some(&["did:plc:alice".to_owned()])).unwrap();
        assert!(access.allows("did:plc:alice"));
        assert!(!access.allows("did:plc:bob"));
        assert!(access.invite_only());
        assert!(Access::new(Some(&[])).unwrap().invite_only(), "an empty list admits nobody");
    }

    #[test]
    fn handles_are_rejected() {
        assert!(Access::new(Some(&["alice.bsky.social".to_owned()])).is_err());
    }
}

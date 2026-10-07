//! Who may use this instance, and who administers it. During the closed
//! beta, an allowlist of DIDs from the environment config; without one,
//! everyone (development). Admins are always admitted.

use std::collections::HashSet;
use std::sync::Arc;

use anyhow::{Result, bail};

#[derive(Clone, Debug, Default)]
pub struct Access {
    /// None: open to everyone.
    allowlist: Option<Arc<HashSet<String>>>,
    admins: Arc<HashSet<String>>,
}

impl Access {
    pub fn new(allowlist: Option<&[String]>, admins: &[String]) -> Result<Self> {
        for did in allowlist.unwrap_or_default().iter().chain(admins) {
            if !(did.starts_with("did:plc:") || did.starts_with("did:web:")) {
                bail!("allowlist and admin entries must be DIDs (did:plc:… or did:web:…), not {did:?}; handles can change");
            }
        }
        Ok(Self {
            allowlist: allowlist.map(|dids| Arc::new(dids.iter().cloned().collect())),
            admins: Arc::new(admins.iter().cloned().collect()),
        })
    }

    pub fn allows(&self, did: &str) -> bool {
        self.is_admin(did) || self.allowlist.as_ref().is_none_or(|list| list.contains(did))
    }

    pub fn is_admin(&self, did: &str) -> bool {
        self.admins.contains(did)
    }

    /// Every account named in the config (allowlist and admins), sorted.
    /// During an invite-only beta, that's everyone who can be a member.
    pub fn listed_dids(&self) -> Vec<String> {
        let mut dids: Vec<String> =
            self.allowlist.iter().flat_map(|list| list.iter()).chain(self.admins.iter()).cloned().collect();
        dids.sort();
        dids.dedup();
        dids
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
        let access = Access::new(None, &[]).unwrap();
        assert!(access.allows("did:plc:anyone"));
        assert!(!access.invite_only());
    }

    #[test]
    fn allowlist_admits_only_listed_dids() {
        let access = Access::new(Some(&["did:plc:alice".to_owned()]), &["did:plc:admin".to_owned()]).unwrap();
        assert!(access.allows("did:plc:alice"));
        assert!(!access.allows("did:plc:bob"));
        assert!(access.allows("did:plc:admin"), "admins are always admitted");
        assert!(access.is_admin("did:plc:admin") && !access.is_admin("did:plc:alice"));
        assert!(access.invite_only());
        assert_eq!(access.listed_dids(), ["did:plc:admin", "did:plc:alice"]);
        assert!(Access::new(Some(&[]), &[]).unwrap().invite_only(), "an empty list admits nobody");
    }

    #[test]
    fn handles_are_rejected() {
        assert!(Access::new(Some(&["alice.bsky.social".to_owned()]), &[]).is_err());
        assert!(Access::new(None, &["alice.bsky.social".to_owned()]).is_err());
    }
}

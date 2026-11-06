#![no_std]

mod identities;
pub use identities::{BuildNumber, InvalidVersion, Version};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Targets(u8);

impl Targets {
    pub const NONE: Self = Self(0);
    pub const WORKER: Self = Self(1 << 0);
    pub const IOS: Self = Self(1 << 1);
    pub const ANDROID: Self = Self(1 << 2);
    pub const CLOUDFLARE_ALERTS: Self = Self(1 << 3);
    pub const MONITORS: Self = Self(1 << 4);
    pub const PRODUCT: Self = Self(Self::WORKER.0 | Self::IOS.0 | Self::ANDROID.0);
    pub const ALL: Self = Self(Self::PRODUCT.0 | Self::CLOUDFLARE_ALERTS.0 | Self::MONITORS.0);

    pub const fn from_bits(bits: u8) -> Option<Self> {
        if bits & !Self::ALL.0 == 0 {
            Some(Self(bits))
        } else {
            None
        }
    }
    pub const fn bits(self) -> u8 {
        self.0
    }
    pub const fn union(self, other: Self) -> Self {
        Self(self.0 | other.0)
    }
    pub const fn contains(self, other: Self) -> bool {
        self.0 & other.0 == other.0
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Checks(u8);

impl Checks {
    pub const NONE: Self = Self(0);
    pub const FAST: Self = Self(1 << 0);
    pub const WORKER: Self = Self(1 << 1);
    pub const IOS: Self = Self(1 << 2);
    pub const ANDROID: Self = Self(1 << 3);
    pub const COMPATIBILITY: Self = Self(1 << 4);
    pub const OPERATIONS: Self = Self(1 << 5);
    pub const PRODUCT: Self =
        Self(Self::FAST.0 | Self::WORKER.0 | Self::IOS.0 | Self::ANDROID.0 | Self::COMPATIBILITY.0);
    pub const ALL: Self = Self(Self::PRODUCT.0 | Self::OPERATIONS.0);

    pub const fn from_bits(bits: u8) -> Option<Self> {
        if bits & !Self::ALL.0 == 0 {
            Some(Self(bits))
        } else {
            None
        }
    }
    pub const fn bits(self) -> u8 {
        self.0
    }
    pub const fn union(self, other: Self) -> Self {
        Self(self.0 | other.0)
    }
    pub const fn contains(self, other: Self) -> bool {
        self.0 & other.0 == other.0
    }

    pub const fn for_targets(targets: Targets) -> Self {
        let mut checks = Self::NONE;
        if targets.contains(Targets::WORKER) {
            checks = checks.union(Self::PRODUCT);
        }
        if targets.contains(Targets::IOS) {
            checks = checks.union(Self::PRODUCT);
        }
        if targets.contains(Targets::ANDROID) {
            checks = checks.union(Self::PRODUCT);
        }
        if targets.contains(Targets::CLOUDFLARE_ALERTS) || targets.contains(Targets::MONITORS) {
            checks = checks.union(Self::FAST).union(Self::OPERATIONS);
        }
        checks
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(kani, derive(kani::Arbitrary))]
pub enum Change {
    Presentation,
    WorkerConfiguration,
    ServerContract,
    Ios,
    Android,
    SharedSource,
    Dataset,
    CloudflareAlerts,
    Monitors,
    Automation,
    Documentation,
    Unknown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Impact {
    pub checks: Checks,
    pub suggested: Targets,
    pub unresolved: bool,
}

impl Impact {
    pub const NONE: Self = Self {
        checks: Checks::NONE,
        suggested: Targets::NONE,
        unresolved: false,
    };
    pub const fn union(self, other: Self) -> Self {
        Self {
            checks: self.checks.union(other.checks),
            suggested: self.suggested.union(other.suggested),
            unresolved: self.unresolved || other.unresolved,
        }
    }
}

pub const fn impact(change: Change) -> Impact {
    match change {
        Change::Presentation | Change::WorkerConfiguration => Impact {
            checks: Checks::FAST.union(Checks::WORKER),
            suggested: Targets::WORKER,
            unresolved: false,
        },
        Change::ServerContract => Impact {
            checks: Checks::PRODUCT,
            suggested: Targets::WORKER,
            unresolved: false,
        },
        Change::Ios => Impact {
            checks: Checks::for_targets(Targets::IOS),
            suggested: Targets::IOS,
            unresolved: false,
        },
        Change::Android => Impact {
            checks: Checks::for_targets(Targets::ANDROID),
            suggested: Targets::ANDROID,
            unresolved: false,
        },
        Change::SharedSource => Impact {
            checks: Checks::PRODUCT,
            suggested: Targets::PRODUCT,
            unresolved: false,
        },
        Change::Dataset => Impact {
            checks: Checks::for_targets(Targets::WORKER),
            suggested: Targets::WORKER,
            unresolved: false,
        },
        Change::CloudflareAlerts => Impact {
            checks: Checks::for_targets(Targets::CLOUDFLARE_ALERTS),
            suggested: Targets::CLOUDFLARE_ALERTS,
            unresolved: false,
        },
        Change::Monitors => Impact {
            checks: Checks::for_targets(Targets::MONITORS),
            suggested: Targets::MONITORS,
            unresolved: false,
        },
        Change::Automation => Impact {
            checks: Checks::ALL,
            suggested: Targets::NONE,
            unresolved: false,
        },
        Change::Documentation => Impact {
            checks: Checks::FAST,
            suggested: Targets::NONE,
            unresolved: false,
        },
        Change::Unknown => Impact {
            checks: Checks::ALL,
            suggested: Targets::NONE,
            unresolved: true,
        },
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Plan {
    pub targets: Targets,
    pub checks: Checks,
    pub selection_required: bool,
}

impl Plan {
    pub const fn new(changed: Impact, requested: Option<Targets>) -> Self {
        let targets = match requested {
            Some(targets) => targets,
            None => changed.suggested,
        };
        Self {
            targets,
            checks: changed.checks.union(Checks::for_targets(targets)),
            selection_required: changed.unresolved && requested.is_none(),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(kani, derive(kani::Arbitrary))]
pub enum ProviderOutcome {
    NotAttempted,
    AcceptedMatch,
    AcceptedOther,
    Rejected,
    Unknown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(kani, derive(kani::Arbitrary))]
pub struct Facts {
    pub requested: bool,
    pub candidate_matches: bool,
    pub checks_passed: bool,
    pub approved: bool,
    pub provider: ProviderOutcome,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Admission {
    NotRequested,
    IdentityMismatch,
    Conflict,
    Reconcile,
    Completed,
    EvidenceRequired,
    ApprovalRequired,
    Ready,
}

pub const fn admission(facts: Facts) -> Admission {
    if !facts.requested {
        return Admission::NotRequested;
    }
    if !facts.candidate_matches {
        return Admission::IdentityMismatch;
    }
    match facts.provider {
        ProviderOutcome::AcceptedOther => return Admission::Conflict,
        ProviderOutcome::Unknown => return Admission::Reconcile,
        ProviderOutcome::AcceptedMatch => return Admission::Completed,
        ProviderOutcome::NotAttempted | ProviderOutcome::Rejected => {}
    }
    if !facts.checks_passed {
        return Admission::EvidenceRequired;
    }
    if !facts.approved {
        return Admission::ApprovalRequired;
    }
    Admission::Ready
}

#[cfg(kani)]
mod proofs;

#[cfg_attr(kani, derive(kani::Arbitrary))]
#[derive(Clone, Copy)]
pub struct ArchiveFacts {
    pub format_matches: bool,
    pub unsigned: bool,
    pub build_matches: bool,
    pub version_matches: bool,
    pub sources_match: bool,
    pub files_match: bool,
    pub nonempty: bool,
}

pub const fn admit_archive(facts: ArchiveFacts) -> bool {
    facts.format_matches
        && facts.unsigned
        && facts.build_matches
        && facts.version_matches
        && facts.sources_match
        && facts.files_match
        && facts.nonempty
}

#[cfg_attr(kani, derive(kani::Arbitrary))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum JobOutcome {
    Success,
    Failure,
    Cancelled,
    Skipped,
}

pub fn checks_pass(required: [bool; 6], actual: [JobOutcome; 6]) -> bool {
    for (required, actual) in required.into_iter().zip(actual) {
        if actual
            != if required {
                JobOutcome::Success
            } else {
                JobOutcome::Skipped
            }
        {
            return false;
        }
    }
    true
}

pub const fn reuse_evidence(
    identity_matches: bool,
    commands_match: bool,
    environment_matches: bool,
    passed: bool,
) -> bool {
    identity_matches && commands_match && environment_matches && passed
}

pub const fn version_needed(change: Change, own: bool, other: bool) -> bool {
    if own {
        return true;
    }
    if other {
        return false;
    }
    matches!(
        change,
        Change::SharedSource | Change::Automation | Change::Unknown
    )
}

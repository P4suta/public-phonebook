use delivery_core::{
    Admission, Change, Checks, Facts, Impact, Plan, ProviderOutcome, Targets, admission, impact,
};

#[test]
fn presentation_changes_verify_and_publish_the_worker() {
    assert_eq!(
        impact(Change::Presentation),
        Impact {
            checks: Checks::FAST.union(Checks::WORKER),
            suggested: Targets::WORKER,
            unresolved: false,
        }
    );
}

#[test]
fn a_server_contract_change_requires_native_checks_without_native_publication() {
    let result = impact(Change::ServerContract);
    assert!(result.checks.contains(Checks::COMPATIBILITY));
    assert!(result.checks.contains(Checks::IOS));
    assert!(result.checks.contains(Checks::ANDROID));
    assert_eq!(result.suggested, Targets::WORKER);
}

#[test]
fn choosing_a_publication_target_cannot_remove_affected_checks() {
    let changed = impact(Change::SharedSource);
    let plan = Plan::new(changed, Some(Targets::IOS));
    assert_eq!(plan.targets, Targets::IOS);
    assert!(plan.checks.contains(changed.checks));
    assert!(!plan.selection_required);
}

#[test]
fn unknown_inputs_require_selection_and_broader_verification() {
    let unknown = impact(Change::Unknown);
    let automatic = Plan::new(unknown, None);
    assert_eq!(automatic.targets, Targets::NONE);
    assert_eq!(automatic.checks, Checks::ALL);
    assert!(automatic.selection_required);
    let selected = Plan::new(unknown, Some(Targets::WORKER));
    assert_eq!(selected.checks, Checks::ALL);
    assert!(!selected.selection_required);
}

#[test]
fn alerts_and_native_optimization_are_independent_operations() {
    let ios = Plan::new(impact(Change::Ios), None);
    assert_eq!(ios.targets, Targets::IOS);
    let alerts = Plan::new(impact(Change::CloudflareAlerts), None);
    assert_eq!(alerts.targets, Targets::CLOUDFLARE_ALERTS);
    assert!(!alerts.checks.contains(Checks::IOS));
    assert!(!alerts.checks.contains(Checks::ANDROID));
}

#[test]
fn publication_needs_exact_identity_evidence_and_approval() {
    let accepted = Facts {
        requested: true,
        candidate_matches: true,
        checks_passed: true,
        approved: true,
        provider: ProviderOutcome::NotAttempted,
    };
    assert_eq!(admission(accepted), Admission::Ready);
    assert_eq!(
        admission(Facts {
            approved: false,
            ..accepted
        }),
        Admission::ApprovalRequired
    );
    assert_eq!(
        admission(Facts {
            checks_passed: false,
            ..accepted
        }),
        Admission::EvidenceRequired
    );
    assert_eq!(
        admission(Facts {
            candidate_matches: false,
            ..accepted
        }),
        Admission::IdentityMismatch
    );
}

#[test]
fn accepted_or_unknown_provider_results_never_request_another_write() {
    let facts = Facts {
        requested: true,
        candidate_matches: true,
        checks_passed: true,
        approved: true,
        provider: ProviderOutcome::AcceptedMatch,
    };
    assert_eq!(admission(facts), Admission::Completed);
    assert_eq!(
        admission(Facts {
            provider: ProviderOutcome::Unknown,
            ..facts
        }),
        Admission::Reconcile
    );
    assert_eq!(
        admission(Facts {
            provider: ProviderOutcome::AcceptedOther,
            ..facts
        }),
        Admission::Conflict
    );
    assert_eq!(
        admission(Facts {
            requested: false,
            ..facts
        }),
        Admission::NotRequested
    );
}

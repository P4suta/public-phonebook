use super::*;

#[kani::proof]
fn explicit_store_build_codes_match_the_platform_range() {
    let value: u32 = kani::any();
    let number = BuildNumber::new(value);
    kani::cover!(number.is_some());
    kani::cover!(number.is_none());
    assert!(number.is_some() == (value > 0 && value <= BuildNumber::MAXIMUM));
    if let Some(number) = number {
        assert!(number.value() == value);
    }
}

#[kani::proof]
fn native_version_selection_preserves_shared_and_unknown_inputs() {
    let change: Change = kani::any();
    let own: bool = kani::any();
    let other: bool = kani::any();
    let selected = version_needed(change, own, other);
    kani::cover!(selected);
    kani::cover!(!selected);
    if own {
        assert!(selected);
    }
    if !own && other {
        assert!(!selected);
    }
    if !own && !other {
        assert!(
            selected
                == matches!(
                    change,
                    Change::SharedSource | Change::Automation | Change::Unknown
                )
        );
    }
}

#[kani::proof]
fn cached_evidence_requires_current_inputs_commands_environment_and_success() {
    let identity = kani::any();
    let commands = kani::any();
    let environment = kani::any();
    let passed = kani::any();
    kani::cover!(reuse_evidence(identity, commands, environment, passed));
    kani::cover!(!reuse_evidence(identity, commands, environment, passed));
    assert!(
        reuse_evidence(identity, commands, environment, passed)
            == (identity && commands && environment && passed)
    );
}

#[kani::proof]
#[kani::unwind(7)]
fn workflow_gate_requires_every_selected_check_to_succeed() {
    let required: [bool; 6] = kani::any();
    let actual: [JobOutcome; 6] = kani::any();
    kani::cover!(checks_pass(required, actual));
    kani::cover!(!checks_pass(required, actual));
    let mut expected = true;
    for (required, actual) in required.into_iter().zip(actual) {
        expected &= if required {
            actual == JobOutcome::Success
        } else {
            actual == JobOutcome::Skipped
        };
    }
    assert!(checks_pass(required, actual) == expected);
}

#[kani::proof]
fn signing_requires_an_exact_nonempty_unsigned_archive() {
    let facts: ArchiveFacts = kani::any();
    kani::cover!(admit_archive(facts));
    kani::cover!(!admit_archive(facts));
    assert!(
        admit_archive(facts)
            == (facts.format_matches
                && facts.unsigned
                && facts.build_matches
                && facts.version_matches
                && facts.sources_match
                && facts.files_match
                && facts.nonempty)
    );
}

#[kani::proof]
fn store_build_numbers_are_positive_and_bounded() {
    let run: u32 = kani::any();
    kani::cover!(BuildNumber::from_run(run).is_some());
    kani::cover!(BuildNumber::from_run(run).is_none());
    if let Some(number) = BuildNumber::from_run(run) {
        assert!(run > 0 && number.value() > 0 && number.value() <= BuildNumber::MAXIMUM);
        assert!(number.value() == run * BuildNumber::RUN_STRIDE + BuildNumber::FIRST_ATTEMPT);
    }
}

#[kani::proof]
fn accepted_run_numbers_preserve_order_and_identity() {
    let first: u32 = kani::any();
    let second: u32 = kani::any();
    kani::cover!(
        first < second
            && BuildNumber::from_run(first).is_some()
            && BuildNumber::from_run(second).is_some()
    );
    kani::cover!(first == second && BuildNumber::from_run(first).is_some());
    if let (Some(left), Some(right)) = (BuildNumber::from_run(first), BuildNumber::from_run(second))
    {
        assert!((first < second) == (left < right));
        assert!((first == second) == (left == right));
    }
}

#[kani::proof]
#[kani::unwind(19)]
fn accepted_versions_contain_only_decimal_components() {
    let bytes: [u8; Version::MAXIMUM_BYTES] = kani::any();
    let length: usize = kani::any();
    kani::assume(length <= Version::MAXIMUM_BYTES);
    let input = &bytes[..length];
    kani::cover!(Version::parse(input).is_ok());
    kani::cover!(Version::parse(input).is_err());
    if Version::parse(input).is_ok() {
        let mut dots = 0_u8;
        for byte in input {
            assert!(byte.is_ascii_digit() || *byte == b'.');
            if *byte == b'.' {
                dots += 1;
            }
        }
        assert!(dots == 2);
    }
}

#[kani::proof]
fn oversized_versions_are_refused_before_parsing() {
    let input: [u8; Version::MAXIMUM_BYTES + 1] = kani::any();
    let result = Version::parse(&input);
    kani::cover!(input.len() > Version::MAXIMUM_BYTES);
    kani::cover!(result == Err(InvalidVersion::Length));
    assert!(result == Err(InvalidVersion::Length));
}

#[kani::proof]
fn ready_requires_requested_exact_verified_approved_candidate() {
    let facts: Facts = kani::any();
    kani::cover!(admission(facts) == Admission::Ready);
    kani::cover!(admission(facts) == Admission::EvidenceRequired);
    if admission(facts) == Admission::Ready {
        assert!(
            facts.requested && facts.candidate_matches && facts.checks_passed && facts.approved
        );
        assert!(matches!(
            facts.provider,
            ProviderOutcome::NotAttempted | ProviderOutcome::Rejected
        ));
    }
}

#[kani::proof]
fn accepted_and_unknown_outcomes_never_request_another_write() {
    let facts: Facts = kani::any();
    kani::cover!(facts.provider == ProviderOutcome::AcceptedMatch);
    kani::cover!(facts.provider == ProviderOutcome::Unknown);
    if matches!(
        facts.provider,
        ProviderOutcome::AcceptedMatch | ProviderOutcome::AcceptedOther | ProviderOutcome::Unknown
    ) {
        assert!(admission(facts) != Admission::Ready);
    }
}

#[kani::proof]
fn completed_requires_an_exact_accepted_candidate() {
    let facts: Facts = kani::any();
    kani::cover!(admission(facts) == Admission::Completed);
    kani::cover!(admission(facts) == Admission::IdentityMismatch);
    if admission(facts) == Admission::Completed {
        assert!(facts.requested && facts.candidate_matches);
        assert!(facts.provider == ProviderOutcome::AcceptedMatch);
    }
}

#[kani::proof]
fn unrequested_operations_do_not_write() {
    let facts: Facts = kani::any();
    kani::cover!(!facts.requested);
    kani::cover!(facts.requested);
    if !facts.requested {
        assert!(admission(facts) == Admission::NotRequested);
    }
}

#[kani::proof]
fn selection_never_removes_affected_checks() {
    let change: Change = kani::any();
    let Some(requested) = Targets::from_bits(kani::any()) else {
        return;
    };
    let affected = impact(change);
    let plan = Plan::new(affected, Some(requested));
    kani::cover!(requested == Targets::IOS);
    kani::cover!(requested == Targets::WORKER);
    assert!(plan.checks.contains(affected.checks));
    assert!(plan.checks.contains(Checks::for_targets(requested)));
    assert!(plan.targets == requested);
}

#[kani::proof]
fn unknown_changes_require_selection_and_full_verification() {
    let plan = Plan::new(impact(Change::Unknown), None);
    kani::cover!(plan.selection_required);
    kani::cover!(plan.checks == Checks::ALL);
    assert!(plan.selection_required);
    assert!(plan.targets == Targets::NONE);
    assert!(plan.checks == Checks::ALL);
}

#[kani::proof]
fn shared_contract_checks_do_not_force_native_publication() {
    let plan = Plan::new(impact(Change::ServerContract), None);
    kani::cover!(plan.checks.contains(Checks::IOS));
    kani::cover!(plan.targets == Targets::WORKER);
    assert!(
        plan.checks.contains(
            Checks::IOS
                .union(Checks::ANDROID)
                .union(Checks::COMPATIBILITY)
        )
    );
    assert!(plan.targets == Targets::WORKER);
}

#[kani::proof]
fn extra_targets_cannot_reduce_verification() {
    let Some(first) = Targets::from_bits(kani::any()) else {
        return;
    };
    let Some(extra) = Targets::from_bits(kani::any()) else {
        return;
    };
    kani::cover!(first == Targets::NONE && extra == Targets::IOS);
    kani::cover!(first == Targets::WORKER && extra == Targets::ANDROID);
    assert!(Checks::for_targets(first.union(extra)).contains(Checks::for_targets(first)));
}

#[kani::proof]
fn combined_impacts_preserve_each_requirement() {
    let first = impact(kani::any());
    let second = impact(kani::any());
    let combined = first.union(second);
    kani::cover!(combined.unresolved);
    kani::cover!(!combined.unresolved);
    assert!(combined.checks.contains(first.checks) && combined.checks.contains(second.checks));
    assert!(
        combined.suggested.contains(first.suggested)
            && combined.suggested.contains(second.suggested)
    );
    assert!(combined == second.union(first));
}

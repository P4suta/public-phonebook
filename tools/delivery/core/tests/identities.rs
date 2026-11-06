use delivery_core::{BuildNumber, Version};

#[test]
fn versions_are_canonical_three_component_numbers() {
    assert_eq!(
        Version::parse(b"1.2.3").map(|v| (v.major(), v.minor(), v.patch())),
        Ok((1, 2, 3))
    );
    assert!(Version::parse(b"65535.65535.65535").is_ok());
    for invalid in [
        b"".as_slice(),
        b"1.0",
        b"1.2.3.4",
        b"01.2.3",
        b"1.02.3",
        b"1.2.03",
        b"65536.1.1",
        b"1.2.-3",
        b"1.2.3-beta",
        b" 1.2.3",
        b"1.2.3\n",
        b"\xff.0.0",
    ] {
        assert!(Version::parse(invalid).is_err(), "{invalid:?}");
    }
}

#[test]
fn store_numbers_are_positive_bounded_and_stable_for_a_run() {
    assert_eq!(
        BuildNumber::from_run(42).map(BuildNumber::value),
        Some(4201)
    );
    assert!(BuildNumber::new(0).is_none());
    assert!(BuildNumber::new(BuildNumber::MAXIMUM + 1).is_none());
    assert!(BuildNumber::from_run(0).is_none());
    assert!(BuildNumber::from_run(u32::MAX).is_none());
    let mut previous = None;
    for run in 1..=1000 {
        let current = BuildNumber::from_run(run);
        assert!(current > previous);
        previous = current;
    }
}

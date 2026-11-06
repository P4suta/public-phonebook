use anyhow::{Context, Result, ensure};
use std::fmt;

const ATTEMPTS_PER_RUN: u32 = 100;
const LOCAL_BUILD: u32 = 1;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct BuildNumber(u32);

impl BuildNumber {
    pub const LOCAL: Self = Self(LOCAL_BUILD);

    pub fn new(value: u32) -> Result<Self> {
        delivery_core::BuildNumber::new(value)
            .map(|number| Self(number.value()))
            .context("Build number is outside the store range")
    }

    pub fn from_run(run_number: u32, run_attempt: u32) -> Result<Self> {
        ensure!(run_number > 0, "Workflow run numbers start at 1");
        ensure!(
            (1..ATTEMPTS_PER_RUN).contains(&run_attempt),
            "Workflow run attempt {run_attempt} is outside the 1 to {} attempts a build number can encode",
            ATTEMPTS_PER_RUN - 1
        );
        delivery_core::BuildNumber::from_run(run_number)
            .map(|number| Self(number.value()))
            .context("Workflow run number exceeds the build number range")
    }

    pub fn value(self) -> u32 {
        self.0
    }

    pub fn is_ci(self) -> bool {
        self.0 > ATTEMPTS_PER_RUN
    }
}

impl fmt::Display for BuildNumber {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RUNS: u32 = 300;

    #[test]
    fn run_numbers_increase_and_attempts_preserve_the_original_identity() -> Result<()> {
        let mut previous = BuildNumber::LOCAL;
        for run in 1..=RUNS {
            let next = BuildNumber::from_run(run, 1)?;
            assert!(next > previous, "{run} did not increase");
            for attempt in 1..ATTEMPTS_PER_RUN {
                assert_eq!(next, BuildNumber::from_run(run, attempt)?);
                assert!(next.is_ci());
            }
            previous = next;
        }
        assert_eq!(BuildNumber::from_run(1, 1)?.to_string(), "101");
        assert_eq!(BuildNumber::from_run(42, 3)?.value(), 4201);
        assert_eq!(
            BuildNumber::from_run(
                delivery_core::BuildNumber::MAXIMUM / ATTEMPTS_PER_RUN - 1,
                1
            )?
            .value(),
            delivery_core::BuildNumber::MAXIMUM - ATTEMPTS_PER_RUN + 1
        );
        Ok(())
    }

    #[test]
    fn run_inputs_outside_the_encoding_are_refused() {
        for (run, attempt) in [
            (0, 1),
            (1, 0),
            (1, ATTEMPTS_PER_RUN),
            (1, u32::MAX),
            (u32::MAX / ATTEMPTS_PER_RUN + 1, 1),
            (delivery_core::BuildNumber::MAXIMUM / ATTEMPTS_PER_RUN, 1),
            (u32::MAX, ATTEMPTS_PER_RUN - 1),
        ] {
            assert!(
                BuildNumber::from_run(run, attempt).is_err(),
                "{run} {attempt}"
            );
        }
    }

    #[test]
    fn explicit_build_numbers_are_positive_and_local_builds_are_not_ci() -> Result<()> {
        assert_eq!(BuildNumber::new(4203)?.to_string(), "4203");
        assert_eq!(BuildNumber::new(LOCAL_BUILD)?, BuildNumber::LOCAL);
        assert!(BuildNumber::new(0).is_err());
        assert!(!BuildNumber::LOCAL.is_ci());
        assert!(!BuildNumber::new(ATTEMPTS_PER_RUN)?.is_ci());
        assert!(BuildNumber::new(ATTEMPTS_PER_RUN + 1)?.is_ci());
        Ok(())
    }
}

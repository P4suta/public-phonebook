use core::fmt;

const DECIMAL_RADIX: u16 = 10;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Version {
    major: u16,
    minor: u16,
    patch: u16,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InvalidVersion {
    Length,
    Syntax,
    Range,
}

enum Part {
    Major,
    Minor,
    Patch,
}

impl Version {
    pub const MAXIMUM_BYTES: usize = 17;

    pub fn parse(input: &[u8]) -> Result<Self, InvalidVersion> {
        if input.is_empty() || input.len() > Self::MAXIMUM_BYTES {
            return Err(InvalidVersion::Length);
        }
        let mut major = 0;
        let mut minor = 0;
        let mut current = 0_u16;
        let mut part = Part::Major;
        let mut digit_seen = false;
        let mut leading_zero = false;
        for byte in input {
            if *byte == b'.' {
                if !digit_seen {
                    return Err(InvalidVersion::Syntax);
                }
                part = match part {
                    Part::Major => {
                        major = current;
                        Part::Minor
                    }
                    Part::Minor => {
                        minor = current;
                        Part::Patch
                    }
                    Part::Patch => return Err(InvalidVersion::Syntax),
                };
                current = 0;
                digit_seen = false;
                leading_zero = false;
            } else {
                if !byte.is_ascii_digit() || leading_zero {
                    return Err(InvalidVersion::Syntax);
                }
                let digit = u16::from(*byte - b'0');
                current = current
                    .checked_mul(DECIMAL_RADIX)
                    .and_then(|value| value.checked_add(digit))
                    .ok_or(InvalidVersion::Range)?;
                leading_zero = !digit_seen && digit == 0;
                digit_seen = true;
            }
        }
        if !matches!(part, Part::Patch) || !digit_seen {
            return Err(InvalidVersion::Syntax);
        }
        Ok(Self {
            major,
            minor,
            patch: current,
        })
    }

    pub const fn major(self) -> u16 {
        self.major
    }
    pub const fn minor(self) -> u16 {
        self.minor
    }
    pub const fn patch(self) -> u16 {
        self.patch
    }
}

impl fmt::Display for Version {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}.{}.{}", self.major, self.minor, self.patch)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct BuildNumber(u32);

impl BuildNumber {
    pub const MAXIMUM: u32 = 2_100_000_000;
    pub const RUN_STRIDE: u32 = 100;
    pub const FIRST_ATTEMPT: u32 = 1;

    pub const fn new(value: u32) -> Option<Self> {
        if value > 0 && value <= Self::MAXIMUM {
            Some(Self(value))
        } else {
            None
        }
    }

    pub const fn from_run(run: u32) -> Option<Self> {
        if run == 0 {
            return None;
        }
        let Some(base) = run.checked_mul(Self::RUN_STRIDE) else {
            return None;
        };
        let Some(value) = base.checked_add(Self::FIRST_ATTEMPT) else {
            return None;
        };
        Self::new(value)
    }

    pub const fn value(self) -> u32 {
        self.0
    }
}

impl fmt::Display for BuildNumber {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

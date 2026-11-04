//! The machine lease for iOS commands that use the simulator, Xcode, or the fixture port on this Mac.
//!
//! The lease is a `flock` on a fixed file, the same lock that `lockf -k` takes, so the kernel releases it when its holder exits and no file is ever deleted.

use anyhow::{Context, Result, bail};
use std::{
    fs::{File, TryLockError},
    path::Path,
    thread,
    time::{Duration, Instant},
};

pub const MACHINE_LEASE: &str = "/tmp/public-phonebook-ios-gate.flock";
const POLL: Duration = Duration::from_secs(30);
const SECONDS_PER_MINUTE: u64 = 60;
const LONGEST_WAIT: Duration = Duration::from_secs(90 * SECONDS_PER_MINUTE);

/// Holds the machine lease until it drops, when closing the file releases the lock.
pub struct MachineLease {
    _file: File,
}

impl MachineLease {
    /// Waits up to 90 minutes for the lease, polling every 30 seconds.
    pub fn acquire() -> Result<Self> {
        Self::acquire_at(Path::new(MACHINE_LEASE), POLL, LONGEST_WAIT)
    }

    fn acquire_at(path: &Path, poll: Duration, longest: Duration) -> Result<Self> {
        let file = File::options()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(path)
            .with_context(|| format!("Open {}", path.display()))?;
        let started = Instant::now();
        let mut announced = false;
        loop {
            match file.try_lock() {
                Ok(()) => return Ok(Self { _file: file }),
                Err(TryLockError::WouldBlock) => {}
                Err(TryLockError::Error(error)) => {
                    return Err(error).with_context(|| format!("Lock {}", path.display()));
                }
            }
            let waited = started.elapsed();
            if waited >= longest {
                bail!(
                    "Inconclusive: another iOS command held {} for {} s",
                    path.display(),
                    waited.as_secs()
                );
            }
            if !announced {
                println!(
                    "iOS check: waiting for {}, which another iOS command holds",
                    path.display()
                );
                announced = true;
            }
            thread::sleep(poll.min(longest.saturating_sub(waited)));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    const SHORT: Duration = Duration::from_millis(10);
    const LONG: Duration = Duration::from_secs(5);
    /// `lockf` exits with `EX_TEMPFAIL` when its wait runs out.
    const LOCKF_TIMED_OUT: i32 = 75;

    fn lease_path() -> Result<(tempfile::TempDir, std::path::PathBuf)> {
        let parent = tempfile::tempdir()?;
        let path = parent.path().join("gate.flock");
        Ok((parent, path))
    }

    #[test]
    fn a_free_lease_is_taken_and_released_without_deleting_its_file() -> Result<()> {
        let (_parent, path) = lease_path()?;
        let lease = MachineLease::acquire_at(&path, SHORT, LONG)?;
        drop(lease);
        assert!(path.exists());
        let _again = MachineLease::acquire_at(&path, SHORT, SHORT)?;
        Ok(())
    }

    #[test]
    fn a_holder_is_waited_for_until_it_releases_the_lease() -> Result<()> {
        let (_parent, path) = lease_path()?;
        let holder = MachineLease::acquire_at(&path, SHORT, LONG)?;
        let releaser = thread::spawn(move || {
            thread::sleep(SHORT * 5);
            drop(holder);
        });
        let _lease = MachineLease::acquire_at(&path, SHORT, LONG)?;
        releaser
            .join()
            .map_err(|_| anyhow::anyhow!("releaser panicked"))?;
        Ok(())
    }

    #[test]
    fn a_wait_that_runs_out_is_inconclusive() -> Result<()> {
        let (_parent, path) = lease_path()?;
        let _holder = MachineLease::acquire_at(&path, SHORT, LONG)?;
        let error = MachineLease::acquire_at(&path, SHORT, SHORT * 3)
            .err()
            .context("The held lease was acquired")?;
        assert!(error.to_string().starts_with("Inconclusive:"));
        Ok(())
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn the_lease_and_lockf_exclude_each_other() -> Result<()> {
        let (_parent, path) = lease_path()?;
        let lease = MachineLease::acquire_at(&path, SHORT, LONG)?;
        let blocked = Command::new("lockf")
            .args(["-k", "-t", "0"])
            .arg(&path)
            .arg("true")
            .status()?;
        assert_eq!(blocked.code(), Some(LOCKF_TIMED_OUT));
        drop(lease);
        let free = Command::new("lockf")
            .args(["-k", "-t", "0"])
            .arg(&path)
            .arg("true")
            .status()?;
        assert!(free.success());
        Ok(())
    }
}

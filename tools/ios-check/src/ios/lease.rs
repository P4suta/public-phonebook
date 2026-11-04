//! The machine lease for iOS commands that use the simulator, Xcode, or the fixture port on this Mac.
//!
//! The lease is the directory that agents on this Mac create with `mkdir`, with the holder's process ID inside.

use anyhow::{Context, Result, bail};
use std::{
    fs, io,
    path::{Path, PathBuf},
    thread,
    time::{Duration, Instant},
};

pub const MACHINE_LEASE: &str = "/tmp/public-phonebook-ios-gate.lock";
const HOLDER_FILE: &str = "pid";
const POLL: Duration = Duration::from_secs(30);
const SECONDS_PER_MINUTE: u64 = 60;
const LONGEST_WAIT: Duration = Duration::from_secs(90 * SECONDS_PER_MINUTE);

/// Holds the machine lease until it drops.
pub struct MachineLease {
    directory: PathBuf,
}

fn alive(pid: u32) -> bool {
    let Ok(pid) = libc::pid_t::try_from(pid) else {
        return false;
    };
    // SAFETY: signal 0 only checks whether the process exists and may receive signals.
    if unsafe { libc::kill(pid, 0) } == 0 {
        return true;
    }
    io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

fn holder(directory: &Path) -> Option<u32> {
    fs::read_to_string(directory.join(HOLDER_FILE))
        .ok()
        .and_then(|text| text.trim().parse().ok())
}

impl MachineLease {
    /// Waits up to 90 minutes for the lease, polling every 30 seconds, and takes over a lease whose holder no longer runs.
    pub fn acquire() -> Result<Self> {
        Self::acquire_at(Path::new(MACHINE_LEASE), POLL, LONGEST_WAIT, alive)
    }

    fn acquire_at(
        directory: &Path,
        poll: Duration,
        longest: Duration,
        is_alive: impl Fn(u32) -> bool,
    ) -> Result<Self> {
        let started = Instant::now();
        let mut announced = None;
        loop {
            match fs::create_dir(directory) {
                Ok(()) => {
                    if let Err(error) = fs::write(
                        directory.join(HOLDER_FILE),
                        format!("{}\n", std::process::id()),
                    ) {
                        if let Err(cleanup) = fs::remove_dir_all(directory) {
                            eprintln!(
                                "iOS check: {} could not be removed: {cleanup}",
                                directory.display()
                            );
                        }
                        return Err(error).with_context(|| {
                            format!("Record this process in {}", directory.display())
                        });
                    }
                    return Ok(Self {
                        directory: directory.to_owned(),
                    });
                }
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
                Err(error) => {
                    return Err(error).with_context(|| format!("Create {}", directory.display()));
                }
            }
            let current = holder(directory);
            if let Some(pid) = current
                && !is_alive(pid)
            {
                println!(
                    "iOS check: removing {} left by process {pid}, which no longer runs",
                    directory.display()
                );
                match fs::remove_dir_all(directory) {
                    Ok(()) => continue,
                    Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
                    Err(error) => {
                        return Err(error)
                            .with_context(|| format!("Remove {}", directory.display()));
                    }
                }
            }
            let waited = started.elapsed();
            if waited >= longest {
                bail!(
                    "Inconclusive: {} stayed held by process {} for {} s",
                    directory.display(),
                    current.map_or_else(|| "unknown".to_owned(), |pid| pid.to_string()),
                    waited.as_secs()
                );
            }
            if announced != Some(current) {
                println!(
                    "iOS check: waiting for {}, held by process {}",
                    directory.display(),
                    current.map_or_else(|| "unknown".to_owned(), |pid| pid.to_string())
                );
                announced = Some(current);
            }
            thread::sleep(poll.min(longest.saturating_sub(waited)));
        }
    }
}

impl Drop for MachineLease {
    fn drop(&mut self) {
        if holder(&self.directory) != Some(std::process::id()) {
            eprintln!(
                "iOS check: {} no longer names this process, so it stays",
                self.directory.display()
            );
            return;
        }
        if let Err(error) = fs::remove_dir_all(&self.directory) {
            eprintln!(
                "iOS check: {} could not be removed; the next run removes it once this process exits: {error}",
                self.directory.display()
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SHORT: Duration = Duration::from_millis(10);
    const LONG: Duration = Duration::from_secs(5);
    const ABSENT_PROCESS: u32 = 999_999;

    fn lease_path() -> Result<(tempfile::TempDir, PathBuf)> {
        let parent = tempfile::tempdir()?;
        let path = parent.path().join("gate.lock");
        Ok((parent, path))
    }

    #[test]
    fn a_free_lease_records_this_process_and_drops_cleanly() -> Result<()> {
        let (_parent, path) = lease_path()?;
        let lease = MachineLease::acquire_at(&path, SHORT, LONG, |_| true)?;
        assert_eq!(holder(&path), Some(std::process::id()));
        drop(lease);
        assert!(!path.exists());
        Ok(())
    }

    #[test]
    fn a_lease_of_a_process_that_no_longer_runs_is_taken_over() -> Result<()> {
        let (_parent, path) = lease_path()?;
        fs::create_dir(&path)?;
        fs::write(path.join(HOLDER_FILE), format!("{ABSENT_PROCESS}\n"))?;
        let _lease = MachineLease::acquire_at(&path, SHORT, LONG, |pid| pid != ABSENT_PROCESS)?;
        assert_eq!(holder(&path), Some(std::process::id()));
        Ok(())
    }

    #[test]
    fn a_live_holder_is_waited_for_until_it_releases_the_lease() -> Result<()> {
        let (_parent, path) = lease_path()?;
        fs::create_dir(&path)?;
        fs::write(path.join(HOLDER_FILE), format!("{ABSENT_PROCESS}\n"))?;
        let released = path.clone();
        let releaser = thread::spawn(move || {
            thread::sleep(SHORT * 5);
            fs::remove_dir_all(released)
        });
        let _lease = MachineLease::acquire_at(&path, SHORT, LONG, |_| true)?;
        releaser
            .join()
            .map_err(|_| anyhow::anyhow!("releaser panicked"))??;
        assert_eq!(holder(&path), Some(std::process::id()));
        Ok(())
    }

    #[test]
    fn a_wait_that_runs_out_is_inconclusive_and_leaves_the_holder_alone() -> Result<()> {
        let (_parent, path) = lease_path()?;
        fs::create_dir(&path)?;
        fs::write(path.join(HOLDER_FILE), format!("{ABSENT_PROCESS}\n"))?;
        let error = MachineLease::acquire_at(&path, SHORT, SHORT * 3, |_| true)
            .err()
            .context("The held lease was acquired")?;
        assert!(error.to_string().starts_with("Inconclusive:"));
        assert_eq!(holder(&path), Some(ABSENT_PROCESS));
        Ok(())
    }

    #[test]
    fn this_process_is_alive_and_an_absent_one_is_not() {
        assert!(alive(std::process::id()));
        assert!(!alive(ABSENT_PROCESS));
    }
}

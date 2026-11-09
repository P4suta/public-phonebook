//! Reads the instruction and memory counters that macOS keeps for each process.
//!
//! A count covers one process and the programs it execs, never the processes it forks.

use std::io::{self, Read};
use std::process::{Child, Command, ExitStatus, Output, Stdio};
use std::thread;

/// What the kernel counted for one exited child before it was reaped.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ChildUsage {
    pub instructions: u64,
    /// The child reaped a process of its own, whose instructions `instructions` omits.
    pub reaped_descendants: bool,
}

#[cfg(target_os = "macos")]
fn usage(pid: libc::pid_t) -> io::Result<libc::rusage_info_v4> {
    let mut usage = std::mem::MaybeUninit::<libc::rusage_info_v4>::zeroed();
    // SAFETY: the buffer has the size and alignment of the requested `RUSAGE_INFO_V4` layout.
    let status =
        unsafe { libc::proc_pid_rusage(pid, libc::RUSAGE_INFO_V4, usage.as_mut_ptr().cast()) };
    if status != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: `proc_pid_rusage` filled the whole structure.
    Ok(unsafe { usage.assume_init() })
}

/// The retired instructions of a live process, excluding every process it has reaped.
#[cfg(target_os = "macos")]
pub fn process_instructions(pid: u32) -> io::Result<u64> {
    let pid = libc::pid_t::try_from(pid).map_err(|_| io::ErrorKind::InvalidInput)?;
    Ok(usage(pid)?.ri_instructions)
}

#[cfg(not(target_os = "macos"))]
pub fn process_instructions(_pid: u32) -> io::Result<u64> {
    Err(io::ErrorKind::Unsupported.into())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ProcessMemory {
    physical_footprint: u64,
    lifetime_peak_physical_footprint: u64,
}

impl ProcessMemory {
    #[cfg(any(target_os = "macos", test))]
    fn checked(current: u64, peak: u64) -> io::Result<Self> {
        if current == 0 || peak == 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!(
                    "Missing physical footprint counters: current={current}, lifetime_peak={peak}"
                ),
            ));
        }
        Ok(Self {
            physical_footprint: current,
            lifetime_peak_physical_footprint: peak,
        })
    }
    pub fn physical_footprint_bytes(self) -> u64 {
        self.physical_footprint
    }
    pub fn lifetime_peak_physical_footprint_bytes(self) -> u64 {
        self.lifetime_peak_physical_footprint
    }
}

#[cfg(any(target_os = "macos", test))]
fn read_memory(mut read: impl FnMut() -> io::Result<(u64, u64)>) -> io::Result<ProcessMemory> {
    let (current, peak) = read()?;
    let mut sample = ProcessMemory::checked(current, peak);
    for _ in 1..3 {
        if sample.is_ok() {
            return sample;
        }
        let (current, peak) = read()?;
        sample = ProcessMemory::checked(current, peak);
    }
    sample
}

#[cfg(target_os = "macos")]
pub fn process_memory(pid: u32) -> io::Result<ProcessMemory> {
    if pid == 0 {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    let pid = libc::pid_t::try_from(pid).map_err(|_| io::ErrorKind::InvalidInput)?;
    read_memory(|| {
        let snapshot = usage(pid)?;
        Ok((
            snapshot.ri_phys_footprint,
            snapshot.ri_lifetime_max_phys_footprint,
        ))
    })
}

#[cfg(not(target_os = "macos"))]
pub fn process_memory(_pid: u32) -> io::Result<ProcessMemory> {
    Err(io::ErrorKind::Unsupported.into())
}

/// An exited and reaped child, with its counts when the system keeps them.
#[derive(Debug)]
pub struct Measured {
    pub status: ExitStatus,
    pub usage: io::Result<ChildUsage>,
}

#[cfg(target_os = "macos")]
fn exited_usage(pid: u32) -> io::Result<ChildUsage> {
    let pid = libc::pid_t::try_from(pid).map_err(|_| io::ErrorKind::InvalidInput)?;
    loop {
        let mut info = std::mem::MaybeUninit::<libc::siginfo_t>::zeroed();
        // SAFETY: `info` is writable, and `WNOWAIT` leaves the child for `Child::wait` to reap.
        let status = unsafe {
            libc::waitid(
                libc::P_PID,
                libc::id_t::try_from(pid).map_err(|_| io::ErrorKind::InvalidInput)?,
                info.as_mut_ptr(),
                libc::WEXITED | libc::WNOWAIT,
            )
        };
        if status == 0 {
            break;
        }
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::Interrupted {
            return Err(error);
        }
    }
    let measured = usage(pid)?;
    Ok(ChildUsage {
        instructions: measured.ri_instructions,
        reaped_descendants: measured.ri_child_elapsed_abstime != 0,
    })
}

#[cfg(not(target_os = "macos"))]
fn exited_usage(_pid: u32) -> io::Result<ChildUsage> {
    Err(io::ErrorKind::Unsupported.into())
}

/// Waits for `child` to exit, reads its counts while the kernel still keeps them, and then reaps it.
pub fn wait_measured(child: &mut Child) -> io::Result<Measured> {
    let usage = exited_usage(child.id());
    let status = child.wait()?;
    Ok(Measured { status, usage })
}

fn drain(stream: Option<impl Read + Send + 'static>) -> thread::JoinHandle<io::Result<Vec<u8>>> {
    thread::spawn(move || {
        let mut bytes = Vec::new();
        if let Some(mut stream) = stream {
            stream.read_to_end(&mut bytes)?;
        }
        Ok(bytes)
    })
}

fn joined(reader: thread::JoinHandle<io::Result<Vec<u8>>>) -> io::Result<Vec<u8>> {
    reader
        .join()
        .map_err(|_| io::Error::other("an output reader panicked"))?
}

/// Runs `command` like `Command::output`, and reads the child's counts before reaping it.
pub fn output_measured(command: &mut Command) -> io::Result<(Output, io::Result<ChildUsage>)> {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let stdout = drain(child.stdout.take());
    let stderr = drain(child.stderr.take());
    let measured = wait_measured(&mut child)?;
    Ok((
        Output {
            status: measured.status,
            stdout: joined(stdout)?,
            stderr: joined(stderr)?,
        },
        measured.usage,
    ))
}

#[cfg(test)]
mod memory_tests {
    use super::*;

    #[test]
    fn lagging_lifetime_peaks_do_not_discard_the_current_footprint() -> io::Result<()> {
        let memory = read_memory(|| Ok((57_623_944, 57_607_560)))?;
        assert_eq!(memory.physical_footprint_bytes(), 57_623_944);
        assert_eq!(memory.lifetime_peak_physical_footprint_bytes(), 57_607_560);
        Ok(())
    }

    #[test]
    fn counter_reads_require_positive_values_within_three_attempts() -> io::Result<()> {
        let mut readings = [(0, 0), (5, 0), (5, 6)].into_iter();
        let memory = read_memory(|| {
            readings
                .next()
                .ok_or_else(|| io::ErrorKind::UnexpectedEof.into())
        })?;
        assert_eq!(memory.physical_footprint_bytes(), 5);
        assert_eq!(memory.lifetime_peak_physical_footprint_bytes(), 6);
        let mut calls = 0;
        let missing = read_memory(|| {
            calls += 1;
            Ok((0, 4))
        });
        assert_eq!(
            missing.map_err(|error| error.kind()),
            Err(io::ErrorKind::InvalidData)
        );
        assert_eq!(calls, 3);
        Ok(())
    }

    #[test]
    fn native_read_errors_are_not_replaced_with_zero_or_retried() {
        let mut calls = 0;
        let missing = read_memory(|| {
            calls += 1;
            Err(io::ErrorKind::PermissionDenied.into())
        });
        assert_eq!(
            missing.map_err(|error| error.kind()),
            Err(io::ErrorKind::PermissionDenied)
        );
        assert_eq!(calls, 1);
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    const SHELL: &str = "/bin/sh";

    #[test]
    fn native_memory_has_positive_footprints_and_rejects_invalid_processes() -> io::Result<()> {
        let memory = process_memory(std::process::id())?;
        assert!(memory.physical_footprint_bytes() > 0);
        assert!(memory.lifetime_peak_physical_footprint_bytes() > 0);
        assert!(process_memory(0).is_err());
        assert!(process_memory(u32::MAX).is_err());
        Ok(())
    }

    fn measured(script: &str) -> io::Result<ChildUsage> {
        let mut child = Command::new(SHELL).args(["-c", script]).spawn()?;
        let measured = wait_measured(&mut child)?;
        assert!(measured.status.success());
        measured.usage
    }

    #[test]
    fn a_child_that_only_runs_builtins_is_counted_completely() -> io::Result<()> {
        let usage = measured("i=0; while [ $i -lt 20000 ]; do i=$((i+1)); done")?;
        assert!(usage.instructions > 0);
        assert!(!usage.reaped_descendants);
        Ok(())
    }

    #[test]
    fn a_child_that_forks_reports_its_reaped_descendant() -> io::Result<()> {
        assert!(measured("/usr/bin/true; true")?.reaped_descendants);
        Ok(())
    }

    #[test]
    fn a_forked_loop_stays_out_of_the_parent_count() -> io::Result<()> {
        let loop_script = "i=0; while [ $i -lt 20000 ]; do i=$((i+1)); done";
        let direct = measured(loop_script)?;
        let forked = measured(&format!("{SHELL} -c '{loop_script}'; true"))?;
        assert!(forked.instructions < direct.instructions / 2);
        Ok(())
    }

    #[test]
    fn captured_output_keeps_both_streams_the_status_and_the_count() -> io::Result<()> {
        let (output, usage) =
            output_measured(Command::new(SHELL).args(["-c", "echo out; echo err >&2; exit 3"]))?;
        assert_eq!(output.stdout, b"out\n");
        assert_eq!(output.stderr, b"err\n");
        assert_eq!(output.status.code(), Some(3));
        assert!(usage?.instructions > 0);
        Ok(())
    }

    #[test]
    fn the_current_process_has_a_count() -> io::Result<()> {
        assert!(process_instructions(std::process::id())? > 0);
        Ok(())
    }
}

#[cfg(all(test, not(target_os = "macos")))]
mod tests {
    use super::*;

    #[test]
    fn other_systems_report_no_count_and_keep_the_exit_status() -> io::Result<()> {
        assert_eq!(
            process_memory(std::process::id()).map_err(|error| error.kind()),
            Err(io::ErrorKind::Unsupported)
        );
        assert_eq!(
            process_instructions(std::process::id()).map_err(|error| error.kind()),
            Err(io::ErrorKind::Unsupported)
        );
        let mut child = std::process::Command::new("false").spawn()?;
        let measured = wait_measured(&mut child)?;
        assert!(!measured.status.success());
        assert_eq!(
            measured.usage.map_err(|error| error.kind()),
            Err(io::ErrorKind::Unsupported)
        );
        Ok(())
    }
}

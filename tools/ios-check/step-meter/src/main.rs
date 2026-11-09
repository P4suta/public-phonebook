use std::ffi::OsString;
use std::os::unix::process::ExitStatusExt;
use std::path::PathBuf;
use std::process::{Command, ExitCode};
use std::sync::atomic::{AtomicI32, Ordering};

const USAGE: &str = "Usage: step-meter run --record PATH -- COMMAND [ARGUMENT...] | step-meter self --pid PID | step-meter memory PID...";
const FORWARDED_SIGNALS: [libc::c_int; 3] = [libc::SIGTERM, libc::SIGINT, libc::SIGHUP];
const FAILED_START: u8 = 127;
const SIGNAL_EXIT_BASE: i32 = 128;

static CHILD: AtomicI32 = AtomicI32::new(0);

extern "C" fn forward(signal: libc::c_int) {
    let child = CHILD.load(Ordering::SeqCst);
    if child > 0 {
        // SAFETY: `kill` is async-signal-safe, and the child stays unreaped until the meter reads its counts.
        unsafe {
            libc::kill(child, signal);
        }
    }
}

enum Request {
    Run {
        record: PathBuf,
        command: Vec<OsString>,
    },
    Current {
        pid: u32,
    },
    Memory {
        pids: Vec<u32>,
    },
}

fn parse(arguments: Vec<OsString>) -> Result<Request, String> {
    let mut arguments = arguments.into_iter();
    match arguments.next().as_ref().and_then(|word| word.to_str()) {
        Some("run") => {
            let (Some(flag), Some(record), Some(separator)) =
                (arguments.next(), arguments.next(), arguments.next())
            else {
                return Err(USAGE.to_owned());
            };
            let command = arguments.collect::<Vec<_>>();
            if flag != "--record" || separator != "--" || command.is_empty() {
                return Err(USAGE.to_owned());
            }
            Ok(Request::Run {
                record: record.into(),
                command,
            })
        }
        Some("self") => {
            let (Some(flag), Some(pid), None) =
                (arguments.next(), arguments.next(), arguments.next())
            else {
                return Err(USAGE.to_owned());
            };
            if flag != "--pid" {
                return Err(USAGE.to_owned());
            }
            let pid = pid
                .to_str()
                .and_then(|pid| pid.parse().ok())
                .ok_or_else(|| USAGE.to_owned())?;
            Ok(Request::Current { pid })
        }
        Some("memory") => {
            let pids = arguments
                .map(|pid| {
                    pid.to_str()
                        .and_then(|pid| pid.parse::<u32>().ok())
                        .filter(|pid| *pid > 0)
                        .ok_or_else(|| USAGE.to_owned())
                })
                .collect::<Result<Vec<_>, _>>()?;
            if pids.is_empty()
                || pids.iter().collect::<std::collections::BTreeSet<_>>().len() != pids.len()
            {
                return Err(USAGE.to_owned());
            }
            Ok(Request::Memory { pids })
        }
        _ => Err(USAGE.to_owned()),
    }
}

fn record(usage: &std::io::Result<step_meter::ChildUsage>) -> String {
    match usage {
        Ok(usage) => format!(
            "{{\"instructions\":{},\"reapedDescendants\":{}}}\n",
            usage.instructions, usage.reaped_descendants
        ),
        Err(error) => format!(
            "{{\"instructions\":null,\"reapedDescendants\":null,\"reason\":\"{:?}\"}}\n",
            error.kind()
        ),
    }
}

/// Runs the command as the only child, forwards termination signals to it, and exits the way it exited.
fn run(record_path: &PathBuf, command: &[OsString]) -> ExitCode {
    let Some((program, arguments)) = command.split_first() else {
        return ExitCode::from(FAILED_START);
    };
    let mut child = match Command::new(program).args(arguments).spawn() {
        Ok(child) => child,
        Err(error) => {
            eprintln!(
                "step-meter: could not start {}: {error}",
                program.to_string_lossy()
            );
            return ExitCode::from(FAILED_START);
        }
    };
    let Ok(pid) = libc::pid_t::try_from(child.id()) else {
        return ExitCode::from(FAILED_START);
    };
    CHILD.store(pid, Ordering::SeqCst);
    for signal in FORWARDED_SIGNALS {
        // SAFETY: `forward` only performs async-signal-safe work.
        unsafe {
            libc::signal(signal, forward as *const () as libc::sighandler_t);
        }
    }
    let measured = match step_meter::wait_measured(&mut child) {
        Ok(measured) => measured,
        Err(error) => {
            eprintln!("step-meter: could not wait for the command: {error}");
            return ExitCode::from(FAILED_START);
        }
    };
    if let Err(error) = std::fs::write(record_path, record(&measured.usage)) {
        eprintln!("step-meter: could not write the record: {error}");
    }
    if let Some(signal) = measured.status.signal() {
        // SAFETY: restoring the default action and raising the child's signal ends the meter the same way.
        unsafe {
            libc::signal(signal, libc::SIG_DFL);
            libc::raise(signal);
        }
        return ExitCode::from(u8::try_from(SIGNAL_EXIT_BASE + signal).unwrap_or(u8::MAX));
    }
    measured
        .status
        .code()
        .and_then(|code| u8::try_from(code).ok())
        .map_or(ExitCode::FAILURE, ExitCode::from)
}

fn main() -> ExitCode {
    match parse(std::env::args_os().skip(1).collect()) {
        Ok(Request::Run { record, command }) => run(&record, &command),
        Ok(Request::Memory { pids }) => {
            let readings = pids
                .into_iter()
                .map(|pid| step_meter::process_memory(pid).map(|memory| (pid, memory)))
                .collect::<std::io::Result<Vec<_>>>();
            match readings {
                Ok(readings) => {
                    let rows = readings.into_iter().map(|(pid,memory)|format!("{{\"pid\":{pid},\"physicalFootprintBytes\":{},\"lifetimePeakPhysicalFootprintBytes\":{}}}", memory.physical_footprint_bytes(),memory.lifetime_peak_physical_footprint_bytes())).collect::<Vec<_>>();
                    println!("[{}]", rows.join(","));
                    ExitCode::SUCCESS
                }
                Err(error) => {
                    eprintln!("step-meter: memory counters unavailable: {error}");
                    ExitCode::FAILURE
                }
            }
        }
        Ok(Request::Current { pid }) => match step_meter::process_instructions(pid) {
            Ok(instructions) => {
                println!("{{\"instructions\":{instructions}}}");
                ExitCode::SUCCESS
            }
            Err(error) => {
                eprintln!("step-meter: no count for process {pid}: {error}");
                ExitCode::FAILURE
            }
        },
        Err(usage) => {
            eprintln!("{usage}");
            ExitCode::from(2)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn words(line: &str) -> Vec<OsString> {
        line.split(' ').map(OsString::from).collect()
    }

    #[test]
    fn requests_need_their_exact_flags() {
        assert!(
            matches!(parse(words("memory 42 43")), Ok(Request::Memory { pids }) if pids == [42,43])
        );
        assert!(matches!(
            parse(words("run --record out.json -- node tools/check.ts")),
            Ok(Request::Run { command, .. }) if command.len() == 2
        ));
        assert!(matches!(
            parse(words("self --pid 42")),
            Ok(Request::Current { pid: 42 })
        ));
        for invalid in [
            "run --record out.json node",
            "run --record out.json --",
            "run --output out.json -- node",
            "self --pid forty",
            "self --pid 42 extra",
            "measure",
            "memory",
            "memory 0",
            "memory -1",
            "memory forty",
            "memory 42 42",
        ] {
            assert!(parse(words(invalid)).is_err(), "{invalid} was accepted");
        }
    }

    #[test]
    fn records_name_a_missing_count() {
        let missing = Err(std::io::ErrorKind::Unsupported.into());
        assert_eq!(
            record(&missing),
            "{\"instructions\":null,\"reapedDescendants\":null,\"reason\":\"Unsupported\"}\n"
        );
        let counted = Ok(step_meter::ChildUsage {
            instructions: 7,
            reaped_descendants: true,
        });
        assert_eq!(
            record(&counted),
            "{\"instructions\":7,\"reapedDescendants\":true}\n"
        );
    }
}

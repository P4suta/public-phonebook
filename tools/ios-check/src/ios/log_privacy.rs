//! Keeps console output out of the native code and keeps personal values out of public log fields.
//!
//! Apple's [logging guide](https://developer.apple.com/documentation/os/generating-log-messages-from-your-code) asks apps to redact any value that contains sensitive user information.

use anyhow::{Context, Result, ensure};
use std::{
    fs,
    path::{Path, PathBuf},
};

/// The directories whose Swift code ships in the app, the extension, or the packages.
const ROOTS: [&str; 4] = ["ios/App", "ios/Native", "ios/CallDirectory", "ios/Sources"];
/// Functions that write to standard output or the console instead of the unified logging system.
const CONSOLE_CALLS: [&str; 4] = ["print", "debugPrint", "dump", "NSLog"];
const PUBLIC: &str = "privacy: .public)";

/// What a public log value is, which shows that it carries nothing personal.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    Count,
    Code,
    RawValue,
    Identifier,
}

/// Every expression that a log line may mark `.public`, with its kind.
/// A new public field needs an entry here, so its review names what kind of value it is.
const PUBLIC_VALUES: [(&str, Kind); 11] = [
    ("entries", Kind::Count),
    ("peak / 1024", Kind::Count),
    ("expired", Kind::Code),
    ("failure.domain", Kind::Code),
    ("failure.code", Kind::Code),
    ("event.operation.uuidString", Kind::Identifier),
    ("event.phase.rawValue", Kind::RawValue),
    ("event.outcome.rawValue", Kind::RawValue),
    ("event.snapshot?.rawValue ?? \"none\"", Kind::Identifier),
    ("event.records ?? 0", Kind::Count),
    (
        "event.milliseconds.map(String.init) ?? \"none\"",
        Kind::Count,
    ),
];

/// The code of a Swift file with comments removed and string contents blanked, so console calls inside text don't count.
fn code_only(source: &str) -> String {
    let mut code = String::with_capacity(source.len());
    let mut characters = source.chars().peekable();
    while let Some(character) = characters.next() {
        match character {
            '/' if characters.peek() == Some(&'/') => {
                for next in characters.by_ref() {
                    if next == '\n' {
                        code.push('\n');
                        break;
                    }
                }
            }
            '/' if characters.peek() == Some(&'*') => {
                characters.next();
                let mut previous = ' ';
                for next in characters.by_ref() {
                    if next == '\n' {
                        code.push('\n');
                    }
                    if previous == '*' && next == '/' {
                        break;
                    }
                    previous = next;
                }
            }
            '"' => {
                code.push('"');
                while let Some(next) = characters.next() {
                    match next {
                        '\\' => {
                            characters.next();
                            code.push(' ');
                        }
                        '"' => break,
                        '\n' => code.push('\n'),
                        _ => code.push(' '),
                    }
                }
                code.push('"');
            }
            _ => code.push(character),
        }
    }
    code
}

fn console_calls(source: &str, file: &str) -> Vec<String> {
    let mut found = Vec::new();
    for (index, line) in code_only(source).lines().enumerate() {
        for call in CONSOLE_CALLS {
            let mut start = 0;
            while let Some(offset) = line[start..].find(call) {
                let at = start + offset;
                let before = line[..at].chars().next_back();
                let after = line[at + call.len()..].trim_start().chars().next();
                if !before.is_some_and(|c| c.is_alphanumeric() || c == '_' || c == '.')
                    && after == Some('(')
                {
                    found.push(format!(
                        "{file}:{}: {call} writes to the console",
                        index + 1
                    ));
                }
                start = at + call.len();
            }
        }
    }
    found
}

/// The line and the expression of each `\(expression, privacy: .public)` interpolation.
fn public_interpolations(source: &str) -> Vec<(usize, String)> {
    let mut found = Vec::new();
    let mut start = 0;
    while let Some(offset) = source[start..].find(PUBLIC) {
        let at = start + offset;
        let line = source[..at].matches('\n').count() + 1;
        let head = source[..at].trim_end();
        let head = head.strip_suffix(',').unwrap_or(head);
        let mut depth = 0usize;
        let mut expression = None;
        for (index, character) in head.char_indices().rev() {
            match character {
                ')' => depth += 1,
                '(' if depth == 0 => {
                    if head[..index].ends_with('\\') {
                        expression = Some(head[index + 1..].split_whitespace().collect::<Vec<_>>());
                    }
                    break;
                }
                '(' => depth -= 1,
                _ => {}
            }
        }
        found.push((
            line,
            expression.map_or_else(
                || "an unreadable expression".to_owned(),
                |words| words.join(" "),
            ),
        ));
        start = at + PUBLIC.len();
    }
    found
}

fn public_findings(source: &str, file: &str) -> Vec<String> {
    public_interpolations(source)
        .into_iter()
        .filter_map(|(line, expression)| {
            if expression.contains("String(describing:") || expression.contains("localizedDescription") {
                Some(format!("{file}:{line}: an error description is public: {expression}"))
            } else if PUBLIC_VALUES.iter().any(|(value, _)| *value == expression) {
                None
            } else {
                Some(format!(
                    "{file}:{line}: a public value is neither a count, a code, an enum raw value, nor an identifier: {expression}"
                ))
            }
        })
        .collect()
}

fn findings(source: &str, file: &str) -> Vec<String> {
    let mut found = console_calls(source, file);
    found.extend(public_findings(source, file));
    found
}

fn swift_files(directory: &Path, found: &mut Vec<PathBuf>) -> Result<()> {
    for entry in fs::read_dir(directory).with_context(|| format!("Read {}", directory.display()))? {
        let path = entry?.path();
        if path.is_dir() {
            swift_files(&path, found)?;
        } else if path
            .extension()
            .is_some_and(|extension| extension == "swift")
        {
            found.push(path);
        }
    }
    Ok(())
}

/// The planted lines that the check must refuse, which show that it reads what it claims to read.
const PLANTED: [&str; 3] = [
    "print(\"caller.load\")\n",
    "logger.error(\"failed \\(String(describing: error), privacy: .public)\")\n",
    "logger.info(\"query=\\(query, privacy: .public)\")\n",
];

/// Scans the shipped Swift code and refuses console output and unclassified public log values.
pub(super) fn check(root: &Path) -> Result<()> {
    let mut files = Vec::new();
    for directory in ROOTS {
        swift_files(&root.join(directory), &mut files)?;
    }
    ensure!(!files.is_empty(), "The log check found no Swift files");
    let mut found = Vec::new();
    let mut public = 0;
    for file in &files {
        let source = fs::read_to_string(file)?;
        let name = file.strip_prefix(root)?.display().to_string();
        public += public_interpolations(&source).len();
        found.extend(findings(&source, &name));
    }
    ensure!(
        found.is_empty(),
        "Native logging breaks the privacy rule:\n{}",
        found.join("\n")
    );
    for planted in PLANTED {
        ensure!(
            !findings(planted, "planted.swift").is_empty(),
            "The log check accepted a planted line: {planted}"
        );
    }
    println!(
        "PASS: {} Swift files log through Logger, {public} public values are classified, and {} planted lines fail",
        files.len(),
        PLANTED.len()
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn console_calls_count_only_in_code() {
        assert_eq!(console_calls("print(\"x\")\n", "a.swift").len(), 1);
        assert_eq!(console_calls("  NSLog (\"x\")\n", "a.swift").len(), 1);
        assert_eq!(console_calls("debugPrint(value)\n", "a.swift").len(), 1);
        assert!(console_calls("// print(\"x\")\n", "a.swift").is_empty());
        assert!(console_calls("/* dump(x) */\n", "a.swift").is_empty());
        assert!(console_calls("let text = \"print(x)\"\n", "a.swift").is_empty());
        assert!(console_calls("blueprint(x)\nlogger.dump(x)\nfootprint()\n", "a.swift").is_empty());
    }

    #[test]
    fn public_values_need_a_kind_and_descriptions_stay_private() {
        let valid = "logger.notice(\"caller.load entries=\\(entries, privacy: .public) code=\\(failure.code, privacy: .public)\")\n";
        assert!(findings(valid, "a.swift").is_empty());
        let nested = "logger.info(\"m=\\(event.milliseconds.map(String.init) ?? \"none\", privacy: .public)\")\n";
        assert!(findings(nested, "a.swift").is_empty());
        for planted in PLANTED {
            assert!(!findings(planted, "planted.swift").is_empty(), "{planted}");
        }
        let private = "logger.error(\"d=\\(failure.localizedDescription, privacy: .private)\")\n";
        assert!(findings(private, "a.swift").is_empty());
        let public = "logger.error(\"d=\\(failure.localizedDescription, privacy: .public)\")\n";
        assert!(findings(public, "a.swift")[0].contains("error description"));
    }

    #[test]
    fn every_listed_kind_appears() {
        for kind in [Kind::Count, Kind::Code, Kind::RawValue, Kind::Identifier] {
            assert!(
                PUBLIC_VALUES.iter().any(|(_, listed)| *listed == kind),
                "{kind:?}"
            );
        }
    }

    #[test]
    fn the_shipped_swift_code_passes() -> Result<()> {
        check(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../.."))
    }
}

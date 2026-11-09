//! Keeps the QA build's verification tools out of the App Store build.

use super::logged;
use anyhow::{Context, Result, ensure};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

/// The Swift compile condition that only the two verification configurations set.
pub(super) const CONDITION: &str = "PHONEBOOK_VERIFICATION_TOOLS";

/// Byte strings that the verification tools put in a build: type names, file names, identifiers, and copy.
/// Swift stores strings of up to 15 UTF-8 bytes inside instructions, so every marker is longer.
pub(super) const MARKERS: [&str; 10] = [
    "VerificationToolsScreen",
    "verification-number.json",
    "verification-caller-held.callers",
    "verification-tools",
    "--device-measurements",
    "caller.load result=",
    "caller.reload result=failed",
    "確認用の番号",
    "確認用の電話番号",
    "データの自動の受け取り",
];
const SMALL_STRING_BYTES: usize = 15;
const _: () = {
    let mut index = 0;
    while index < MARKERS.len() {
        assert!(MARKERS[index].len() > SMALL_STRING_BYTES);
        index += 1;
    }
};
const CONTROL_DERIVED_DATA: &str = "target/ios/store-build-control";
const SEARCH_RESOURCE_CONTROLS: [&str; 9] = [
    "search-index.br",
    "search-index",
    "search-ranking.br",
    "search-ranking-packed.br",
    "search-ranking",
    "search.json",
    "search-lines",
    "search-rows",
    "national-packed.json",
];

fn files(directory: &Path, found: &mut Vec<PathBuf>) -> Result<()> {
    for entry in fs::read_dir(directory).with_context(|| format!("Read {}", directory.display()))? {
        let path = entry?.path();
        let kind = fs::symlink_metadata(&path)?.file_type();
        if kind.is_dir() {
            files(&path, found)?;
        } else if kind.is_file() {
            found.push(path);
        }
    }
    Ok(())
}

/// Each marker that a file in `bundle` contains, with that file's path inside the bundle.
fn findings(bundle: &Path) -> Result<Vec<(&'static str, String)>> {
    ensure!(
        bundle.join("PublicPhonebook").is_file()
            && bundle
                .join("PlugIns/CallDirectory.appex/CallDirectory")
                .is_file(),
        "The store-build check found no app and extension executables in {}",
        bundle.display()
    );
    let mut paths = Vec::new();
    files(bundle, &mut paths)?;
    let mut found = Vec::new();
    for path in paths {
        let bytes = fs::read(&path)?;
        let relative = path.strip_prefix(bundle)?.display().to_string();
        if path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| {
                name == "search.json"
                    || name.starts_with("search-index")
                    || name.starts_with("search-ranking")
                    || name == "search-lines"
                    || name == "search-rows"
                    || name == "national-packed.json"
            })
        {
            found.push(("forgiving-search resource", relative.clone()));
        }
        for marker in MARKERS {
            if bytes
                .windows(marker.len())
                .any(|window| window == marker.as_bytes())
            {
                found.push((marker, relative.clone()));
            }
        }
    }
    Ok(found)
}

fn describe(found: &[(&str, String)]) -> String {
    found
        .iter()
        .map(|(marker, file)| format!("{marker} in {file}"))
        .collect::<Vec<_>>()
        .join(", ")
}

/// Fails when the store build contains any verification tools marker.
pub(super) fn require_absent(bundle: &Path) -> Result<()> {
    let found = findings(bundle)?;
    ensure!(
        found.is_empty(),
        "The store build contains QA tools or forgiving search: {}",
        describe(&found)
    );
    println!(
        "PASS: the Release app and extension contain no forgiving-search resources and none of the {} QA markers",
        MARKERS.len()
    );
    Ok(())
}

/// Fails unless a build with the compile condition contains every marker, so the absence check can see them.
pub(super) fn require_every_marker(bundle: &Path, build: &str) -> Result<()> {
    let found = findings(bundle)?;
    let missing = MARKERS
        .iter()
        .filter(|marker| !found.iter().any(|(seen, _)| seen == *marker))
        .copied()
        .collect::<Vec<_>>();
    ensure!(
        missing.is_empty(),
        "The {build} build lacks verification tools markers, so the store-build check can't see them: {}",
        missing.join(", ")
    );
    println!(
        "PASS: the {build} build contains all {} verification tools markers",
        MARKERS.len()
    );
    Ok(())
}

fn probe_search_resources(bundle: &Path) -> Result<()> {
    for name in SEARCH_RESOURCE_CONTROLS {
        let file = bundle.join(name);
        fs::write(&file, b"")?;
        ensure!(
            findings(bundle)?
                .iter()
                .any(|(kind, path)| *kind == "forgiving-search resource" && path == name),
            "The store-build check missed the planted {name}"
        );
        fs::remove_file(file)?;
    }
    Ok(())
}

/// Builds Release with the compile condition defined and requires the store-build check to reject it with every marker.
pub(super) fn control(root: &Path) -> Result<()> {
    let derived = root.join(CONTROL_DERIVED_DATA);
    logged(
        root,
        "store-build-control",
        Command::new("xcodebuild")
            .current_dir(root)
            .args([
                "-quiet",
                "-toolchain",
                "com.apple.dt.toolchain.XcodeDefault",
                "-project",
                "ios/PublicPhonebook.xcodeproj",
                "-scheme",
                "PublicPhonebook",
                "-configuration",
                "Release",
                "-destination",
                "generic/platform=iOS",
                "-derivedDataPath",
            ])
            .arg(&derived)
            .args(["-jobs", "2", "CODE_SIGNING_ALLOWED=NO"])
            .arg(format!("SWIFT_ACTIVE_COMPILATION_CONDITIONS={CONDITION}"))
            .arg("build"),
    )?;
    let bundle = derived.join("Build/Products/Release-iphoneos/PublicPhonebook.app");
    let rejection = require_absent(&bundle).err().context(
        "The store-build check accepted a Release build that compiles the verification tools",
    )?;
    println!("Expected rejection: {rejection}");
    require_every_marker(&bundle, "condition-defined Release")?;
    probe_search_resources(&bundle)?;
    println!(
        "PASS: the store-build check rejects a Release build that defines {CONDITION}, with all {} markers",
        MARKERS.len()
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bundle(contents: &[u8]) -> Result<tempfile::TempDir> {
        let directory = tempfile::tempdir()?;
        let extension = directory.path().join("PlugIns/CallDirectory.appex");
        fs::create_dir_all(&extension)?;
        fs::write(directory.path().join("PublicPhonebook"), b"app")?;
        fs::write(extension.join("CallDirectory"), contents)?;
        Ok(directory)
    }

    #[test]
    fn the_absence_check_rejects_any_marker_in_any_file() -> Result<()> {
        let clean = bundle(b"public-phonebook-callers\t1\n")?;
        require_absent(clean.path())?;
        assert!(require_every_marker(clean.path(), "clean").is_err());
        for marker in MARKERS {
            let mut contents = b"\0prefix".to_vec();
            contents.extend_from_slice(marker.as_bytes());
            contents.extend_from_slice(b"suffix\0");
            let planted = bundle(&contents)?;
            let rejection = require_absent(planted.path())
                .err()
                .context("A planted marker passed")?;
            assert!(rejection.to_string().contains(marker));
        }
        let mut every = Vec::new();
        for marker in MARKERS {
            every.extend_from_slice(marker.as_bytes());
            every.push(0);
        }
        require_every_marker(bundle(&every)?.path(), "planted")?;
        Ok(())
    }

    #[test]
    fn the_absence_check_rejects_empty_search_resources() -> Result<()> {
        for name in SEARCH_RESOURCE_CONTROLS {
            let planted = bundle(b"")?;
            fs::write(planted.path().join(name), b"")?;
            assert!(require_absent(planted.path()).is_err(), "{name}");
        }
        Ok(())
    }

    #[test]
    fn resource_controls_detect_each_planted_file_and_remove_the_fixture() -> Result<()> {
        let clean = bundle(b"")?;
        require_absent(clean.path())?;
        probe_search_resources(clean.path())?;
        require_absent(clean.path())?;
        Ok(())
    }

    #[test]
    fn the_check_refuses_a_bundle_without_both_executables() -> Result<()> {
        let empty = tempfile::tempdir()?;
        assert!(require_absent(empty.path()).is_err());
        let planted = bundle(b"")?;
        fs::remove_file(
            planted
                .path()
                .join("PlugIns/CallDirectory.appex/CallDirectory"),
        )?;
        assert!(require_absent(planted.path()).is_err());
        Ok(())
    }
}

//! Requires a privacy manifest declaration for every required reason API that the shipped Swift code names.
//!
//! The categories and their APIs come from Apple's [`NSPrivacyAccessedAPIType`](https://developer.apple.com/documentation/bundleresources/app-privacy-configuration/nsprivacyaccessedapitypes/nsprivacyaccessedapitype) list.
//! [Describing use of required reason API](https://developer.apple.com/documentation/bundleresources/describing-use-of-required-reason-api) states that App Store Connect refuses an app that leaves such a use undeclared.

use super::log_privacy::{ROOTS, code_only, swift_files};
use anyhow::{Context, Result, ensure};
use std::{collections::BTreeSet, fs, path::Path};

/// The privacy manifest that both the app and the Call Directory extension carry.
const MANIFEST: &str = "apps/ios/Config/PrivacyInfo.xcprivacy";

/// Each category with the API names that it covers and the reasons that an app may declare.
/// `attributesOfItem` isn't on Apple's list, and it stays here because its result carries the file timestamp keys.
const CATEGORIES: [(&str, &[&str], &[&str]); 5] = [
    (
        "NSPrivacyAccessedAPICategoryFileTimestamp",
        &[
            "creationDate",
            "modificationDate",
            "fileModificationDate",
            "contentModificationDateKey",
            "creationDateKey",
            "getattrlist",
            "getattrlistbulk",
            "fgetattrlist",
            "stat",
            "fstat",
            "fstatat",
            "lstat",
            "getattrlistat",
            "attributesOfItem",
        ],
        &["DDA9.1", "C617.1", "3B52.1"],
    ),
    (
        "NSPrivacyAccessedAPICategorySystemBootTime",
        &["systemUptime", "mach_absolute_time"],
        &["35F9.1", "8FFB.1", "3D61.1"],
    ),
    (
        "NSPrivacyAccessedAPICategoryDiskSpace",
        &[
            "volumeAvailableCapacityKey",
            "volumeAvailableCapacityForImportantUsageKey",
            "volumeAvailableCapacityForOpportunisticUsageKey",
            "volumeTotalCapacityKey",
            "systemFreeSize",
            "systemSize",
            "statfs",
            "statvfs",
            "fstatfs",
            "fstatvfs",
            "getattrlist",
            "fgetattrlist",
            "getattrlistat",
        ],
        &["85F4.1", "E174.1", "7D9E.1"],
    ),
    (
        "NSPrivacyAccessedAPICategoryActiveKeyboards",
        &["activeInputModes"],
        &["3EC4.1", "54BD.1"],
    ),
    (
        "NSPrivacyAccessedAPICategoryUserDefaults",
        &["UserDefaults"],
        &["CA92.1", "1C8F.1", "AC6B.1"],
    ),
];

/// Whether `code` names `api` as a whole identifier.
fn names(code: &str, api: &str) -> bool {
    let identifier = |c: char| c.is_alphanumeric() || c == '_';
    code.match_indices(api).any(|(at, _)| {
        !code[..at].chars().next_back().is_some_and(identifier)
            && !code[at + api.len()..]
                .chars()
                .next()
                .is_some_and(identifier)
    })
}

/// The categories that the Swift code names, each with the file and API that named it first.
fn used(sources: &[(String, String)]) -> Vec<(&'static str, String)> {
    let mut found = Vec::new();
    for (category, apis, _) in CATEGORIES {
        let first = sources.iter().find_map(|(file, source)| {
            let code = code_only(source);
            apis.iter()
                .find(|api| names(&code, api))
                .map(|api| format!("{file} names {api}"))
        });
        if let Some(first) = first {
            found.push((category, first));
        }
    }
    found
}

/// Each declared category with its declared reasons, read from the manifest's XML.
fn declared(manifest: &str) -> Result<Vec<(String, BTreeSet<String>)>> {
    let document = roxmltree::Document::parse_with_options(
        manifest,
        roxmltree::ParsingOptions {
            allow_dtd: true,
            ..roxmltree::ParsingOptions::default()
        },
    )?;
    let mut declarations = Vec::new();
    for dictionary in document
        .descendants()
        .filter(|node| node.has_tag_name("dict"))
    {
        let children = dictionary
            .children()
            .filter(|node| node.is_element())
            .collect::<Vec<_>>();
        let value = |key: &str| {
            children
                .iter()
                .position(|node| node.has_tag_name("key") && node.text() == Some(key))
                .and_then(|index| children.get(index + 1))
        };
        let Some(category) = value("NSPrivacyAccessedAPIType").and_then(|node| node.text()) else {
            continue;
        };
        let reasons = value("NSPrivacyAccessedAPITypeReasons")
            .map(|node| {
                node.children()
                    .filter(|child| child.has_tag_name("string"))
                    .filter_map(|child| child.text().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default();
        declarations.push((category.to_owned(), reasons));
    }
    Ok(declarations)
}

fn findings(sources: &[(String, String)], manifest: &str) -> Result<Vec<String>> {
    let declarations = declared(manifest)?;
    Ok(used(sources)
        .into_iter()
        .filter_map(|(category, first)| {
            let approved = CATEGORIES
                .iter()
                .find(|(name, _, _)| *name == category)
                .map_or(&[][..], |(_, _, reasons)| *reasons);
            let declared = declarations.iter().any(|(name, reasons)| {
                name == category
                    && reasons
                        .iter()
                        .any(|reason| approved.contains(&reason.as_str()))
            });
            (!declared).then(|| {
                format!("{first}, and {MANIFEST} declares no approved reason for {category}")
            })
        })
        .collect())
}

/// Scans the shipped Swift code and refuses a required reason API without its declaration.
pub(super) fn check(root: &Path) -> Result<()> {
    let mut files = Vec::new();
    for directory in ROOTS {
        swift_files(&root.join(directory), &mut files)?;
    }
    ensure!(
        !files.is_empty(),
        "The required reason check found no Swift files"
    );
    let sources = files
        .iter()
        .map(|file| {
            Ok((
                file.strip_prefix(root)?.display().to_string(),
                fs::read_to_string(file)?,
            ))
        })
        .collect::<Result<Vec<_>>>()?;
    let manifest = fs::read_to_string(root.join(MANIFEST)).context("Read the privacy manifest")?;
    let found = findings(&sources, &manifest)?;
    ensure!(
        found.is_empty(),
        "Undeclared required reason API:\n{}",
        found.join("\n")
    );
    for planted in [
        "var info = stat()\n_ = stat(path, &info)\n",
        "let date = values.modificationDate\n",
    ] {
        let mut planted_sources = sources.clone();
        planted_sources.push(("planted.swift".to_owned(), planted.to_owned()));
        ensure!(
            !findings(&planted_sources, &manifest)?.is_empty(),
            "The required reason check accepted a planted file timestamp call"
        );
    }
    println!(
        "PASS: {} Swift files name required reason APIs only in declared categories, and 2 planted calls fail",
        files.len()
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const DEFAULTS_ONLY: &str = include_str!("../../../../apps/ios/Config/PrivacyInfo.xcprivacy");

    fn source(text: &str) -> Vec<(String, String)> {
        vec![("a.swift".to_owned(), text.to_owned())]
    }

    #[test]
    fn whole_identifiers_count_and_text_does_not() {
        assert!(names("_ = stat(path, &info)", "stat"));
        assert!(!names("let status = state", "stat"));
        assert!(used(&source("// stat(path)\nlet text = \"stat(x)\"\n")).is_empty());
        assert_eq!(used(&source("UserDefaults.standard")).len(), 1);
    }

    #[test]
    fn a_used_category_needs_an_approved_reason() -> Result<()> {
        assert!(
            findings(
                &source("UserDefaults.standard.bool(forKey: \"a\")"),
                DEFAULTS_ONLY
            )?
            .is_empty()
        );
        let timestamp = findings(
            &source("let size = try FileManager.default.attributesOfItem(atPath: p)"),
            DEFAULTS_ONLY,
        )?;
        assert!(
            timestamp[0].contains("NSPrivacyAccessedAPICategoryFileTimestamp"),
            "{timestamp:?}"
        );
        let declared = DEFAULTS_ONLY.replace(
            "</array>\n</dict>\n</plist>",
            "    <dict><key>NSPrivacyAccessedAPIType</key><string>NSPrivacyAccessedAPICategoryFileTimestamp</string><key>NSPrivacyAccessedAPITypeReasons</key><array><string>C617.1</string></array></dict>\n    </array>\n</dict>\n</plist>",
        );
        assert!(findings(&source("_ = stat(path, &info)"), &declared)?.is_empty());
        let sdk_only = declared.replace("C617.1", "0A2A.1");
        assert!(!findings(&source("_ = stat(path, &info)"), &sdk_only)?.is_empty());
        Ok(())
    }

    #[test]
    fn the_shipped_swift_code_passes() -> Result<()> {
        check(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../.."))
    }
}

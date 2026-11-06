//! Derives the local package targets that the shipped app links from the generated Xcode project and the package graph.

use anyhow::{Context, Result, bail, ensure};
use serde_json::{Map, Value};
use std::{
    collections::{BTreeSet, VecDeque},
    path::Path,
    process::Command,
};

/// The archived application target; the targets it embeds ship in the same package.
pub(super) const APPLICATION: &str = "PublicPhonebook";

/// Reads the generated Xcode project and the package graph, then derives the linked local targets.
pub(super) fn read(root: &Path) -> Result<Vec<String>> {
    let project = described(
        Command::new("plutil")
            .args(["-convert", "json", "-o", "-"])
            .arg(root.join("ios/PublicPhonebook.xcodeproj/project.pbxproj")),
    )?;
    let package = described(
        Command::new("xcrun")
            .args(["swift", "package", "dump-package", "--package-path"])
            .arg(root.join("ios")),
    )?;
    linked(&project, &package, APPLICATION)
}

fn described(command: &mut Command) -> Result<Value> {
    serde_json::from_slice(&crate::checked(command)?.stdout)
        .context("Read the JSON description of the app's build graph")
}

/// The sorted local targets that `application` and the targets it embeds link through package products.
pub(super) fn linked(project: &Value, package: &Value, application: &str) -> Result<Vec<String>> {
    package_targets(package, &linked_products(project, application)?)
}

fn linked_products(project: &Value, application: &str) -> Result<BTreeSet<String>> {
    let objects = project["objects"]
        .as_object()
        .context("The Xcode project has no objects")?;
    let object = |id: &Value| -> Result<&Map<String, Value>> {
        let id = id.as_str().unwrap_or_default();
        objects
            .get(id)
            .and_then(Value::as_object)
            .with_context(|| format!("The Xcode project refers to missing object {id}"))
    };
    let all = objects.values().filter_map(Value::as_object);
    for root in all
        .clone()
        .filter(|object| isa(object) == Some("PBXProject"))
    {
        for reference in list(root, "packageReferences") {
            ensure!(
                local(object(reference)?),
                "The Xcode project references a package other than ios/Package.swift"
            );
        }
    }
    let targets = all
        .filter(|object| isa(object) == Some("PBXNativeTarget"))
        .collect::<Vec<_>>();
    let mut named = targets
        .iter()
        .filter(|target| target.get("name").and_then(Value::as_str) == Some(application));
    let app = *named
        .next()
        .with_context(|| format!("The Xcode project has no {application} target"))?;
    ensure!(
        named.next().is_none(),
        "The Xcode project has more than one {application} target"
    );
    ensure!(
        app.get("productType").and_then(Value::as_str)
            == Some("com.apple.product-type.application"),
        "{application} doesn't build an application"
    );
    let mut shipped = vec![app];
    for phase in list(app, "buildPhases") {
        let phase = object(phase)?;
        if isa(phase) != Some("PBXCopyFilesBuildPhase") {
            continue;
        }
        for file in list(phase, "files") {
            let file = object(file)?;
            // An embedded package product is already one of the package product dependencies.
            if file.contains_key("productRef") {
                continue;
            }
            let reference = file.get("fileRef").with_context(|| {
                format!("{application} embeds a build file without a reference")
            })?;
            let embedded = targets
                .iter()
                .find(|target| target.get("productReference") == Some(reference))
                .with_context(|| {
                    format!("{application} embeds a file that no target in the project builds")
                })?;
            shipped.push(*embedded);
        }
    }
    let mut products = BTreeSet::new();
    for target in shipped {
        for dependency in list(target, "packageProductDependencies") {
            let dependency = object(dependency)?;
            let name = dependency
                .get("productName")
                .and_then(Value::as_str)
                .context("A package product dependency has no product name")?;
            if let Some(reference) = dependency.get("package") {
                ensure!(
                    local(object(reference)?),
                    "{name} comes from a package other than ios/Package.swift"
                );
            }
            products.insert(name.to_owned());
        }
    }
    Ok(products)
}

fn isa(object: &Map<String, Value>) -> Option<&str> {
    object.get("isa").and_then(Value::as_str)
}

/// Whether `reference` names the package beside the generated project, which is `ios/Package.swift`.
fn local(reference: &Map<String, Value>) -> bool {
    isa(reference) == Some("XCLocalSwiftPackageReference")
        && reference.get("relativePath").and_then(Value::as_str) == Some(".")
}

fn list<'a>(object: &'a Map<String, Value>, key: &str) -> impl Iterator<Item = &'a Value> {
    object
        .get(key)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
}

fn package_targets(package: &Value, products: &BTreeSet<String>) -> Result<Vec<String>> {
    ensure!(
        package["dependencies"]
            .as_array()
            .is_some_and(Vec::is_empty),
        "ios/Package.swift declares package dependencies, which the SBOM doesn't describe"
    );
    let targets = package["targets"]
        .as_array()
        .context("The package graph has no targets")?;
    let declared = package["products"]
        .as_array()
        .context("The package graph has no products")?;
    let mut pending = VecDeque::new();
    for product in products {
        let declared = declared
            .iter()
            .find(|declared| declared["name"] == product.as_str())
            .with_context(|| {
                format!("The app links {product}, which ios/Package.swift doesn't declare")
            })?;
        pending.extend(declared["targets"].as_array().into_iter().flatten());
    }
    let mut visited = BTreeSet::new();
    let mut libraries = BTreeSet::new();
    while let Some(name) = pending.pop_front() {
        let name = name
            .as_str()
            .context("A package target reference isn't a name")?;
        if !visited.insert(name) {
            continue;
        }
        let target = targets
            .iter()
            .find(|target| target["name"] == name)
            .with_context(|| format!("The package has no target named {name}"))?;
        match target["type"].as_str() {
            Some("regular") => {
                libraries.insert(name.to_owned());
            }
            // System library targets map libraries that the iOS SDK supplies, such as SQLite.
            Some("system") => {}
            Some(kind) => bail!(
                "The app links {name}, which has target type {kind}; the SBOM describes only library targets"
            ),
            None => bail!("The app links {name}, which has no target type"),
        }
        for dependency in target["dependencies"].as_array().into_iter().flatten() {
            pending.push_back(dependency_target(name, dependency)?);
        }
    }
    Ok(libraries.into_iter().collect())
}

fn dependency_target<'a>(dependent: &str, dependency: &'a Value) -> Result<&'a Value> {
    let (kind, value) = dependency
        .as_object()
        .filter(|entries| entries.len() == 1)
        .and_then(|entries| entries.iter().next())
        .with_context(|| format!("{dependent} has a dependency that isn't one named dependency"))?;
    ensure!(
        kind == "byName" || kind == "target",
        "{dependent} depends on {value}, which comes from another package"
    );
    let name = &value[0];
    ensure!(
        value[1].is_null(),
        "{dependent} has a conditional dependency on {}",
        name.as_str().unwrap_or_default()
    );
    Ok(name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn project() -> Value {
        json!({"objects": {
            "PROJECT": {"isa": "PBXProject", "packageReferences": ["LOCAL"]},
            "LOCAL": {"isa": "XCLocalSwiftPackageReference", "relativePath": "."},
            "APP": {
                "isa": "PBXNativeTarget",
                "name": APPLICATION,
                "productType": "com.apple.product-type.application",
                "productReference": "APP_PRODUCT",
                "buildPhases": ["FRAMEWORKS", "EMBED"],
                "packageProductDependencies": ["APP_CORE", "APP_KIT"]
            },
            "FRAMEWORKS": {"isa": "PBXFrameworksBuildPhase", "files": ["LINK_KIT"]},
            "LINK_KIT": {"isa": "PBXBuildFile", "productRef": "APP_KIT"},
            "EMBED": {"isa": "PBXCopyFilesBuildPhase", "files": ["EMBED_EXTENSION", "EMBED_PRODUCT"]},
            "EMBED_EXTENSION": {"isa": "PBXBuildFile", "fileRef": "EXTENSION_PRODUCT"},
            "EMBED_PRODUCT": {"isa": "PBXBuildFile", "productRef": "APP_KIT"},
            "EXTENSION": {
                "isa": "PBXNativeTarget",
                "name": "CallDirectory",
                "productType": "com.apple.product-type.app-extension",
                "productReference": "EXTENSION_PRODUCT",
                "buildPhases": [],
                "packageProductDependencies": ["EXTENSION_CORE", "EXTENSION_CALLER"]
            },
            "MEASUREMENTS": {
                "isa": "PBXNativeTarget",
                "name": "PhonebookDeviceMeasurements",
                "productType": "com.apple.product-type.bundle.unit-test",
                "productReference": "MEASUREMENTS_PRODUCT",
                "buildPhases": [],
                "packageProductDependencies": ["MEASUREMENTS_SUPPORT"]
            },
            "APP_PRODUCT": {"isa": "PBXFileReference", "path": "PublicPhonebook.app"},
            "EXTENSION_PRODUCT": {"isa": "PBXFileReference", "path": "CallDirectory.appex"},
            "MEASUREMENTS_PRODUCT": {"isa": "PBXFileReference", "path": "PhonebookDeviceMeasurements.xctest"},
            "APP_CORE": {"isa": "XCSwiftPackageProductDependency", "productName": "PhonebookCore"},
            "APP_KIT": {"isa": "XCSwiftPackageProductDependency", "productName": "PhonebookKit", "package": "LOCAL"},
            "EXTENSION_CORE": {"isa": "XCSwiftPackageProductDependency", "productName": "PhonebookCore"},
            "EXTENSION_CALLER": {"isa": "XCSwiftPackageProductDependency", "productName": "CallerFile"},
            "MEASUREMENTS_SUPPORT": {"isa": "XCSwiftPackageProductDependency", "productName": "MeasurementSupport"}
        }})
    }

    fn package() -> Value {
        json!({
            "dependencies": [],
            "products": [
                {"name": "PhonebookCore", "targets": ["PhonebookCore"]},
                {"name": "PhonebookKit", "targets": ["PhonebookKit"]},
                {"name": "CallerFile", "targets": ["CallerFile"]},
                {"name": "MeasurementSupport", "targets": ["MeasurementSupport"]}
            ],
            "targets": [
                {"name": "PhonebookCore", "type": "regular", "dependencies": []},
                {"name": "CSQLite", "type": "system", "dependencies": []},
                {"name": "PhonebookRanking", "type": "regular", "dependencies": [{"byName": ["PhonebookCore", null]}]},
                {"name": "PhonebookKit", "type": "regular", "dependencies": [
                    {"byName": ["PhonebookCore", null]},
                    {"target": ["PhonebookRanking", null]},
                    {"byName": ["CSQLite", null]}
                ]},
                {"name": "CallerFile", "type": "regular", "dependencies": [{"byName": ["PhonebookCore", null]}]},
                {"name": "MeasurementSupport", "type": "regular", "dependencies": [{"byName": ["PhonebookKit", null]}]},
                {"name": "BundledAdmission", "type": "executable", "dependencies": [{"byName": ["PhonebookKit", null]}]},
                {"name": "PhonebookKitTests", "type": "test", "dependencies": [{"byName": ["PhonebookKit", null]}]}
            ]
        })
    }

    fn names(names: &[&str]) -> Vec<String> {
        names.iter().map(|name| (*name).to_owned()).collect()
    }

    fn refused(project: &Value, package: &Value, application: &str, reason: &str) {
        let error = linked(project, package, application)
            .err()
            .unwrap_or_else(|| panic!("expected a refusal that mentions {reason}"));
        assert!(
            format!("{error:#}").contains(reason),
            "expected {reason} in {error:#}"
        );
    }

    #[test]
    fn shipped_targets_link_the_closure_of_their_package_products() -> Result<()> {
        assert_eq!(
            linked(&project(), &package(), APPLICATION)?,
            names(&[
                "CallerFile",
                "PhonebookCore",
                "PhonebookKit",
                "PhonebookRanking"
            ])
        );
        Ok(())
    }

    #[test]
    fn targets_that_only_tests_tools_or_unshipped_bundles_link_stay_out() -> Result<()> {
        let mut unembedded = project();
        unembedded["objects"]["EMBED"]["files"] = json!(["EMBED_PRODUCT"]);
        assert_eq!(
            linked(&unembedded, &package(), APPLICATION)?,
            names(&["PhonebookCore", "PhonebookKit", "PhonebookRanking"])
        );
        let mut other_phase = project();
        other_phase["objects"]["EMBED"]["isa"] = json!("PBXResourcesBuildPhase");
        other_phase["objects"]["EMBED_EXTENSION"] =
            json!({"isa": "PBXBuildFile", "fileRef": "RESOURCE"});
        assert_eq!(
            linked(&other_phase, &package(), APPLICATION)?,
            names(&["PhonebookCore", "PhonebookKit", "PhonebookRanking"])
        );
        assert_eq!(
            linked(&project(), &package(), "CallDirectory")
                .err()
                .map(|error| error.to_string()),
            Some("CallDirectory doesn't build an application".to_owned())
        );
        Ok(())
    }

    #[test]
    fn remote_packages_foreign_products_and_conditions_are_refused() {
        let mut dependent = package();
        dependent["dependencies"] = json!([{"sourceControl": [{"identity": "remote"}]}]);
        refused(
            &project(),
            &dependent,
            APPLICATION,
            "declares package dependencies",
        );

        let mut remote = project();
        remote["objects"]["REMOTE"] = json!({"isa": "XCRemoteSwiftPackageReference", "repositoryURL": "https://example.com/remote"});
        remote["objects"]["PROJECT"]["packageReferences"] = json!(["LOCAL", "REMOTE"]);
        refused(
            &remote,
            &package(),
            APPLICATION,
            "other than ios/Package.swift",
        );

        let mut nested = project();
        nested["objects"]["LOCAL"]["relativePath"] = json!("Nested");
        refused(
            &nested,
            &package(),
            APPLICATION,
            "other than ios/Package.swift",
        );

        let mut unlisted = project();
        unlisted["objects"]["REMOTE"] = json!({"isa": "XCRemoteSwiftPackageReference", "repositoryURL": "https://example.com/remote"});
        unlisted["objects"]["APP_KIT"]["package"] = json!("REMOTE");
        refused(
            &unlisted,
            &package(),
            APPLICATION,
            "PhonebookKit comes from a package other than ios/Package.swift",
        );

        let mut foreign = package();
        foreign["targets"][3]["dependencies"] =
            json!([{"product": ["Remote", "remote", null, null]}]);
        refused(
            &project(),
            &foreign,
            APPLICATION,
            "comes from another package",
        );

        let mut conditional = package();
        conditional["targets"][2]["dependencies"] =
            json!([{"byName": ["PhonebookCore", {"platformNames": ["ios"]}]}]);
        refused(
            &project(),
            &conditional,
            APPLICATION,
            "conditional dependency on PhonebookCore",
        );

        let mut ambiguous = package();
        ambiguous["targets"][2]["dependencies"] =
            json!([{"byName": ["PhonebookCore", null], "target": ["PhonebookCore", null]}]);
        refused(
            &project(),
            &ambiguous,
            APPLICATION,
            "isn't one named dependency",
        );
    }

    #[test]
    fn unknown_applications_products_targets_and_embedded_files_are_refused() {
        refused(&project(), &package(), "Missing", "has no Missing target");

        let mut duplicate = project();
        duplicate["objects"]["COPY"] = duplicate["objects"]["APP"].clone();
        refused(
            &duplicate,
            &package(),
            APPLICATION,
            "more than one PublicPhonebook target",
        );

        refused(&json!({}), &package(), APPLICATION, "has no objects");

        let mut missing = project();
        missing["objects"]["APP"]["packageProductDependencies"] = json!(["APP_CORE", "GONE"]);
        refused(&missing, &package(), APPLICATION, "missing object GONE");

        let mut unnamed = project();
        unnamed["objects"]["APP_CORE"] = json!({"isa": "XCSwiftPackageProductDependency"});
        refused(&unnamed, &package(), APPLICATION, "has no product name");

        let mut stray = project();
        stray["objects"]["EMBED_EXTENSION"] = json!({"isa": "PBXBuildFile", "fileRef": "STRAY"});
        refused(
            &stray,
            &package(),
            APPLICATION,
            "embeds a file that no target in the project builds",
        );

        let mut empty = project();
        empty["objects"]["EMBED_EXTENSION"] = json!({"isa": "PBXBuildFile"});
        refused(
            &empty,
            &package(),
            APPLICATION,
            "embeds a build file without a reference",
        );

        let mut undeclared = package();
        undeclared["products"][2]["name"] = json!("Renamed");
        refused(
            &project(),
            &undeclared,
            APPLICATION,
            "links CallerFile, which ios/Package.swift doesn't declare",
        );

        let mut absent = package();
        absent["targets"][4]["name"] = json!("Renamed");
        refused(
            &project(),
            &absent,
            APPLICATION,
            "has no target named CallerFile",
        );

        let mut untyped = package();
        untyped["products"] = json!({});
        refused(&project(), &untyped, APPLICATION, "has no products");

        let mut targetless = package();
        targetless["targets"] = json!(null);
        refused(&project(), &targetless, APPLICATION, "has no targets");
    }

    /// Runs the actual `plutil` and `swift package dump-package` on a small checkout.
    #[cfg(target_os = "macos")]
    #[test]
    fn reading_a_checkout_describes_its_project_and_package() -> Result<()> {
        let root = tempfile::tempdir()?;
        let project_directory = root.path().join("ios/PublicPhonebook.xcodeproj");
        std::fs::create_dir_all(&project_directory)?;
        std::fs::write(
            root.path().join("ios/Package.swift"),
            r#"// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "Fixture",
  products: [.library(name: "Core", targets: ["Core"])],
  targets: [.target(name: "Core"), .target(name: "Unlinked")]
)
"#,
        )?;
        let description = project_directory.join("project.pbxproj");
        std::fs::write(
            &description,
            serde_json::to_vec(&json!({"objects": {
                "APP": {
                    "isa": "PBXNativeTarget",
                    "name": APPLICATION,
                    "productType": "com.apple.product-type.application",
                    "packageProductDependencies": ["CORE"]
                },
                "CORE": {"isa": "XCSwiftPackageProductDependency", "productName": "Core"}
            }}))?,
        )?;
        assert_eq!(read(root.path())?, names(&["Core"]));
        std::fs::write(&description, "not a property list")?;
        assert!(read(root.path()).is_err());
        Ok(())
    }

    #[test]
    fn linked_executables_tests_and_unknown_kinds_are_refused() {
        for (kind, target) in [
            ("executable", "BundledAdmission"),
            ("test", "PhonebookKitTests"),
        ] {
            let mut linked = package();
            linked["targets"][3]["dependencies"] = json!([{"byName": [target, null]}]);
            refused(
                &project(),
                &linked,
                APPLICATION,
                &format!("links {target}, which has target type {kind}"),
            );
        }
        for kind in ["binary", "macro", "plugin"] {
            let mut linked = package();
            linked["targets"][2]["type"] = json!(kind);
            refused(
                &project(),
                &linked,
                APPLICATION,
                &format!("links PhonebookRanking, which has target type {kind}"),
            );
        }
        let mut untyped = package();
        untyped["targets"][2]["type"] = json!(null);
        refused(
            &project(),
            &untyped,
            APPLICATION,
            "links PhonebookRanking, which has no target type",
        );
    }
}

#![cfg(unix)]

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::Command;

const RECORD_END: &str = "__phonebook_recipe_end__";
const FAILURE_EXIT: i32 = 23;
const EXECUTABLE_MODE: u32 = 0o755;
const RECORDER: &str = r#"#!/bin/sh
printf '%s\0' "$0" "$@" '__phonebook_recipe_end__'
exit "$PHONEBOOK_RECIPE_EXIT"
"#;

struct Recipe {
    name: &'static str,
    program: &'static str,
    prefix: &'static [&'static str],
}

const RECIPES: &[Recipe] = &[
    Recipe {
        name: "cloudflare-deploy",
        program: "doppler",
        prefix: &[
            "run",
            "--no-fallback",
            "--project",
            "public-phonebook",
            "--config",
            "prd",
            "--only-secrets",
            "CLOUDFLARE_ACCOUNT_ID",
            "--",
            "npm",
            "exec",
            "--no",
            "--",
            "cf",
            "deploy",
            "--prebuilt",
        ],
    },
    Recipe {
        name: "update-data",
        program: "cargo",
        prefix: &["run", "--locked", "-p", "public-phonebook", "--", "update"],
    },
    Recipe {
        name: "e2e",
        program: "npm",
        prefix: &["run", "e2e", "--"],
    },
    Recipe {
        name: "e2e-national",
        program: "npm",
        prefix: &["run", "e2e:national", "--"],
    },
    Recipe {
        name: "check",
        program: "cargo",
        prefix: &["run", "--locked", "-p", "xtask", "--", "check"],
    },
    Recipe {
        name: "service-check",
        program: "cargo",
        prefix: &[
            "run",
            "--locked",
            "-p",
            "xtask",
            "--",
            "check",
            "--data",
            "--proofs",
            "--fuzz",
            "--browsers",
            "--cloudflare",
        ],
    },
    Recipe {
        name: "prove",
        program: "cargo",
        prefix: &["run", "--locked", "-p", "xtask", "--", "prove"],
    },
];

#[test]
fn variadic_recipes_preserve_argument_boundaries_and_child_failures() -> anyhow::Result<()> {
    let root = tempfile::tempdir()?;
    let bin = root.path().join("bin");
    fs::create_dir(&bin)?;
    fs::copy(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../justfile"),
        root.path().join("justfile"),
    )?;
    for name in ["cargo", "npm", "taplo", "gitleaks", "actionlint", "doppler"] {
        let path = bin.join(name);
        fs::write(&path, RECORDER)?;
        fs::set_permissions(path, fs::Permissions::from_mode(EXECUTABLE_MODE))?;
    }
    let path = std::env::join_paths(std::iter::once(bin).chain(std::env::split_paths(
        &std::env::var_os("PATH").unwrap_or_default(),
    )))?;
    let literal_arguments = [
        "--message",
        "Publish 日本語 with spaces",
        "",
        "'single quotes'",
        "\"double quotes\"",
        "$(printf injected)",
        concat!("\x60", "printf injected", "\x60"),
        "wild*card",
        "line\nbreak",
    ];
    for recipe in RECIPES {
        for arguments in [
            &["space separated", ""][..],
            &literal_arguments[..],
            &[][..],
        ] {
            let output = Command::new("just")
                .current_dir(root.path())
                .env("PATH", &path)
                .env("PHONEBOOK_RECIPE_EXIT", "0")
                .arg(recipe.name)
                .args(arguments)
                .output()?;
            assert!(
                output.status.success(),
                "{}: {}",
                recipe.name,
                String::from_utf8_lossy(&output.stderr)
            );
            let stdout = std::str::from_utf8(&output.stdout)?;
            let fields: Vec<_> = stdout.split_terminator('\0').collect();
            let record = fields
                .split(|field| *field == RECORD_END)
                .rfind(|record| !record.is_empty())
                .expect("the actual recipe must invoke a recorded command");
            assert_eq!(Path::new(record[0]).file_name().unwrap(), recipe.program);
            let expected: Vec<_> = recipe
                .prefix
                .iter()
                .chain(arguments.iter())
                .copied()
                .collect();
            assert_eq!(&record[1..], expected.as_slice(), "{}", recipe.name);
        }
        let failed = Command::new("just")
            .current_dir(root.path())
            .env("PATH", &path)
            .env("PHONEBOOK_RECIPE_EXIT", FAILURE_EXIT.to_string())
            .arg(recipe.name)
            .output()?;
        assert_eq!(failed.status.code(), Some(FAILURE_EXIT), "{}", recipe.name);
    }
    Ok(())
}

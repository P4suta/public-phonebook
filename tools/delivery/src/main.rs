use anyhow::{Result, ensure};
use clap::{Parser, Subcommand};
use delivery::{
    model::Digest,
    repository,
    runtime::{self, GithubCli},
};
use delivery_core::BuildNumber;
use std::{fs::OpenOptions, io::Write, path::PathBuf};

#[derive(Parser)]
#[command(about = "Verify native package inputs and preserved artifacts")]
struct Arguments {
    #[arg(long, default_value = ".", global = true)]
    root: PathBuf,
    #[command(subcommand)]
    action: Action,
}

#[derive(Subcommand)]
enum Action {
    /// Replay and fuzz the production version parser with pinned tools.
    Fuzz {
        #[arg(long)]
        write_corpus: bool,
    },
    /// Print a validated app version from the working source.
    Version {
        #[arg(value_parser = ["ios", "android"])]
        app: String,
    },
    /// Allocate a stable store build number within one authoritative workflow.
    BuildNumber { run: u32 },
    /// Validate an explicitly allocated store build code.
    StoreBuildNumber { value: u32 },
    /// Check the pinned proof inventory and its rejecting control.
    Prove,
    /// Download an Android workflow's artifacts and verify their provenance.
    FetchAndroid { run: u64 },
    /// Require an observed configuration identity to match its reviewed preview.
    Admit { expected: String, observed: String },
    /// Prepare proposal history without tagging or publishing a release.
    VersionProposal {
        #[arg(value_enum)]
        app: delivery::versions::App,
    },
    /// Identify the complete inputs of a platform assurance result.
    PlatformKey {
        #[arg(value_enum)]
        app: delivery::versions::App,
        #[arg(long, value_enum, default_value_t = delivery::platforms::Scope::Full)]
        scope: delivery::platforms::Scope,
        #[arg(long)]
        output: Option<PathBuf>,
    },
    /// Verify a client or reuse a result with matching inputs and tools.
    Platform {
        #[arg(value_enum)]
        app: delivery::versions::App,
        #[arg(long, value_enum, default_value_t = delivery::platforms::Scope::Full)]
        scope: delivery::platforms::Scope,
    },
}

fn main() -> Result<()> {
    let arguments = Arguments::parse();
    let root = arguments.root.canonicalize()?;
    match arguments.action {
        Action::Fuzz { write_corpus } => {
            if write_corpus {
                delivery::fuzz::write_corpus(&root)?;
            } else {
                delivery::fuzz::run(&root)?;
            }
        }
        Action::Version { app } => println!("{}", repository::current_version(&root, &app)?),
        Action::BuildNumber { run } => println!(
            "{}",
            BuildNumber::from_run(run).ok_or_else(|| anyhow::anyhow!(
                "Store build number is outside the admitted range"
            ))?
        ),
        Action::StoreBuildNumber { value } => println!(
            "{}",
            BuildNumber::new(value)
                .ok_or_else(|| anyhow::anyhow!("Store build code is outside the platform range"))?
        ),
        Action::Prove => delivery::proof::run(&root)?,
        Action::FetchAndroid { run } => println!(
            "{}",
            runtime::fetch_android(&root, &mut GithubCli, run)?.display()
        ),
        Action::Admit { expected, observed } => {
            ensure!(
                Digest::try_from(expected)? == Digest::try_from(observed)?,
                "Configuration changed after its reviewed preview; prepare another preview before applying"
            );
        }
        Action::VersionProposal { app } => delivery::versions::prepare(&root, &mut GithubCli, app)?,
        Action::PlatformKey { app, scope, output } => {
            let key = delivery::platforms::key(&root, app, scope)?;
            if let Some(path) = output {
                writeln!(OpenOptions::new().append(true).open(path)?, "key={key}")?;
            }
            println!("{key}");
        }
        Action::Platform { app, scope } => delivery::platforms::verify(&root, app, scope)?,
    }
    Ok(())
}

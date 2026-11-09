use anyhow::{Result, ensure};
use clap::{Parser, Subcommand};
use delivery::{
    model::{Digest, Operation, REPOSITORY, Revision, Target},
    repository,
    runtime::{self, GithubCli, Intent},
};
use delivery_core::BuildNumber;
use std::{env, fs::OpenOptions, io::Write, path::PathBuf};

#[derive(Parser)]
#[command(about = "Plan and request independent delivery operations")]
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
    /// Prepare a read-only plan from immutable committed inputs.
    Plan {
        #[arg(long, default_value = "HEAD")]
        source: String,
        #[arg(long)]
        base: Option<String>,
        #[arg(long, value_enum, value_delimiter = ',')]
        targets: Option<Vec<Target>>,
        #[arg(long)]
        dataset: Option<String>,
        #[arg(long, default_value = "target/delivery/plan.json")]
        output: PathBuf,
    },
    /// Validate a plan against its source and the current planning rules.
    Verify { plan: PathBuf },
    /// Persist one request before submitting its operation to protected main.
    Dispatch {
        #[arg(value_enum)]
        operation: Operation,
        #[arg(long, default_value = "target/delivery/plan.json")]
        plan: PathBuf,
        #[arg(long)]
        request: Option<PathBuf>,
    },
    /// Reconcile a saved request without submitting another workflow.
    Status {
        request: PathBuf,
        #[arg(long)]
        run: Option<u64>,
    },
    /// Resolve the immutable dataset of the active production Worker.
    Dataset,
    /// Print a validated app version from the working source.
    Version {
        #[arg(value_parser = ["ios", "android"])]
        app: String,
    },
    /// Allocate a stable store build number within one authoritative workflow.
    BuildNumber { run: u32 },
    /// Validate an explicitly allocated store build code.
    StoreBuildNumber { value: u32 },
    /// Validate controller inputs before any credential-bearing job starts.
    Controller {
        #[arg(long, value_enum)]
        operation: Operation,
        #[arg(long)]
        source: String,
        #[arg(long)]
        controller: String,
        #[arg(long)]
        plan: String,
        #[arg(long)]
        request: String,
        #[arg(long, default_value = "")]
        base: String,
        #[arg(long, default_value = "")]
        targets: String,
        #[arg(long, default_value = "")]
        dataset: String,
        #[arg(long)]
        output: PathBuf,
    },
    /// Check the pinned proof inventory and its rejecting control.
    Prove,
    /// Download the original Android artifacts and verify their provenance.
    FetchAndroid { request: PathBuf },
    /// Require the observed configuration identity to match its reviewed preview.
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
    /// Verify a client or reuse evidence with matching inputs and tools.
    Platform {
        #[arg(value_enum)]
        app: delivery::versions::App,
        #[arg(long, value_enum, default_value_t = delivery::platforms::Scope::Full)]
        scope: delivery::platforms::Scope,
    },
    /// Refuse incomplete or unexpectedly skipped candidate jobs.
    Gate {
        #[arg(long, value_enum)]
        operation: Operation,
        #[arg(long, value_enum)]
        plan: delivery::model::JobResult,
        #[arg(long, value_enum)]
        fast: delivery::model::JobResult,
        #[arg(long, value_enum)]
        proofs: delivery::model::JobResult,
        #[arg(long, value_enum)]
        worker: delivery::model::JobResult,
        #[arg(long, value_enum)]
        ios: delivery::model::JobResult,
        #[arg(long, value_enum)]
        android: delivery::model::JobResult,
        #[arg(long, action = clap::ArgAction::Set)]
        worker_required: bool,
        #[arg(long, action = clap::ArgAction::Set)]
        ios_required: bool,
        #[arg(long, action = clap::ArgAction::Set)]
        android_required: bool,
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
        Action::Plan {
            source,
            base,
            targets,
            dataset,
            output,
        } => {
            let source = repository::revision(&root, &source)?;
            let comparison = base
                .map(|reference| repository::revision(&root, &reference))
                .transpose()?
                .or_else(|| targets.as_ref().map(|_| source.clone()));
            let dataset = match dataset.as_deref() {
                Some("active") => Some(runtime::resolve_dataset(None)?),
                Some(_) => dataset.map(Digest::try_from).transpose()?,
                None => None,
            };
            let plan = repository::plan(&root, source, comparison, targets, dataset)?;
            runtime::write_json(&root.join(output), &plan)?;
            println!("{}", serde_json::to_string_pretty(&plan)?);
        }
        Action::Verify { plan } => {
            let record = runtime::read_plan(&root, &root.join(plan))?;
            println!("{}", record.sha256);
        }
        Action::Dispatch {
            operation,
            plan,
            request,
        } => {
            let record = runtime::read_plan(&root, &root.join(plan))?;
            let path = request
                .map(|path| root.join(path))
                .unwrap_or_else(|| runtime::request_path(&root, &record, operation));
            println!(
                "{}",
                runtime::dispatch(&root, &mut GithubCli, record, operation, &path)?
            );
        }
        Action::Status { request, run } => {
            let path = root.join(request);
            let mut intent: Intent = runtime::read_json(&path)?;
            if let Some(run) = run {
                ensure!(
                    run > 0 && intent.run.is_none_or(|recorded| recorded == run),
                    "The request already names another run"
                );
                intent.run = Some(run);
            }
            let result = runtime::status(&mut GithubCli, &intent)?;
            if let Some(run) = result["run"]["databaseId"].as_u64() {
                intent.run = Some(run);
                runtime::write_json(&path, &intent)?;
            }
            println!("{result}");
        }
        Action::Dataset => println!("{}", runtime::resolve_dataset(None)?),
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
        Action::Controller {
            operation,
            source,
            controller,
            plan,
            request,
            base,
            targets,
            dataset,
            output,
        } => {
            let targets = if targets.is_empty() {
                None
            } else {
                Some(
                    targets
                        .split(',')
                        .map(|target| {
                            serde_json::from_value(serde_json::Value::String(target.to_owned()))
                                .map_err(Into::into)
                        })
                        .collect::<Result<Vec<Target>>>()?,
                )
            };
            let source = Revision::try_from(source)?;
            let controller = Revision::try_from(controller)?;
            let _request = Digest::try_from(request)?;
            ensure!(
                env::var("GITHUB_REPOSITORY")? == REPOSITORY
                    && env::var("GITHUB_REF")? == "refs/heads/main"
                    && env::var("GITHUB_SHA")? == controller.as_str()
                    && source == controller,
                "The delivery controller must execute the exact protected main candidate"
            );
            ensure!(
                env::var("GITHUB_WORKFLOW_REF")?
                    == format!(
                        "{REPOSITORY}/.github/workflows/{}@refs/heads/main",
                        operation.workflow()
                    ),
                "The operation belongs to another controller workflow"
            );
            ensure!(
                repository::revision(&root, "HEAD")? == source,
                "Checkout differs from the requested source"
            );
            let record = repository::plan(
                &root,
                source,
                if base.is_empty() {
                    None
                } else {
                    Some(Revision::try_from(base)?)
                },
                targets,
                if dataset.is_empty() {
                    None
                } else {
                    Some(Digest::try_from(dataset)?)
                },
            )?;
            ensure!(
                record.sha256 == Digest::try_from(plan)?
                    && !record.plan.selection_required
                    && record.plan.targets.contains(&operation.target()),
                "Controller plan differs from the requested candidate"
            );
            if operation == Operation::Worker {
                ensure!(
                    record.plan.dataset.is_some(),
                    "Worker delivery requires an immutable dataset digest"
                );
            }
            let mut outputs = OpenOptions::new().append(true).create(true).open(output)?;
            for check in delivery::model::Check::ALL {
                let name = serde_json::to_string(&check)?.trim_matches('"').to_owned();
                writeln!(outputs, "{name}={}", record.plan.checks.contains(&check))?;
            }
            runtime::write_json(&root.join("target/delivery/plan.json"), &record)?;
        }
        Action::Prove => delivery::proof::run(&root)?,
        Action::FetchAndroid { request } => {
            let intent: Intent = runtime::read_json(&root.join(request))?;
            println!(
                "{}",
                runtime::fetch_android(&root, &mut GithubCli, &intent)?.display()
            );
        }
        Action::Admit { expected, observed } => {
            let expected = Digest::try_from(expected)?;
            let observed = Digest::try_from(observed)?;
            ensure!(
                delivery_core::admission(delivery_core::Facts {
                    requested: true,
                    candidate_matches: expected == observed,
                    checks_passed: true,
                    approved: true,
                    provider: delivery_core::ProviderOutcome::NotAttempted
                }) == delivery_core::Admission::Ready,
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
        Action::Gate {
            operation,
            plan,
            fast,
            proofs,
            worker,
            ios,
            android,
            worker_required,
            ios_required,
            android_required,
        } => {
            let actual =
                [plan, fast, proofs, worker, ios, android].map(delivery::model::JobResult::outcome);
            ensure!(
                delivery_core::checks_pass(
                    operation.gate_requirements(worker_required, ios_required, android_required),
                    actual
                ),
                "Required delivery checks failed, were cancelled, or were skipped unexpectedly"
            );
        }
    }
    Ok(())
}

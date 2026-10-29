use anyhow::Result;
use clap::{Parser, Subcommand};
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::PathBuf;

#[derive(Parser)]
#[command(about = "A source-backed public contact directory for all 47 prefectures")]
struct Cli {
    #[arg(long, default_value = "data", global = true)]
    data: PathBuf,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    VerifyData {
        #[arg(long)]
        baseline: Option<PathBuf>,
    },
    InspectSource {
        path: PathBuf,
        #[arg(long)]
        provider: Option<String>,
        #[arg(long, default_value = "")]
        prefecture: String,
    },
    InspectCatalog {
        provider: String,
    },
    Update {
        #[arg(long)]
        refresh: bool,
    },
    Serve {
        #[arg(long)]
        require_manifest: bool,
        #[arg(long, default_value_t = IpAddr::V4(Ipv4Addr::LOCALHOST))]
        host: IpAddr,
        #[arg(long, default_value_t = 3000)]
        port: u16,
    },
    PrepareService {
        #[arg(long)]
        output: PathBuf,
    },
    Coverage,
    Openapi,
    Export {
        #[arg(long, default_value = "json", value_parser = parse_export_format)]
        format: phonebook_core::ExportFormat,
        #[arg(long, default_value = "")]
        q: String,
        #[arg(long, default_value = "")]
        prefecture: String,
        #[arg(long, default_value = "")]
        category: String,
    },
}

fn parse_export_format(
    value: &str,
) -> Result<phonebook_core::ExportFormat, public_phonebook::model::SearchError> {
    phonebook_core::ExportFormat::parse(value).ok_or(public_phonebook::model::SearchError::Format)
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Command::Openapi => println!(
            "{}",
            serde_json::to_string_pretty(&public_phonebook::web::api_schema())?
        ),
        Command::VerifyData { baseline } => {
            let audit = if let Some(baseline) = baseline {
                public_phonebook::audit::verify_preserving(&cli.data, &baseline)?
            } else {
                public_phonebook::audit::verify(&cli.data)?
            };
            println!("{}", serde_json::to_string_pretty(&audit)?);
        }
        Command::InspectSource {
            path,
            provider,
            prefecture,
        } => {
            if let Some(provider) = provider {
                public_phonebook::import::inspect_provider(
                    &cli.data,
                    &path,
                    &provider,
                    &prefecture,
                )?;
            } else {
                public_phonebook::import::inspect(&path)?;
            }
        }
        Command::InspectCatalog { provider } => {
            public_phonebook::import::inspect_catalog(&cli.data, &provider)?
        }
        Command::Update { refresh } => {
            let result = public_phonebook::import::update(&cli.data, refresh)?;
            println!(
                "{} contacts, {} distinct phone numbers, {}/47 prefectures",
                result.total_contacts, result.unique_phone_numbers, result.prefectures_covered
            );
        }
        Command::Serve {
            host,
            port,
            require_manifest,
        } => tokio::runtime::Runtime::new()?.block_on(public_phonebook::web::serve_snapshot(
            cli.data,
            SocketAddr::new(host, port),
            require_manifest,
        ))?,
        Command::PrepareService { output } => println!(
            "{}",
            serde_json::to_string_pretty(&public_phonebook::snapshot::prepare(
                &cli.data, &output
            )?)?
        ),
        Command::Coverage => println!(
            "{}",
            serde_json::to_string_pretty(&public_phonebook::store::load_coverage(
                &cli.data.join("phonebook.sqlite")
            )?)?
        ),
        Command::Export {
            format,
            q,
            prefecture,
            category,
        } => {
            let query = public_phonebook::model::Search {
                q,
                prefecture,
                category,
                ..Default::default()
            };
            public_phonebook::store::write_export_as(
                &cli.data.join("phonebook.sqlite"),
                &query,
                format,
                std::io::stdout().lock(),
            )?;
        }
    }
    Ok(())
}

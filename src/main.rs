use clap::{Parser, Subcommand};

mod kernel;
mod vision;
mod simulator;
mod planner;
mod workers;
mod evaluator;
mod memory;
mod tools;

#[derive(Parser)]
#[command(name = "arkos", about = "Cognitive AI orchestration engine")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Run a goal through the full Arkos pipeline
    Run {
        /// The goal or prompt to execute
        goal: String,
        /// Verbose output
        #[arg(short, long)]
        verbose: bool,
    },
    /// Show current status / memory stats
    Status,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt::init();

    let cli = Cli::parse();

    match cli.command {
        Commands::Run { goal, verbose } => {
            println!("🧠 Arkos — starting pipeline");
            println!("Goal: {}", goal);
            kernel::run(&goal, verbose).await?;
        }
        Commands::Status => {
            println!("📊 Arkos status");
            // TODO: memory stats, last run info
        }
    }

    Ok(())
}

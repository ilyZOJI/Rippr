mod downloader;
mod error;
mod models;
mod platform;
mod server;
mod store;

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("rippr_helper=info")),
        )
        .compact()
        .init();

    let address = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 43117);
    if let Err(error) = server::run(address).await {
        tracing::error!(%error, "Rippr helper stopped");
        std::process::exit(1);
    }
}

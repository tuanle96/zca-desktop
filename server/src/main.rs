use std::sync::Arc;

use zca_cloud_server::{app, Config, Db};

#[tokio::main]
async fn main() -> anyhow_free::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .json()
        .init();

    let config = Config::from_env()?;
    let db = Db::connect(&config.database_url).await?;
    if std::env::var("ZCA_CLOUD_MIGRATE_DOWN_ONLY")
        .map(|v| matches!(v.as_str(), "1" | "true" | "yes"))
        .unwrap_or(false)
    {
        db.migrate_down_to(0).await?;
        tracing::info!("migrations reverted; exiting due to ZCA_CLOUD_MIGRATE_DOWN_ONLY");
        return Ok(());
    }
    db.migrate().await?;
    if std::env::var("ZCA_CLOUD_MIGRATE_ONLY")
        .map(|v| matches!(v.as_str(), "1" | "true" | "yes"))
        .unwrap_or(false)
    {
        tracing::info!("migrations complete; exiting due to ZCA_CLOUD_MIGRATE_ONLY");
        return Ok(());
    }

    let state = zca_cloud_server::AppState::new(config.clone(), db);
    let restored = state
        .sessions
        .restore_active_sessions(
            state.db.clone(),
            state.config.clone(),
            state.objects.clone(),
            state.events(),
        )
        .await?;
    tracing::info!(restored, "hosted session restore complete");
    let router = app(Arc::new(state));
    let listener = tokio::net::TcpListener::bind(config.bind_addr).await?;
    tracing::info!(addr = %config.bind_addr, "zca cloud server listening");
    axum::serve(
        listener,
        router.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .await?;
    Ok(())
}

mod anyhow_free {
    pub type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;
}

use crate::{
    downloader::Downloader,
    error::RipprError,
    models::{
        AppSettingsPatch, DownloadRequest, HelperInfo, OkResponse, PROTOCOL_VERSION, RpcRequest,
        RpcResponse,
    },
    platform,
    store::{ConfigStore, HistoryStore},
};
use axum::{
    Router,
    extract::{
        State, WebSocketUpgrade,
        ws::{Message, WebSocket},
    },
    response::IntoResponse,
    routing::get,
};
use futures_util::{SinkExt, StreamExt};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use std::{net::SocketAddr, sync::Arc};
use tokio::sync::{broadcast, mpsc};
use tracing::{info, warn};

#[derive(Clone)]
pub struct AppState {
    config: ConfigStore,
    history: HistoryStore,
    downloader: Arc<Downloader>,
    events: broadcast::Sender<String>,
}

impl AppState {
    pub async fn create() -> Result<Self, RipprError> {
        let config = ConfigStore::load(None).await?;
        let history = HistoryStore::load(None).await?;
        let (events, _) = broadcast::channel(256);
        let downloader = Arc::new(Downloader::new(
            config.clone(),
            history.clone(),
            events.clone(),
        ));
        Ok(Self {
            config,
            history,
            downloader,
            events,
        })
    }
}

pub async fn run(address: SocketAddr) -> Result<(), RipprError> {
    let state = AppState::create().await?;
    let app = Router::new()
        .route("/health", get(health))
        .route("/rpc", get(websocket_handler))
        .with_state(state);
    let listener = tokio::net::TcpListener::bind(address)
        .await
        .map_err(|error| {
            RipprError::Internal(if error.kind() == std::io::ErrorKind::AddrInUse {
                "Another Rippr helper is already running.".into()
            } else {
                error.to_string()
            })
        })?;
    info!(%address, "Rippr helper is ready");
    axum::serve(listener, app)
        .await
        .map_err(|error| RipprError::Internal(error.to_string()))
}

async fn health() -> impl IntoResponse {
    axum::Json(
        json!({ "status": "ok", "version": env!("CARGO_PKG_VERSION"), "protocolVersion": PROTOCOL_VERSION }),
    )
}

async fn websocket_handler(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
) -> impl IntoResponse {
    ws.max_message_size(1024 * 1024)
        .on_upgrade(move |socket| handle_socket(socket, state))
}

async fn handle_socket(socket: WebSocket, state: AppState) {
    let (mut socket_writer, mut socket_reader) = socket.split();
    let (writer, mut reader) = mpsc::unbounded_channel::<Message>();
    let mut events = state.events.subscribe();
    let writer_task = tokio::spawn(async move {
        loop {
            tokio::select! {
                message = reader.recv() => {
                    let Some(message) = message else { break };
                    if socket_writer.send(message).await.is_err() { break; }
                }
                event = events.recv() => match event {
                    Ok(event) => if socket_writer.send(Message::Text(event.into())).await.is_err() { break; },
                    Err(broadcast::error::RecvError::Lagged(count)) => warn!(count, "Plugin client lagged behind helper events"),
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        }
        let _ = socket_writer.close().await;
    });

    while let Some(message) = socket_reader.next().await {
        let Ok(message) = message else { break };
        match message {
            Message::Text(text) => {
                let response = match serde_json::from_str::<RpcRequest>(&text) {
                    Ok(request) => handle_request(&state, request).await,
                    Err(error) => serde_json::to_string(&RpcResponse::<Value> {
                        id: "invalid".into(),
                        result: None,
                        error: Some(RipprError::InvalidRequest(error.to_string()).rpc_error()),
                    })
                    .unwrap_or_default(),
                };
                let _ = writer.send(Message::Text(response.into()));
            }
            Message::Close(frame) => {
                let _ = writer.send(Message::Close(frame));
                break;
            }
            Message::Ping(payload) => {
                let _ = writer.send(Message::Pong(payload));
            }
            _ => {}
        }
    }
    drop(writer);
    let _ = writer_task.await;
}

async fn handle_request(state: &AppState, request: RpcRequest) -> String {
    let id = request.id.clone();
    let result = dispatch(state, &request.method, request.params).await;
    let response = match result {
        Ok(result) => RpcResponse {
            id,
            result: Some(result),
            error: None,
        },
        Err(error) => {
            warn!(method = request.method, error = %error, "Helper request failed");
            RpcResponse {
                id,
                result: None,
                error: Some(error.rpc_error()),
            }
        }
    };
    serde_json::to_string(&response).unwrap_or_else(|error| {
        format!(
            r#"{{"id":"invalid","error":{{"code":"SERIALIZATION_ERROR","message":"{error}"}}}}"#
        )
    })
}

async fn dispatch(state: &AppState, method: &str, params: Value) -> Result<Value, RipprError> {
    match method {
        "hello" => {
            let settings = state.config.get().await;
            serialize(HelperInfo {
                version: env!("CARGO_PKG_VERSION").into(),
                protocol_version: PROTOCOL_VERSION,
                platform: std::env::consts::OS.into(),
                dependencies: platform::dependency_statuses(&settings).await,
            })
        }
        "analyze" => {
            #[derive(serde::Deserialize)]
            struct Params {
                url: String,
            }
            let params: Params = parse(params)?;
            serialize(state.downloader.analyze(&params.url).await?)
        }
        "start_download" => {
            let request: DownloadRequest = parse(params)?;
            serialize(state.downloader.start(request).await?)
        }
        "cancel_download" => {
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Params {
                job_id: String,
            }
            let params: Params = parse(params)?;
            state.downloader.cancel(&params.job_id)?;
            serialize(OkResponse {
                ok: true,
                message: None,
            })
        }
        "get_settings" => serialize(state.config.get().await),
        "update_settings" => {
            let patch: AppSettingsPatch = parse(params)?;
            serialize(state.config.update(patch).await?)
        }
        "get_history" => serialize(state.history.list().await),
        "clear_history" => {
            state.history.clear().await?;
            serialize(OkResponse {
                ok: true,
                message: None,
            })
        }
        "folder_status" => {
            #[derive(serde::Deserialize)]
            struct Params {
                path: String,
            }
            let params: Params = parse(params)?;
            serialize(platform::folder_status(&params.path).await?)
        }
        "create_folder" => {
            #[derive(serde::Deserialize)]
            struct Params {
                path: String,
            }
            let params: Params = parse(params)?;
            serialize(platform::create_folder(&params.path).await?)
        }
        "reveal_path" => {
            #[derive(serde::Deserialize)]
            struct Params {
                path: String,
            }
            let params: Params = parse(params)?;
            serialize(platform::reveal_path(&params.path).await?)
        }
        "open_file" => {
            #[derive(serde::Deserialize)]
            struct Params {
                path: String,
            }
            let params: Params = parse(params)?;
            serialize(platform::open_file(&params.path)?)
        }
        "check_dependencies" => {
            let settings = state.config.get().await;
            serialize(platform::dependency_statuses(&settings).await)
        }
        "update_dependency" => {
            #[derive(serde::Deserialize)]
            struct Params {
                name: String,
            }
            let params: Params = parse(params)?;
            serialize(platform::update_dependency(&params.name, &state.config.get().await).await?)
        }
        _ => Err(RipprError::InvalidRequest(format!(
            "Unknown method: {method}"
        ))),
    }
}

fn parse<T: DeserializeOwned>(value: Value) -> Result<T, RipprError> {
    serde_json::from_value(value).map_err(|error| RipprError::InvalidRequest(error.to_string()))
}

fn serialize<T: serde::Serialize>(value: T) -> Result<Value, RipprError> {
    serde_json::to_value(value).map_err(|error| RipprError::Internal(error.to_string()))
}

//! rmcp tool router for the six journal MCP tools.
//!
//! Each `#[tool]` is a thin `spawn_blocking` wrapper over the gated
//! `mcp_*` functions in `commands::mcp`. State is resolved inside the
//! blocking closure so `AppState`'s mutex is never held across `.await`.

use rmcp::{
    handler::server::wrapper::{Json, Parameters},
    schemars,
    schemars::JsonSchema,
    tool, tool_router,
};
use serde::{Deserialize, Serialize};
use tauri::Manager;

use crate::ai::indexer::EntryIndexer;
use crate::commands::mcp as mcp_impl;
use crate::{AppState, EncryptionKeyState};

/// Runtime-erased handle so `#[tool_router]` can stay on a concrete `impl`
/// (the macro does not accept `impl<R: Runtime>`). Production uses Wry;
/// tests pass `mock_app`'s `MockRuntime` handle.
#[derive(Clone)]
enum AppCtx {
    Wry(tauri::AppHandle),
    #[cfg(test)]
    Mock(tauri::AppHandle<tauri::test::MockRuntime>),
}

#[derive(Clone)]
pub(crate) struct McpTools {
    app: AppCtx,
}

impl McpTools {
    pub(crate) fn new(app: tauri::AppHandle) -> Self {
        Self {
            app: AppCtx::Wry(app),
        }
    }

    #[cfg(test)]
    pub(crate) fn new_mock(app: tauri::AppHandle<tauri::test::MockRuntime>) -> Self {
        Self {
            app: AppCtx::Mock(app),
        }
    }
}

impl AppCtx {
    fn create_entry(
        &self,
        state: &AppState,
        key_state: &EncryptionKeyState,
        indexer: &EntryIndexer,
        journal_id: Option<&str>,
        title: Option<&str>,
        markdown: &str,
        date: Option<i64>,
        tags: Option<&[String]>,
        emotion: Option<&str>,
    ) -> Result<mcp_impl::McpCreatedEntry, String> {
        match self {
            AppCtx::Wry(app) => mcp_impl::mcp_create_entry(
                app, state, key_state, indexer, journal_id, title, markdown, date, tags, emotion,
            ),
            #[cfg(test)]
            AppCtx::Mock(app) => mcp_impl::mcp_create_entry(
                app, state, key_state, indexer, journal_id, title, markdown, date, tags, emotion,
            ),
        }
    }

    fn append_to_entry(
        &self,
        state: &AppState,
        key_state: &EncryptionKeyState,
        indexer: &EntryIndexer,
        id: &str,
        markdown: &str,
    ) -> Result<mcp_impl::McpAppendResult, String> {
        match self {
            AppCtx::Wry(app) => {
                mcp_impl::mcp_append_to_entry(app, state, key_state, indexer, id, markdown)
            }
            #[cfg(test)]
            AppCtx::Mock(app) => {
                mcp_impl::mcp_append_to_entry(app, state, key_state, indexer, id, markdown)
            }
        }
    }

    fn set_entry_metadata(
        &self,
        state: &AppState,
        key_state: &EncryptionKeyState,
        indexer: &EntryIndexer,
        id: &str,
        title: Option<&str>,
        tags: Option<&[String]>,
        emotion: Option<&str>,
    ) -> Result<mcp_impl::McpMetadataResult, String> {
        match self {
            AppCtx::Wry(app) => mcp_impl::mcp_set_entry_metadata(
                app, state, key_state, indexer, id, title, tags, emotion,
            ),
            #[cfg(test)]
            AppCtx::Mock(app) => mcp_impl::mcp_set_entry_metadata(
                app, state, key_state, indexer, id, title, tags, emotion,
            ),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
struct SearchEntriesParams {
    query: String,
    from: Option<i64>,
    to: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
struct GetEntryParams {
    id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
struct CreateEntryParams {
    journal_id: Option<String>,
    title: Option<String>,
    markdown: String,
    date: Option<i64>,
    tags: Option<Vec<String>>,
    emotion: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
struct AppendToEntryParams {
    id: String,
    markdown: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
struct SetEntryMetadataParams {
    id: String,
    title: Option<String>,
    tags: Option<Vec<String>>,
    emotion: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, JsonSchema)]
struct JournalOut {
    id: String,
    name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, JsonSchema)]
struct SearchHitOut {
    id: String,
    title: Option<String>,
    date: i64,
    preview: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, JsonSchema)]
struct EntryOut {
    id: String,
    title: Option<String>,
    date: i64,
    text: Option<String>,
    tags: Vec<String>,
    emotion: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, JsonSchema)]
struct CreatedOut {
    id: String,
    journal_id: String,
    journal_name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, JsonSchema)]
struct IdOut {
    id: String,
}

async fn spawn_read<T, F>(app: AppCtx, f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&AppState, &EncryptionKeyState) -> Result<T, String> + Send + 'static,
{
    tokio::task::spawn_blocking(move || match app {
        AppCtx::Wry(app) => {
            let state = app.state::<AppState>();
            let key_state = app.state::<EncryptionKeyState>();
            f(&state, &key_state)
        }
        #[cfg(test)]
        AppCtx::Mock(app) => {
            let state = app.state::<AppState>();
            let key_state = app.state::<EncryptionKeyState>();
            f(&state, &key_state)
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

async fn spawn_write<T, F>(app: AppCtx, f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&AppState, &EncryptionKeyState, &EntryIndexer, &AppCtx) -> Result<T, String>
        + Send
        + 'static,
{
    tokio::task::spawn_blocking(move || match &app {
        AppCtx::Wry(handle) => {
            let state = handle.state::<AppState>();
            let key_state = handle.state::<EncryptionKeyState>();
            let indexer = handle.state::<EntryIndexer>();
            f(&state, &key_state, &indexer, &app)
        }
        #[cfg(test)]
        AppCtx::Mock(handle) => {
            let state = handle.state::<AppState>();
            let key_state = handle.state::<EncryptionKeyState>();
            let indexer = handle.state::<EntryIndexer>();
            f(&state, &key_state, &indexer, &app)
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tool_router(server_handler)]
impl McpTools {
    #[tool(description = "List visible journals. Returns id and name for each.")]
    async fn list_journals(&self) -> Result<Json<Vec<JournalOut>>, String> {
        let app = self.app.clone();
        let journals = spawn_read(app, |state, key_state| {
            mcp_impl::mcp_list_journals(state, key_state)
        })
        .await?;
        Ok(Json(
            journals
                .into_iter()
                .map(|j| JournalOut {
                    id: j.id,
                    name: j.name,
                })
                .collect(),
        ))
    }

    #[tool(
        description = "Search visible unlocked journal entries. query is required. Optional from and to are unix seconds. Returns id, title, date, and preview."
    )]
    async fn search_entries(
        &self,
        Parameters(params): Parameters<SearchEntriesParams>,
    ) -> Result<Json<Vec<SearchHitOut>>, String> {
        let app = self.app.clone();
        let hits = spawn_read(app, move |state, key_state| {
            mcp_impl::mcp_search_entries(state, key_state, &params.query, params.from, params.to)
        })
        .await?;
        Ok(Json(
            hits.into_iter()
                .map(|hit| SearchHitOut {
                    id: hit.id,
                    title: hit.title,
                    date: hit.date,
                    preview: hit.preview,
                })
                .collect(),
        ))
    }

    #[tool(
        description = "Get one visible unlocked entry by id. Returns id, title, date, plain text, tags, and emotion."
    )]
    async fn get_entry(
        &self,
        Parameters(params): Parameters<GetEntryParams>,
    ) -> Result<Json<EntryOut>, String> {
        let app = self.app.clone();
        let entry = spawn_read(app, move |state, key_state| {
            mcp_impl::mcp_get_entry(state, key_state, &params.id)
        })
        .await?;
        Ok(Json(EntryOut {
            id: entry.id,
            title: entry.title,
            date: entry.date,
            text: entry.text,
            tags: entry.tags,
            emotion: entry.emotion,
        }))
    }

    #[tool(
        description = "Create a journal entry from markdown. journal_id, title, date, tags, and emotion are optional. Returns id, journal_id, and journal_name."
    )]
    async fn create_entry(
        &self,
        Parameters(params): Parameters<CreateEntryParams>,
    ) -> Result<Json<CreatedOut>, String> {
        let app = self.app.clone();
        let created = spawn_write(app, move |state, key_state, indexer, app| {
            app.create_entry(
                state,
                key_state,
                indexer,
                params.journal_id.as_deref(),
                params.title.as_deref(),
                &params.markdown,
                params.date,
                params.tags.as_deref(),
                params.emotion.as_deref(),
            )
        })
        .await?;
        Ok(Json(CreatedOut {
            id: created.id,
            journal_id: created.journal_id,
            journal_name: created.journal_name,
        }))
    }

    #[tool(
        description = "Append markdown to an existing visible unlocked entry. Does not replace existing body text. Returns id."
    )]
    async fn append_to_entry(
        &self,
        Parameters(params): Parameters<AppendToEntryParams>,
    ) -> Result<Json<IdOut>, String> {
        let app = self.app.clone();
        let appended = spawn_write(app, move |state, key_state, indexer, app| {
            app.append_to_entry(state, key_state, indexer, &params.id, &params.markdown)
        })
        .await?;
        Ok(Json(IdOut { id: appended.id }))
    }

    #[tool(
        description = "Set title, tags, and/or emotion on a visible unlocked entry. Returns id."
    )]
    async fn set_entry_metadata(
        &self,
        Parameters(params): Parameters<SetEntryMetadataParams>,
    ) -> Result<Json<IdOut>, String> {
        let app = self.app.clone();
        let updated = spawn_write(app, move |state, key_state, indexer, app| {
            app.set_entry_metadata(
                state,
                key_state,
                indexer,
                &params.id,
                params.title.as_deref(),
                params.tags.as_deref(),
                params.emotion.as_deref(),
            )
        })
        .await?;
        Ok(Json(IdOut { id: updated.id }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rmcp::handler::server::common::schema_for_input;
    use serde::de::DeserializeOwned;
    use serde_json::Value;

    const TOOL_NAMES: [&str; 6] = [
        "append_to_entry",
        "create_entry",
        "get_entry",
        "list_journals",
        "search_entries",
        "set_entry_metadata",
    ];

    fn listed_tools() -> Vec<rmcp::model::Tool> {
        McpTools::tool_router().list_all()
    }

    fn tool_named(name: &str) -> rmcp::model::Tool {
        listed_tools()
            .into_iter()
            .find(|tool| tool.name == name)
            .unwrap_or_else(|| panic!("missing tool {name}"))
    }

    fn schema_json_round_trips(tool_name: &str, schema: &serde_json::Map<String, Value>) -> Value {
        let schema_json = serde_json::to_value(schema).expect("serialize schema");
        let schema_back: Value = serde_json::from_value(schema_json.clone()).expect("schema json");
        assert_eq!(
            schema_back, schema_json,
            "{tool_name} schema JSON must round-trip"
        );
        schema_json
    }

    #[test]
    fn router_exposes_exactly_six_named_tools() {
        let names: Vec<String> = listed_tools()
            .into_iter()
            .map(|tool| tool.name.into_owned())
            .collect();
        assert_eq!(
            names, TOOL_NAMES,
            "router must expose exactly the six agreed tool names"
        );
    }

    fn assert_schema_round_trips_params<T>(tool_name: &str, sample: T)
    where
        T: Serialize + DeserializeOwned + JsonSchema + PartialEq + std::fmt::Debug + 'static,
    {
        let tool = tool_named(tool_name);
        let expected =
            schema_for_input::<T>().unwrap_or_else(|e| panic!("{tool_name} schema: {e}"));
        assert_eq!(
            &*tool.input_schema, &*expected,
            "{tool_name} generated input schema must match Parameters<T>"
        );
        schema_json_round_trips(tool_name, &tool.input_schema);

        let encoded = serde_json::to_value(&sample).expect("serialize params");
        let decoded: T = serde_json::from_value(encoded.clone()).expect("deserialize params");
        assert_eq!(decoded, sample, "{tool_name} Parameters<T> must round-trip");
    }

    fn assert_empty_schema_round_trips(tool_name: &str) {
        let tool = tool_named(tool_name);
        let schema_json = schema_json_round_trips(tool_name, &tool.input_schema);
        assert_eq!(schema_json["type"], "object");
        assert_eq!(schema_json["properties"], serde_json::json!({}));
    }

    #[test]
    fn each_generated_schema_round_trips_its_parameters() {
        assert_empty_schema_round_trips("list_journals");
        assert_schema_round_trips_params(
            "search_entries",
            SearchEntriesParams {
                query: "walked the dog".into(),
                from: Some(1_700_000_000),
                to: None,
            },
        );
        assert_schema_round_trips_params(
            "get_entry",
            GetEntryParams {
                id: "entry-1".into(),
            },
        );
        assert_schema_round_trips_params(
            "create_entry",
            CreateEntryParams {
                journal_id: Some("journal-1".into()),
                title: Some("Morning".into()),
                markdown: "hello".into(),
                date: Some(1_700_000_000),
                tags: Some(vec!["walk".into()]),
                emotion: Some("good".into()),
            },
        );
        assert_schema_round_trips_params(
            "append_to_entry",
            AppendToEntryParams {
                id: "entry-1".into(),
                markdown: "and then this".into(),
            },
        );
        assert_schema_round_trips_params(
            "set_entry_metadata",
            SetEntryMetadataParams {
                id: "entry-1".into(),
                title: Some("Renamed".into()),
                tags: None,
                emotion: Some("neutral".into()),
            },
        );
    }
}

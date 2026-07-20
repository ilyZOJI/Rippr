use crate::{
    error::RipprError,
    models::{AppSettings, AppSettingsPatch, HistoryEntry},
};
use directories::{BaseDirs, ProjectDirs, UserDirs};
use serde::{Serialize, de::DeserializeOwned};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};
use tokio::sync::RwLock;

#[derive(Clone)]
pub struct ConfigStore {
    path: PathBuf,
    settings: Arc<RwLock<AppSettings>>,
}

impl ConfigStore {
    pub async fn load(path: Option<PathBuf>) -> Result<Self, RipprError> {
        let path = path.unwrap_or_else(|| data_dir().join("config.json"));
        let mut settings: AppSettings = read_json(&path)
            .await
            .unwrap_or_else(|_| default_settings());
        remove_legacy_seeded_presets(&mut settings);
        settings.schema_version = crate::models::SETTINGS_SCHEMA_VERSION;
        let store = Self {
            path,
            settings: Arc::new(RwLock::new(settings)),
        };
        store.persist().await?;
        Ok(store)
    }

    pub async fn get(&self) -> AppSettings {
        self.settings.read().await.clone()
    }

    pub async fn update(&self, patch: AppSettingsPatch) -> Result<AppSettings, RipprError> {
        let result = {
            let mut settings = self.settings.write().await;
            settings.apply(patch);
            settings.clone()
        };
        write_json_atomic(&self.path, &result).await?;
        Ok(result)
    }

    async fn persist(&self) -> Result<(), RipprError> {
        write_json_atomic(&self.path, &*self.settings.read().await).await
    }
}

#[derive(Clone)]
pub struct HistoryStore {
    path: PathBuf,
    entries: Arc<RwLock<Vec<HistoryEntry>>>,
}

impl HistoryStore {
    pub async fn load(path: Option<PathBuf>) -> Result<Self, RipprError> {
        let path = path.unwrap_or_else(|| data_dir().join("history.json"));
        let entries = read_json(&path).await.unwrap_or_default();
        Ok(Self {
            path,
            entries: Arc::new(RwLock::new(entries)),
        })
    }

    pub async fn list(&self) -> Vec<HistoryEntry> {
        self.entries.read().await.clone()
    }

    pub async fn add(&self, entry: HistoryEntry) -> Result<(), RipprError> {
        let snapshot = {
            let mut entries = self.entries.write().await;
            entries.insert(0, entry);
            entries.truncate(1_000);
            entries.clone()
        };
        write_json_atomic(&self.path, &snapshot).await
    }

    pub async fn clear(&self) -> Result<(), RipprError> {
        self.entries.write().await.clear();
        write_json_atomic(&self.path, &Vec::<HistoryEntry>::new()).await
    }
}

fn data_dir() -> PathBuf {
    ProjectDirs::from("app", "Rippr", "Rippr")
        .map(|dirs| dirs.data_local_dir().to_path_buf())
        .or_else(|| BaseDirs::new().map(|dirs| dirs.data_local_dir().join("Rippr")))
        .unwrap_or_else(|| PathBuf::from(".rippr"))
}

fn default_settings() -> AppSettings {
    let mut settings = AppSettings::default();
    let user = UserDirs::new();
    settings.default_folder = user.and_then(|dirs| {
        dirs.download_dir()
            .map(|path| path.to_string_lossy().into_owned())
    });
    settings
}

fn remove_legacy_seeded_presets(settings: &mut AppSettings) {
    if settings.schema_version >= 2 || settings.folder_presets.is_empty() {
        return;
    }
    let Some(user) = UserDirs::new() else { return };
    let expected: Vec<(&str, PathBuf)> = [
        ("Footage", user.video_dir().map(Path::to_path_buf)),
        ("Music", user.audio_dir().map(Path::to_path_buf)),
        ("SFX", user.audio_dir().map(|path| path.join("SFX"))),
        (
            "Voiceovers",
            user.audio_dir().map(|path| path.join("Voiceovers")),
        ),
        ("Images", user.picture_dir().map(Path::to_path_buf)),
        ("Downloads", user.download_dir().map(Path::to_path_buf)),
        ("Desktop", user.desktop_dir().map(Path::to_path_buf)),
    ]
    .into_iter()
    .filter_map(|(name, path)| path.map(|path| (name, path)))
    .collect();

    let contains_only_seeded = settings.folder_presets.iter().all(|preset| {
        expected
            .iter()
            .any(|(name, path)| preset.name == *name && preset.path == path.to_string_lossy())
    });
    if contains_only_seeded {
        settings.folder_presets.clear();
    }
}

async fn read_json<T: DeserializeOwned>(path: &Path) -> Result<T, RipprError> {
    let bytes = tokio::fs::read(path).await?;
    Ok(serde_json::from_slice(&bytes)?)
}

async fn write_json_atomic<T: Serialize + ?Sized>(
    path: &Path,
    value: &T,
) -> Result<(), RipprError> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let temp = path.with_extension("tmp");
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|error| RipprError::Internal(error.to_string()))?;
    tokio::fs::write(&temp, bytes).await?;
    if tokio::fs::rename(&temp, path).await.is_err() {
        let _ = tokio::fs::remove_file(path).await;
        tokio::fs::rename(&temp, path).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::FolderPreset;

    #[test]
    fn legacy_seeded_presets_are_removed_without_touching_custom_presets() {
        let Some(user) = UserDirs::new() else { return };
        let mut presets: Vec<FolderPreset> = [
            ("Footage", user.video_dir().map(Path::to_path_buf)),
            ("Music", user.audio_dir().map(Path::to_path_buf)),
            ("Downloads", user.download_dir().map(Path::to_path_buf)),
        ]
        .into_iter()
        .filter_map(|(name, path)| {
            path.map(|path| FolderPreset {
                id: name.to_lowercase(),
                name: name.into(),
                path: path.to_string_lossy().into_owned(),
                icon: None,
                color: None,
                project_relative: false,
            })
        })
        .collect();
        if presets.is_empty() {
            return;
        }

        let mut seeded = AppSettings {
            schema_version: 1,
            folder_presets: presets.clone(),
            ..Default::default()
        };
        remove_legacy_seeded_presets(&mut seeded);
        assert!(seeded.folder_presets.is_empty());

        presets.push(FolderPreset {
            id: "custom".into(),
            name: "Client delivery".into(),
            path: "/Volumes/Client/Delivery".into(),
            icon: None,
            color: None,
            project_relative: false,
        });
        let mut customized = AppSettings {
            schema_version: 1,
            folder_presets: presets,
            ..Default::default()
        };
        remove_legacy_seeded_presets(&mut customized);
        assert!(
            customized
                .folder_presets
                .iter()
                .any(|preset| preset.id == "custom")
        );
    }

    #[tokio::test]
    async fn settings_are_versioned_and_persisted() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("config.json");
        let store = ConfigStore::load(Some(path.clone())).await.unwrap();
        store
            .update(AppSettingsPatch {
                auto_import: Some(false),
                concurrent_downloads: Some(99),
                ..Default::default()
            })
            .await
            .unwrap();
        let reloaded = ConfigStore::load(Some(path)).await.unwrap().get().await;
        assert!(!reloaded.auto_import);
        assert_eq!(reloaded.concurrent_downloads, 6);
        assert_eq!(
            reloaded.schema_version,
            crate::models::SETTINGS_SCHEMA_VERSION
        );
    }
}

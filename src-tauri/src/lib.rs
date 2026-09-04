mod am;
mod audio;
mod audio_chunk;
mod demod;
mod filter;
mod nfm;
mod radio;
mod record;
mod rtl_tcp;
mod spectrum;
mod squelch;
mod ssb;
mod wbfm;

use parking_lot::Mutex;
use radio::{RadioConfig, RadioController, RadioStatus};
use record::default_record_path;
use spectrum::SpectrumView;
use serde::Deserialize;
use tauri::ipc::Channel;
use tauri::State;

/// Live demod patch from UI (camelCase in JS: bandwidthHz, deemphasis).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DemodPatch {
    bandwidth_hz: u32,
    deemphasis: bool,
}

/// Live audio patch (camelCase in JS).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AudioPatch {
    squelch_enabled: bool,
    squelch_level: f32,
}

struct AppState {
    session: Mutex<Option<RadioController>>,
}

#[tauri::command]
fn radio_start(
    state: State<AppState>,
    config: RadioConfig,
    spectrum_channel: Channel<SpectrumView>,
) -> Result<(), String> {
    let mut guard = state.session.lock();
    if let Some(session) = guard.take() {
        session.stop();
    }
    let session = RadioController::start(config, spectrum_channel)?;
    *guard = Some(session);
    Ok(())
}

#[tauri::command]
fn radio_stop(state: State<AppState>) {
    let mut guard = state.session.lock();
    if let Some(session) = guard.take() {
        session.stop();
    }
}

#[tauri::command]
fn radio_retune(state: State<AppState>, config: RadioConfig) -> Result<(), String> {
    let guard = state.session.lock();
    if let Some(session) = guard.as_ref() {
        session.retune(config)
    } else {
        Err("not playing".into())
    }
}

#[tauri::command]
fn radio_set_demod(state: State<AppState>, patch: DemodPatch) -> Result<(), String> {
    let guard = state.session.lock();
    if let Some(session) = guard.as_ref() {
        session.set_demod(patch.bandwidth_hz, patch.deemphasis)
    } else {
        Err("not playing".into())
    }
}

#[tauri::command]
fn radio_set_audio(state: State<AppState>, patch: AudioPatch) -> Result<(), String> {
    let guard = state.session.lock();
    if let Some(session) = guard.as_ref() {
        session.set_audio(patch.squelch_enabled, patch.squelch_level)
    } else {
        Err("not playing".into())
    }
}

#[tauri::command]
fn radio_status(state: State<AppState>) -> RadioStatus {
    let guard = state.session.lock();
    guard
        .as_ref()
        .map(|s| s.status())
        .unwrap_or(RadioStatus {
            playing: false,
            level: 0.0,
            level_l: 0.0,
            level_r: 0.0,
            error: None,
            connected: false,
            recording: false,
        })
}

#[tauri::command]
fn radio_record_start(
    state: State<AppState>,
    path: Option<String>,
    freq_hz: Option<u32>,
    stereo: Option<bool>,
) -> Result<String, String> {
    let guard = state.session.lock();
    let session = guard.as_ref().ok_or("not playing")?;
    let path = path.unwrap_or_else(|| {
        default_record_path(freq_hz.unwrap_or(0))
            .to_string_lossy()
            .into_owned()
    });
    session.record_start(path.clone(), stereo.unwrap_or(true))?;
    Ok(path)
}

#[tauri::command]
fn radio_record_stop(state: State<AppState>) -> Result<Option<String>, String> {
    let guard = state.session.lock();
    if let Some(session) = guard.as_ref() {
        session.record_stop()?;
        Ok(session.last_record_path())
    } else {
        Err("not playing".into())
    }
}

#[tauri::command]
fn reveal_path_in_file_manager(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-R", &path])
            .spawn()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .args(["/select,", &path])
            .spawn()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        use std::path::Path;
        let p = Path::new(&path);
        let dir = p.parent().unwrap_or_else(|| Path::new("."));
        std::process::Command::new("xdg-open")
            .arg(dir)
            .spawn()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[allow(unreachable_code)]
    Err("unsupported platform".into())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState {
            session: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            radio_start,
            radio_stop,
            radio_retune,
            radio_set_demod,
            radio_set_audio,
            radio_status,
            radio_record_start,
            radio_record_stop,
            reveal_path_in_file_manager,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

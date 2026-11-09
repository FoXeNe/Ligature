#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(target_os = "linux")]
mod pinch;
mod store;

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::ipc::Response;
use tauri::{Manager, State};

use store::{Board, BoardMeta, GraphData, Hit, Patch, Vault};

type VaultCell = Mutex<Option<Vault>>;

// Commands are `async` so Tauri runs them off the main thread: a large board
// load or a slow disk must not freeze the window.

fn with_vault<T>(
    cell: &State<'_, VaultCell>,
    f: impl FnOnce(&mut Vault) -> Result<T, String>,
) -> Result<T, String> {
    let mut guard = cell.lock().map_err(|e| e.to_string())?;
    let vault = guard.as_mut().ok_or("vault is not open")?;
    f(vault)
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// `$NOTES_VAULT` if set, otherwise `~/Documents/notes-vault`.
/// `document_dir()` is not used: it fails when XDG user dirs are not configured.
fn vault_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Some(dir) = std::env::var_os("NOTES_VAULT") {
        return Ok(PathBuf::from(dir));
    }
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .or_else(|| app.path().home_dir().ok())
        .ok_or("cannot find the home directory")?;
    Ok(home.join("Documents").join("notes-vault"))
}

#[tauri::command]
async fn vault_open(app: tauri::AppHandle, cell: State<'_, VaultCell>) -> Result<String, String> {
    let dir = vault_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let file = dir.join("vault.sqlite");
    let vault = Vault::open(&file)?;
    *cell.lock().map_err(|e| e.to_string())? = Some(vault);
    Ok(file.to_string_lossy().into_owned())
}

#[tauri::command]
async fn list_boards(cell: State<'_, VaultCell>) -> Result<Vec<Board>, String> {
    with_vault(&cell, |v| v.list_boards())
}

#[tauri::command]
async fn create_board(title: String, cell: State<'_, VaultCell>) -> Result<Board, String> {
    with_vault(&cell, |v| v.create_board(&title, now_ms()))
}

#[tauri::command]
async fn rename_board(id: i64, title: String, cell: State<'_, VaultCell>) -> Result<(), String> {
    with_vault(&cell, |v| v.rename_board(id, &title))
}

#[tauri::command]
async fn delete_board(id: i64, cell: State<'_, VaultCell>) -> Result<(), String> {
    with_vault(&cell, |v| v.delete_board(id))
}

#[tauri::command]
async fn load_board(note_id: i64, cell: State<'_, VaultCell>) -> Result<BoardMeta, String> {
    with_vault(&cell, |v| v.load_board(note_id))
}

/// Returns raw bytes, which arrive in JS as an ArrayBuffer without JSON encoding.
#[tauri::command]
async fn load_strokes(note_id: i64, cell: State<'_, VaultCell>) -> Result<Response, String> {
    with_vault(&cell, |v| v.load_strokes(note_id)).map(Response::new)
}

#[tauri::command]
async fn commit(patch: Patch, cell: State<'_, VaultCell>) -> Result<(), String> {
    with_vault(&cell, |v| v.commit(&patch))
}

#[tauri::command]
async fn search(query: String, cell: State<'_, VaultCell>) -> Result<Vec<Hit>, String> {
    with_vault(&cell, |v| v.search(&query))
}

#[tauri::command]
async fn graph(cell: State<'_, VaultCell>) -> Result<GraphData, String> {
    with_vault(&cell, |v| v.graph())
}

fn main() {
    tauri::Builder::default()
        .manage(Mutex::new(None::<Vault>))
        .setup(|_app| {
            #[cfg(target_os = "linux")]
            if let Some(window) = _app.get_webview_window("main") {
                pinch::install(&window)?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            vault_open,
            list_boards,
            create_board,
            rename_board,
            delete_board,
            load_board,
            load_strokes,
            commit,
            search,
            graph
        ])
        .run(tauri::generate_context!())
        .expect("error while running Notes");
}

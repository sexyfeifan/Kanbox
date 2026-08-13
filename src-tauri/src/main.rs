#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    fs::{self, OpenOptions},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::Mutex,
};

use tauri::{path::BaseDirectory, Manager};

const LOCAL_API_PORT: &str = "4318";

struct LocalApiState(Mutex<Option<Child>>);

fn resolve_local_api_script(app: &tauri::App) -> Result<PathBuf, String> {
    let cwd = std::env::current_dir().map_err(|err| err.to_string())?;
    let candidates = [
        cwd.join("scripts/local-api.mjs"),
        cwd.join("../scripts/local-api.mjs"),
    ];

    for candidate in candidates {
        if candidate.exists() {
            return Ok(candidate);
        }
    }

    let bundled = app
        .path()
        .resolve("local-api.mjs", BaseDirectory::Resource)
        .map_err(|err| err.to_string())?;
    if bundled.exists() {
        return Ok(bundled);
    }

    Err("local-api.mjs not found".to_string())
}

fn resolve_node_binary(app: &tauri::App) -> String {
    if let Some(explicit) = std::env::var("LOCAL_API_NODE_BIN")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        return explicit;
    }

    if let Ok(bundled) = app.path().resolve("kanbox-node", BaseDirectory::Resource) {
        if bundled.exists() {
            return bundled.to_string_lossy().into_owned();
        }
    }

    let candidates = [
        "/opt/homebrew/bin/node",
        "/usr/local/bin/node",
        "/usr/bin/node",
    ];

    for candidate in candidates {
        let path = PathBuf::from(candidate);
        if path.exists() {
            return candidate.to_string();
        }
    }

    "node".to_string()
}

fn spawn_local_api(app: &tauri::App) -> Result<Child, String> {
    let script_path = resolve_local_api_script(app)?;
    let node_bin = resolve_node_binary(app);
    let data_dir = app.path().app_local_data_dir().map_err(|err| err.to_string())?;
    fs::create_dir_all(&data_dir).map_err(|err| err.to_string())?;

    // Ensure node binary exists before attempting to spawn
    let node_path = PathBuf::from(&node_bin);
    if !node_path.exists() {
        eprintln!("[kanbox] node binary not found at: {node_bin}");
        if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(data_dir.join("local-api.stderr.log")) {
            use std::io::Write;
            let _ = writeln!(f, "[kanbox] node binary not found at: {node_bin}");
        }
        return Err(format!("node binary not found at: {node_bin}"));
    }

    // Ensure node binary has execute permissions (fixes new Mac installs)
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(metadata) = fs::metadata(&node_bin) {
            let mut perms = metadata.permissions();
            if perms.mode() & 0o111 == 0 {
                perms.set_mode(0o755);
                let _ = fs::set_permissions(&node_bin, perms);
            }
        }
        let _ = Command::new("/usr/bin/xattr")
            .args(["-dr", "com.apple.quarantine", &node_bin])
            .output();
    }

    let stdout_log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(data_dir.join("local-api.stdout.log"))
        .map_err(|err| err.to_string())?;
    let stderr_log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(data_dir.join("local-api.stderr.log"))
        .map_err(|err| err.to_string())?;

    // Set working directory to the script's parent directory for module resolution
    let script_dir = script_path.parent().unwrap_or(&script_path);

    let child = Command::new(&node_bin)
        .arg(&script_path)
        .current_dir(script_dir)
        .env("LOCAL_API_PORT", LOCAL_API_PORT)
        .env("LOCAL_APP_DATA_DIR", &data_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout_log))
        .stderr(Stdio::from(stderr_log))
        .spawn()
        .map_err(|err| format!("failed to spawn local-api with {}: {err}", node_bin))?;

    Ok(child)
}

fn main() {
    let app = tauri::Builder::default()
        .setup(|app| {
            match spawn_local_api(app) {
                Ok(child) => {
                    app.manage(LocalApiState(Mutex::new(Some(child))));
                }
                Err(err) => {
                    eprintln!("{err}");
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if matches!(event, tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit) {
            if let Some(state) = app_handle.try_state::<LocalApiState>() {
                if let Ok(mut child) = state.0.lock() {
                    if let Some(process) = child.as_mut() {
                        let _ = process.kill();
                    }
                    *child = None;
                }
            }
        }
    });
}

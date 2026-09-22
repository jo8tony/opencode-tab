use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

struct SidecarState(Mutex<Option<CommandChild>>);

fn recorder_is_ready() -> bool {
    let address = SocketAddr::from(([127, 0, 0, 1], 8117));
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(300)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
    let request =
        b"GET /__recorder/api/ping HTTP/1.1\r\nHost: 127.0.0.1:8117\r\nConnection: close\r\n\r\n";
    if stream.write_all(request).is_err() {
        return false;
    }
    let mut response = String::new();
    if stream.read_to_string(&mut response).is_err() {
        return false;
    }
    response.contains(" 200 ") && response.contains("\"ok\":true")
}

fn wait_for_recorder(timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if recorder_is_ready() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    false
}

fn stop_sidecar(app: &tauri::AppHandle) {
    let state = app.state::<SidecarState>();
    if let Ok(mut guard) = state.0.lock() {
        if let Some(child) = guard.take() {
            let _ = child.kill();
        }
    };
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .on_window_event(|window, event| {
            #[cfg(target_os = "macos")]
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .setup(|app| {
            let config_dir = app.path().app_config_dir()?;
            let data_dir = app.path().app_data_dir()?;
            let cache_dir = app.path().app_cache_dir()?;
            let log_dir = app.path().app_log_dir()?;
            let state_dir = data_dir.join("state");
            std::fs::create_dir_all(&config_dir)?;
            std::fs::create_dir_all(&data_dir)?;
            std::fs::create_dir_all(&cache_dir)?;
            std::fs::create_dir_all(&log_dir)?;
            std::fs::create_dir_all(&state_dir)?;

            let config_path = config_dir.join("config.json");
            let records_dir = data_dir.join("records");
            let args = [
                "--host".to_string(),
                "127.0.0.1".to_string(),
                "--port".to_string(),
                "8117".to_string(),
                "--config".to_string(),
                config_path.to_string_lossy().into_owned(),
                "--records-dir".to_string(),
                records_dir.to_string_lossy().into_owned(),
            ];

            let current_exe = std::env::current_exe()?;
            let bundled_opencode = current_exe
                .parent()
                .map(|parent| {
                    parent.join(if cfg!(windows) {
                        "opencode.exe"
                    } else {
                        "opencode"
                    })
                })
                .unwrap_or_default();
            let mut sidecar = app.shell().sidecar("llm-api-proxy-recorder-sidecar")?;
            for key in [
                "XDG_CONFIG_HOME",
                "XDG_DATA_HOME",
                "XDG_CACHE_HOME",
                "XDG_STATE_HOME",
            ] {
                sidecar = sidecar.env(
                    format!("LLMPR_ORIGINAL_{key}"),
                    std::env::var_os(key).unwrap_or_default(),
                );
            }
            sidecar = sidecar
                .env("LLMPR_BUNDLED_OPENCODE", bundled_opencode)
                .env("XDG_CONFIG_HOME", &config_dir)
                .env("XDG_DATA_HOME", &data_dir)
                .env("XDG_CACHE_HOME", &cache_dir)
                .env("XDG_STATE_HOME", &state_dir);
            let (mut receiver, child) = sidecar.args(args).spawn()?;
            app.manage(SidecarState(Mutex::new(Some(child))));

            let log_path = log_dir.join("desktop.log");
            tauri::async_runtime::spawn(async move {
                let mut log_file = std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(log_path)
                    .ok();
                while let Some(event) = receiver.recv().await {
                    match event {
                        CommandEvent::Stdout(bytes) => {
                            eprint!("{}", String::from_utf8_lossy(&bytes));
                            if let Some(file) = log_file.as_mut() {
                                let _ = file.write_all(&bytes);
                            }
                        }
                        CommandEvent::Stderr(bytes) => {
                            eprint!("{}", String::from_utf8_lossy(&bytes));
                            if let Some(file) = log_file.as_mut() {
                                let _ = file.write_all(&bytes);
                            }
                        }
                        _ => {}
                    }
                }
            });

            let window =
                WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                    .title("LLM API 代理记录器")
                    .inner_size(1280.0, 820.0)
                    .min_inner_size(900.0, 620.0)
                    .center()
                    .build()?;

            std::thread::spawn(move || {
                if wait_for_recorder(Duration::from_secs(60)) {
                    if let Ok(url) = url::Url::parse("http://127.0.0.1:8117/__recorder/") {
                        let _ = window.navigate(url);
                    }
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build desktop application");

    app.run(|app_handle, event| match event {
        RunEvent::Exit | RunEvent::ExitRequested { .. } => stop_sidecar(app_handle),
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => {
            if let Some(window) = app_handle.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
        _ => {}
    });
}

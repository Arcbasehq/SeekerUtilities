use serde::Serialize;
use std::sync::Mutex;
use std::process::{Command, Stdio};
use std::io::{BufRead, BufReader};
use sysinfo::{System, Networks, Disks};
use tauri::{State, AppHandle, Emitter};
use tauri_plugin_updater::UpdaterExt;

struct AppState {
    sys: Mutex<System>,
    networks: Mutex<Networks>,
    disks: Mutex<Disks>,
    // Optionally holds a child process for diagnostics tailing
    diag_child: Mutex<Option<std::process::Child>>,
}

#[derive(Serialize)]
struct SystemMetrics {
    cpu_usage: f32,
    total_memory: u64,
    used_memory: u64,
    total_swap: u64,
    used_swap: u64,
    disk_total: u64,
    disk_used: u64,
    net_rx: u64,
    net_tx: u64,
}

#[derive(Serialize)]
struct ProcessInfo {
    pid: u32,
    name: String,
    memory: u64,
    cpu_usage: f32,
}

#[derive(Serialize)]
struct StaticSysInfo {
    os_name: String,
    kernel_version: String,
    cpu_model: String,
    cpu_cores: usize,
    hostname: String,
}

#[derive(Serialize)]
struct MockApp {
    id: String,
    name: String,
    size: String,
    icon: String,
}

#[derive(Serialize)]
struct DiskInfo {
    name: String,
    mount_point: String,
    total_space: u64,
    available_space: u64,
    file_system: String,
}

#[derive(Serialize)]
struct UpdateResponse {
    status: String,
    title: String,
    message: String,
}

#[tauri::command]
fn get_system_metrics(state: State<'_, AppState>) -> SystemMetrics {
    let mut sys = state.sys.lock().unwrap();
    sys.refresh_cpu_usage();
    sys.refresh_memory();
    
    let mut networks = state.networks.lock().unwrap();
    networks.refresh(true); // true means clear removed interfaces
    
    let mut disks = state.disks.lock().unwrap();
    disks.refresh(true);

    let cpu_usage = sys.global_cpu_usage();
    let total_memory = sys.total_memory();
    let used_memory = sys.used_memory();
    let total_swap = sys.total_swap();
    let used_swap = sys.used_swap();
    
    let mut disk_total = 0;
    let mut disk_used = 0;
    for disk in disks.list() {
        disk_total += disk.total_space();
        let available = disk.available_space();
        let used = disk.total_space().saturating_sub(available);
        disk_used += used;
    }
    
    let mut net_rx = 0;
    let mut net_tx = 0;
    for (_, data) in networks.iter() {
        net_rx += data.received();
        net_tx += data.transmitted();
    }

    SystemMetrics {
        cpu_usage,
        total_memory,
        used_memory,
        total_swap,
        used_swap,
        disk_total,
        disk_used,
        net_rx,
        net_tx,
    }
}

#[tauri::command]
fn get_processes(state: State<'_, AppState>) -> Vec<ProcessInfo> {
    let mut sys = state.sys.lock().unwrap();
    sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);

    let mut processes: Vec<ProcessInfo> = sys
        .processes()
        .iter()
        .map(|(pid, p)| ProcessInfo {
            pid: pid.as_u32(),
            name: p.name().to_string_lossy().into_owned(),
            memory: p.memory(),
            cpu_usage: p.cpu_usage(),
        })
        .collect();

    processes.sort_by(|a, b| b.memory.cmp(&a.memory));
    processes.truncate(20);

    processes
}

#[tauri::command]
fn run_maintenance(state: State<'_, AppState>) -> Result<String, String> {
    let mem_before = {
        let mut sys = state.sys.lock().unwrap();
        sys.refresh_memory();
        sys.used_memory()
    };
    
    let output = Command::new("pkexec")
        .arg("sh")
        .arg("-c")
        .arg("sync; echo 3 > /proc/sys/vm/drop_caches")
        .output();
        
    match output {
        Ok(out) if out.status.success() => {
            let mem_after = {
                let mut sys = state.sys.lock().unwrap();
                sys.refresh_memory();
                sys.used_memory()
            };
            
            let freed = if mem_before > mem_after {
                mem_before - mem_after
            } else {
                0
            };
            
            let mb_freed = freed / (1024 * 1024);
            Ok(format!("Successfully wiped unused physical system cache. Reclaimed {} MB of footprint.", mb_freed))
        },
        Ok(out) => {
            let err = String::from_utf8_lossy(&out.stderr);
            Err(format!("Cleanup natively blocked or failed: {}", err))
        },
        Err(e) => Err(format!("Failed to execute authentication hook: {}", e)),
    }
}

#[tauri::command]
fn get_static_sysinfo() -> StaticSysInfo {
    let mut sys = System::new();
    sys.refresh_cpu_all();

    let cpus = sys.cpus();
    let cpu_model = if !cpus.is_empty() {
        cpus[0].brand().to_string()
    } else {
        "Unknown CPU".to_string()
    };

    StaticSysInfo {
        os_name: System::long_os_version().unwrap_or_else(|| "Unknown OS".to_string()),
        kernel_version: System::kernel_version().unwrap_or_else(|| "Unknown Kernel".to_string()),
        cpu_model,
        cpu_cores: cpus.len(),
        hostname: System::host_name().unwrap_or_else(|| "Localhost".to_string()),
    }
}

#[tauri::command]
fn get_advanced_sysinfo(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let mut sys = state.sys.lock().map_err(|e| format!("Lock error: {}", e))?;
    sys.refresh_all();

    // CPUs
    let cpus: Vec<serde_json::Value> = sys.cpus().iter().map(|c| {
        serde_json::json!({
            "brand": c.brand(),
            "frequency": c.frequency(),
            "vendor_id": c.vendor_id(),
        })
    }).collect();

    // Disks
    let mut disks_lock = state.disks.lock().map_err(|e| format!("Disk lock error: {}", e))?;
    disks_lock.refresh(true);
    let disks: Vec<DiskInfo> = disks_lock.list().iter().map(|d| DiskInfo {
        name: d.name().to_string_lossy().into_owned(),
        mount_point: d.mount_point().to_string_lossy().into_owned(),
        total_space: d.total_space(),
        available_space: d.available_space(),
        file_system: d.file_system().to_string_lossy().into_owned(),
    }).collect();

    // Memory
    let total_memory = sys.total_memory();
    let used_memory = sys.used_memory();

    // Processes count
    let proc_count = sys.processes().len();

    Ok(serde_json::json!({
        "cpus": cpus,
        "disks": disks,
        "total_memory": total_memory,
        "used_memory": used_memory,
        "process_count": proc_count
    }))
}

#[tauri::command]
fn start_log_tail(app: AppHandle, state: State<'_, AppState>, unit: Option<String>) -> Result<String, String> {
    // Start a background journalctl -f process and emit lines to frontend
    let mut sys = state.sys.lock().map_err(|e| format!("Lock error: {}", e))?;

    // If a child is already running, return
    {
        let mut guard = state.diag_child.lock().map_err(|e| format!("Lock error: {}", e))?;
        if guard.is_some() {
            return Err("Diagnostics already running".into());
        }
    }

    let cmd = if unit.is_some() {
        format!("journalctl -u {} -f --no-pager", unit.unwrap())
    } else {
        "journalctl -f --no-pager".to_string()
    };

    let mut child = Command::new("sh")
        .arg("-c")
        .arg(&cmd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn journalctl: {}", e))?;

    if let Some(stdout) = child.stdout.take() {
        let app_clone = app.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                if let Ok(l) = line {
                    let _ = app_clone.emit("diag-log", l);
                }
            }
        });
    }

    if let Some(stderr) = child.stderr.take() {
        let app_clone = app.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines() {
                if let Ok(l) = line {
                    let _ = app_clone.emit("diag-log", format!("ERR > {}", l));
                }
            }
        });
    }

    // Store child in state so we can stop it later
    {
        let mut guard = state.diag_child.lock().map_err(|e| format!("Lock error: {}", e))?;
        *guard = Some(child);
    }

    Ok("Diagnostics tail started".into())
}

#[tauri::command]
fn stop_log_tail(state: State<'_, AppState>) -> Result<String, String> {
    let mut guard = state.diag_child.lock().map_err(|e| format!("Lock error: {}", e))?;
    if let Some(mut child) = guard.take() {
        let _ = child.kill();
        let _ = child.wait();
        return Ok("Diagnostics stopped".into());
    }
    Err("No diagnostics process running".into())
}

#[tauri::command]
fn run_booster(state: State<'_, AppState>) -> Result<String, String> {
    let mem_before = {
        let mut sys = state.sys.lock().unwrap();
        sys.refresh_memory();
        sys.used_memory()
    };
    
    let output = Command::new("pkexec")
        .arg("sh")
        .arg("-c")
        .arg("sync; echo 3 > /proc/sys/vm/drop_caches")
        .output();
        
    match output {
        Ok(out) if out.status.success() => {
            std::thread::sleep(std::time::Duration::from_millis(500));
            let mem_after = {
                let mut sys = state.sys.lock().unwrap();
                sys.refresh_memory();
                sys.used_memory()
            };
            
            let freed = if mem_before > mem_after { mem_before - mem_after } else { 0 };
            let freed_mb = freed as f64 / 1024.0 / 1024.0;
            
            Ok(format!("Successfully dropped cache! Automatically reclaimed {:.1} MB of RAM.", freed_mb))
        },
        Ok(out) => Err(format!("Action blocked or failed: {}", String::from_utf8_lossy(&out.stderr))),
        Err(e) => Err(format!("Failed to retrieve permissions: {}", e))
    }
}

#[tauri::command]
fn get_installed_apps() -> Vec<MockApp> {
    let output = Command::new("dpkg-query")
        .arg("-W")
        .arg("-f=${binary:Package}|${Installed-Size}\n")
        .output();
        
    let mut apps: Vec<MockApp> = Vec::new();
    
    if let Ok(output) = output {
        let stdout = String::from_utf8_lossy(&output.stdout);
        for line in stdout.lines() {
            let parts: Vec<&str> = line.split('|').collect();
            if parts.len() == 2 {
                let name = parts[0].to_string();
                if let Ok(size_kb) = parts[1].parse::<u64>() {
                    // Filter out core libraries to show tangible apps to user
                    if size_kb > 30_000 && !name.starts_with("lib") && !name.starts_with("linux-") {
                        let size_mb = size_kb as f64 / 1024.0;
                        apps.push(MockApp {
                            id: name.clone(),
                            name,
                            size: format!("{:.1} MB", size_mb),
                            icon: "fa-solid fa-box".to_string(), // Generic icon
                        });
                    }
                }
            }
        }
    }
    
    // Sort heaviest applications to the top
    apps.sort_by(|a, b| {
        let size_a = a.size.split(' ').next().unwrap().parse::<f64>().unwrap_or(0.0);
        let size_b = b.size.split(' ').next().unwrap().parse::<f64>().unwrap_or(0.0);
        size_b.partial_cmp(&size_a).unwrap_or(std::cmp::Ordering::Equal)
    });
    
    apps.truncate(40);
    apps
}

#[tauri::command]
fn uninstall_app(id: String) -> Result<String, String> {
    let output = Command::new("pkexec")
        .arg("apt-get")
        .arg("remove")
        .arg("-y")
        .arg(&id)
        .output();
        
    match output {
        Ok(out) if out.status.success() => {
            Ok(format!("Successfully cleanly removed the associated package for: {}", id))
        },
        Ok(out) => {
            Err(format!("Action blocked or failed: {}", String::from_utf8_lossy(&out.stderr)))
        },
        Err(e) => {
            Err(format!("Failed to execute pkexec root prompt: {}", e))
        }
    }
}

#[tauri::command]
async fn check_for_updates(app: AppHandle) -> Result<UpdateResponse, String> {
    let updater = app.updater().map_err(|e| format!("Failed to initialize updater: {}", e))?;
    
    // Check for updates, but if it fails (e.g., no latest.json exists yet on Github), treat it gracefully.
    let update_result = updater.check().await;
    
    let update = match update_result {
        Ok(opt) => opt,
        Err(e) => {
            return Ok(UpdateResponse {
                status: "uptodate".to_string(),
                title: "No Release Found".to_string(),
                message: format!("The update server is active, but no 'latest.json' release is published on the remote yet. ({})", e),
            });
        }
    };
    
    if let Some(update) = update {
        let version = update.version.to_string();
        
        let _ = update.download_and_install(
            |_chunk_length: usize, _content_length: Option<u64>| {
                // Optional progress tracking
            },
            || {
                println!("Download logic completed successfully!");
            }
        ).await.map_err(|e| format!("Failed to process signed binary update: {}", e))?;
        
        return Ok(UpdateResponse {
            status: "upgrade".to_string(),
            title: format!("Update Installed: v{}", version),
            message: "The application has been successfully updated and verified. Please securely restart Seeker Utilities to apply the changes.".to_string(),
        });
    }
    
    Ok(UpdateResponse {
        status: "uptodate".to_string(),
        title: "You're up to date".to_string(),
        message: "You are currently running the latest compiled version of Seeker Utilities.".to_string(),
    })
}

#[tauri::command]
async fn send_telemetry(enabled: bool) -> Result<String, String> {
    if !enabled {
        return Ok("Telemetry disabled by user.".to_string());
    }

    let client = reqwest::Client::new();
    let info = get_static_sysinfo();
    
    // In a real production environment, you would use your official domain here.
    // For now, we simulate a successful POST ping to Seeker's analytics endpoint.
    let url = "https://utilities.arcbase.one/api/telemetry-ping";
    
    match client.post(url)
        .json(&info)
        .timeout(std::time::Duration::from_secs(3))
        .send()
        .await {
            Ok(_) => Ok("Telemetry ping sent successfully.".to_string()),
            Err(_) => Ok("Telemetry ping failed (Likely offline/local dev). Slapping success to avoid UI noise.".to_string())
        }
}

#[tauri::command]
async fn run_system_update(app: AppHandle) -> Result<String, String> {
    #[cfg(target_os = "linux")]
    {
        let update_cmd = if std::path::Path::new("/usr/bin/pacman").exists() {
            "pkexec pacman -Syu --noconfirm"
        } else if std::path::Path::new("/usr/bin/apt-get").exists() {
            "pkexec sh -c 'apt-get update && apt-get upgrade -y'"
        } else if std::path::Path::new("/usr/bin/dnf").exists() {
            "pkexec dnf upgrade -y"
        } else if std::path::Path::new("/usr/bin/zypper").exists() {
            "pkexec zypper dup -y"
        } else {
            return Err("Unsupported OS Distribution - no known package manager located.".into());
        };

        let _ = app.emit("os-update-log", "Initializing native package manager loop...");
        let _ = app.emit("os-update-log", format!("> {}", update_cmd));

        let mut child = Command::new("sh")
            .arg("-c")
            .arg(update_cmd)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Failed to elevate process natively: {}", e))?;

        if let Some(stdout) = child.stdout.take() {
            let app_clone = app.clone();
            std::thread::spawn(move || {
                let reader = BufReader::new(stdout);
                for line in reader.lines() {
                    if let Ok(l) = line {
                        let _ = app_clone.emit("os-update-log", l);
                    }
                }
            });
        }
        
        if let Some(stderr) = child.stderr.take() {
            let app_clone = app.clone();
            std::thread::spawn(move || {
                let reader = BufReader::new(stderr);
                for line in reader.lines() {
                    if let Ok(l) = line {
                        let _ = app_clone.emit("os-update-log", format!("ERR > {}", l));
                    }
                }
            });
        }

        let status = child.wait().map_err(|e| format!("Wait loop completely failed: {}", e))?;
        if status.success() {
            let _ = app.emit("os-update-log", "");
            let _ = app.emit("os-update-log", "--- NATIVE SEQUENCE FINISHED SUCCESSFULLY ---");
            Ok("System successfully updated and tracked.".into())
        } else {
            let _ = app.emit("os-update-log", "");
            let _ = app.emit("os-update-log", "--- SEQUENCE RETURNED A FAILURE FAULT ---");
            Err("System update forcibly aborted via failure status.".into())
        }
    }

    #[cfg(target_os = "windows")]
    {
        let _ = app.emit("os-update-log", "Initializing Native Winget Upgrade Engine...");
        let mut child = Command::new("cmd")
            .args(["/C", "winget upgrade --all"])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| e.to_string())?;

        if let Some(stdout) = child.stdout.take() {
            let app_clone = app.clone();
            std::thread::spawn(move || {
                let reader = BufReader::new(stdout);
                for line in reader.lines() {
                    if let Ok(l) = line {
                        let _ = app_clone.emit("os-update-log", l);
                    }
                }
            });
        }

        let status = child.wait().map_err(|e| e.to_string())?;
        if status.success() {
            let _ = app.emit("os-update-log", "\n--- Update OK ---");
            Ok("Winget tracked correctly".into())
        } else {
            let _ = app.emit("os-update-log", "\n--- Update FAILED ---");
            Err("Winget fail hook".into())
        }
    }

    #[cfg(target_os = "macos")]
    {
        let _ = app.emit("os-update-log", "Initializing macOS Universal Software Update loop...");
        let mut child = Command::new("sh")
            .arg("-c")
            .arg("sudo softwareupdate -i -a")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| e.to_string())?;

        if let Some(stdout) = child.stdout.take() {
            let app_clone = app.clone();
            std::thread::spawn(move || {
                let reader = BufReader::new(stdout);
                for line in reader.lines() {
                    if let Ok(l) = line {
                        let _ = app_clone.emit("os-update-log", l);
                    }
                }
            });
        }

        let status = child.wait().map_err(|e| e.to_string())?;
        if status.success() {
            let _ = app.emit("os-update-log", "\n--- Update OK ---");
            Ok("macOS success".into()) 
        } else {
            let _ = app.emit("os-update-log", "\n--- Update FAILED ---");
            Err("macOS fail".into()) 
        }
    }
}

#[tauri::command]
fn run_advanced_cmd(app: AppHandle, cmd: String, use_root: bool) -> Result<String, String> {
    #[cfg(not(any(target_os = "windows")))]
    {
        let mut child = if use_root {
            Command::new("pkexec")
                .arg("sh")
                .arg("-c")
                .arg(&cmd)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .map_err(|e| format!("Failed to spawn privileged command: {}", e))?
        } else {
            Command::new("sh")
                .arg("-c")
                .arg(&cmd)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .map_err(|e| format!("Failed to spawn command: {}", e))?
        };

        if let Some(stdout) = child.stdout.take() {
            let app_clone = app.clone();
            std::thread::spawn(move || {
                let reader = BufReader::new(stdout);
                for line in reader.lines() {
                    if let Ok(l) = line {
                        let _ = app_clone.emit("advanced-log", l);
                    }
                }
            });
        }

        if let Some(stderr) = child.stderr.take() {
            let app_clone = app.clone();
            std::thread::spawn(move || {
                let reader = BufReader::new(stderr);
                for line in reader.lines() {
                    if let Ok(l) = line {
                        let _ = app_clone.emit("advanced-log", format!("ERR > {}", l));
                    }
                }
            });
        }

        let status = child.wait().map_err(|e| format!("Failed waiting for command: {}", e))?;
        if status.success() {
            Ok("Command completed.".into())
        } else {
            Err("Command returned non-zero status.".into())
        }
    }

    #[cfg(target_os = "windows")]
    {
        Err("Advanced command execution is not implemented on Windows in this build.".into())
    }
}

#[tauri::command]
fn get_sysctl(key: String) -> Result<String, String> {
    let output = Command::new("sysctl")
        .arg("-n")
        .arg(&key)
        .output();

    match output {
        Ok(out) if out.status.success() => Ok(String::from_utf8_lossy(&out.stdout).trim().to_string()),
        Ok(out) => Err(String::from_utf8_lossy(&out.stderr).to_string()),
        Err(e) => Err(format!("Failed to run sysctl: {}", e)),
    }
}

#[tauri::command]
fn set_sysctl(key: String, value: String) -> Result<String, String> {
    let cmd = format!("sysctl -w {}={}", key, value);
    let output = Command::new("pkexec")
        .arg("sh")
        .arg("-c")
        .arg(&cmd)
        .output();

    match output {
        Ok(out) if out.status.success() => Ok(String::from_utf8_lossy(&out.stdout).trim().to_string()),
        Ok(out) => Err(String::from_utf8_lossy(&out.stderr).to_string()),
        Err(e) => Err(format!("Failed to set sysctl: {}", e)),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut sys = System::new();
    sys.refresh_memory();
    sys.refresh_cpu_usage();
    
    let networks = Networks::new_with_refreshed_list();
    let disks = Disks::new_with_refreshed_list();

    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec!["--hidden"])))
        .manage(AppState {
            sys: Mutex::new(sys),
            networks: Mutex::new(networks),
            disks: Mutex::new(disks),
            diag_child: Mutex::new(None),
        })
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            get_system_metrics,
            get_processes,
            run_maintenance,
            get_static_sysinfo,
            get_advanced_sysinfo,
            run_booster,
            get_installed_apps,
            uninstall_app,
            check_for_updates,
            run_system_update,
            send_telemetry,
            run_advanced_cmd,
            get_sysctl,
            set_sysctl
            ,
            start_log_tail,
            stop_log_tail
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

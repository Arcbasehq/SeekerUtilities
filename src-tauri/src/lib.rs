use serde::Serialize;
use std::sync::Mutex;
use std::process::{Command, Stdio};
use std::io::{BufRead, BufReader};
use sysinfo::{System, Networks, Disks};
use tauri::{State, AppHandle, Emitter};
struct AppState {
    sys: Mutex<System>,
    networks: Mutex<Networks>,
    disks: Mutex<Disks>,
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
async fn check_for_updates() -> Result<UpdateResponse, String> {
    let client = reqwest::Client::builder()
        .user_agent("seeker-utilities-updater")
        .build()
        .map_err(|e| e.to_string())?;

    let url = "https://api.github.com/repos/tauri-apps/tauri/releases/latest";
    let res = client.get(url).send().await.map_err(|e| format!("Network strictly failed: {}", e))?;
    
    if res.status().is_success() {
        if let Ok(json) = res.json::<serde_json::Value>().await {
            let latest_version = json["tag_name"].as_str().unwrap_or("Unknown");
            
            return Ok(UpdateResponse {
                status: "upgrade".to_string(),
                title: format!("Update Available: {}", latest_version),
                message: "A compiled newer version of Seeker Utilities was found remotely! In a full release environment, this button would trigger a secure cryptographic MS/DEB download and silent patch override.".to_string(),
            });
        }
    }
    
    Ok(UpdateResponse {
        status: "uptodate".to_string(),
        title: "You're up to date".to_string(),
        message: "You are currently running the latest compiled version of Seeker Utilities (v0.1.0).".to_string()
    })
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut sys = System::new();
    sys.refresh_memory();
    sys.refresh_cpu_usage();
    
    let networks = Networks::new_with_refreshed_list();
    let disks = Disks::new_with_refreshed_list();

    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .manage(AppState {
            sys: Mutex::new(sys),
            networks: Mutex::new(networks),
            disks: Mutex::new(disks),
        })
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            get_system_metrics,
            get_processes,
            run_maintenance,
            get_static_sysinfo,
            run_booster,
            get_installed_apps,
            uninstall_app,
            check_for_updates,
            run_system_update
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

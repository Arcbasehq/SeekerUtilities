const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

// State
let currentTab = 'dashboard';
let cpuChart;
let dataPollInterval;
let netChart;
let prevNetRx = null;
let prevNetTx = null;
let prevNetTs = null;
let netView = 'in';

// Format Utils
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Format bytes-per-second into human string
function formatBps(bps) {
  if (!isFinite(bps) || bps <= 0) return '0 B/s';
  if (bps >= 1048576) return (bps / 1048576).toFixed(1) + ' MB/s';
  if (bps >= 1024) return (bps / 1024).toFixed(1) + ' KB/s';
  return Math.round(bps) + ' B/s';
}

// Chart Initialization
function initChart() {
  const ctx = document.getElementById('cpuChart').getContext('2d');

  // Custom gradient for the light blue chart
  const gradient = ctx.createLinearGradient(0, 0, 0, 300);
  gradient.addColorStop(0, 'rgba(37, 99, 235, 0.25)'); // Light professional blue
  gradient.addColorStop(1, 'rgba(37, 99, 235, 0.0)');

  cpuChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: Array(20).fill(''),
      datasets: [{
        label: 'CPU Usage (%)',
        data: Array(20).fill(0),
        borderColor: '#2563eb', // Clean sharp blue
        backgroundColor: gradient,
        borderWidth: 2,
        tension: 0.2, // Sharper tension compared to previous 0.4
        fill: true,
        pointRadius: 0,
        pointHoverRadius: 4
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        y: {
          min: 0,
          max: 100,
          grid: {
            color: 'rgba(0, 0, 0, 0.05)',
            borderDash: [5, 5]
          },
          ticks: { color: '#64748b' } // text-muted
        },
        x: {
          grid: { display: false },
          ticks: { display: false }
        }
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: function (context) {
              return context.parsed.y.toFixed(1) + '%';
            }
          }
        }
      },
      animation: { duration: 0 } // Smooth real-time updates
    }
  });
}

// Data Fetching and Updating
async function updateMetrics() {
  try {
    const metrics = await invoke("get_system_metrics");

    // Convert to GB
    const gTotal = (metrics.total_memory / (1024 ** 3)).toFixed(1);
    const gUsed = (metrics.used_memory / (1024 ** 3)).toFixed(1);
    const memPercent = (metrics.used_memory / metrics.total_memory) * 100;

    // Update DOM
    document.getElementById('cpu-stat').textContent = metrics.cpu_usage.toFixed(1) + '%';
    document.getElementById('cpu-bar').style.width = metrics.cpu_usage + '%';

    document.getElementById('mem-stat').textContent = `${gUsed} / ${gTotal} GB`;
    document.getElementById('mem-bar').style.width = memPercent + '%';

    updateMemoryChart(metrics.used_memory, metrics.total_memory);

    const swapTotal = (metrics.total_swap / (1024 ** 3)).toFixed(1);
    const swapUsed = (metrics.used_swap / (1024 ** 3)).toFixed(1);
    document.getElementById('swap-stat').textContent = `${swapUsed} / ${swapTotal} GB`;
    document.getElementById('swap-bar').style.width = `${metrics.total_swap ? (metrics.used_swap / metrics.total_swap) * 100 : 0}%`;

    const diskTotal = (metrics.disk_total / (1024 ** 3)).toFixed(1);
    const diskUsed = (metrics.disk_used / (1024 ** 3)).toFixed(1);
    document.getElementById('disk-stat').textContent = `${diskUsed} / ${diskTotal} GB`;
    document.getElementById('disk-bar').style.width = `${metrics.disk_total ? (metrics.disk_used / metrics.disk_total) * 100 : 0}%`;

    const downBps = metrics.net_rx / 2.5;
    // Compute bytes-per-second using previous samples
    const now = Date.now();
    let bpsDown = 0;
    let bpsUp = 0;
    if (prevNetRx !== null && prevNetTs !== null) {
      const dt = (now - prevNetTs) / 1000.0;
      if (dt > 0) {
        bpsDown = Math.max(0, (metrics.net_rx - prevNetRx) / dt);
        bpsUp = Math.max(0, (metrics.net_tx - prevNetTx) / dt);
      }
    }
    prevNetRx = metrics.net_rx;
    prevNetTx = metrics.net_tx;
    prevNetTs = now;

    document.getElementById('net-down').textContent = formatBps(bpsDown);
    document.getElementById('net-up').textContent = formatBps(bpsUp);

    // Update network chart depending on netView
    if (netChart) {
      const dataset = netChart.data.datasets[0].data;
      dataset.shift();
      dataset.push(netView === 'in' ? bpsDown : bpsUp);
      // Update dataset color based on view
      if (netView === 'in') {
        netChart.data.datasets[0].borderColor = '#10b981';
        netChart.data.datasets[0].backgroundColor = netChart.data.datasets[0].backgroundColor; // keep as-is
      } else {
        netChart.data.datasets[0].borderColor = '#6366f1';
      }
      netChart.update();
    }

    // Calculate dynamic Seeker Score
    const swapPercent = (metrics.used_swap / (metrics.total_swap || 1)) * 100;
    // Scale 100, dropping hard based on loads
    const score = Math.max(0, Math.round(100 - (metrics.cpu_usage * 0.4) - (memPercent * 0.4) - (swapPercent * 0.2)));

    let stateText = 'Optimal Performance';
    let stateColorClass = 'text-success';
    let dotClass = 'bg-success';
    let scoreColorClass = 'text-primary-gradient';
    let strokeColor = 'var(--primary-color)';

    // no-op local; memChart is a module-level chart variable declared later

    if (score < 50 || metrics.cpu_usage > 90 || memPercent > 90) {
      stateText = 'Critical System Load';
      stateColorClass = 'text-danger';
      dotClass = 'bg-danger';
      scoreColorClass = 'text-danger';
      strokeColor = '#ef4444';

      // Native notification check
      const alertsEnabled = localStorage.getItem('setting-alerts') !== 'false';
      if (alertsEnabled) {
        const lastAlert = parseInt(localStorage.getItem('last-alert-time') || '0');
        if (Date.now() - lastAlert > 60000) { // 1 min cooldown
          try {
            const granted = await invoke("plugin:notification|is_permission_granted");
            if (granted) {
              await invoke("plugin:notification|notify", { options: { title: 'Seeker Utilities: Critical Warning', body: `System limits exceeded! Memory usage is at ${memPercent.toFixed(1)}%` } });
              localStorage.setItem('last-alert-time', Date.now().toString());
            }
          } catch (err) { console.error("Notification failed:", err); }
        }
      }
    } else if (score < 80) {
      stateText = 'Moderate Load';
      stateColorClass = 'text-warning';
      dotClass = 'bg-warning';
      scoreColorClass = 'text-warning';
      strokeColor = '#f59e0b';
    }

    const scoreEl = document.getElementById('seeker-score');
    if (scoreEl) {
      scoreEl.textContent = score;
      scoreEl.className = `mb-0 fw-bold ${scoreColorClass}`;

      const circlePath = document.getElementById('score-circle-path');
      if (circlePath) {
        // Dash array is exactly 100. Offset handles the gap visually.
        circlePath.style.strokeDashoffset = 100 - score;
        circlePath.style.stroke = strokeColor;
      }
    }

    document.getElementById('sys-state-wrapper').className = `mt-3 fw-bold w-100 text-center ${stateColorClass}`;
    document.getElementById('sys-state-dot').className = `d-inline-block rounded-circle me-1 ${dotClass}`;
    document.getElementById('sys-state-text').textContent = stateText;

    // Update Chart
    const dataObj = cpuChart.data.datasets[0].data;
    dataObj.shift();
    dataObj.push(metrics.cpu_usage);
    cpuChart.update();

  } catch (error) {
    console.error("Failed to fetch system metrics:", error);
  }
}

async function loadAdvancedSysInfo() {
  try {
    const info = await invoke('get_advanced_sysinfo');
    // Render home summary
    const home = document.getElementById('adv-home-summary');
    if (home) {
      const procCount = info.process_count || 0;
      const memUsed = info.used_memory || 0;
      const memTotal = info.total_memory || 0;
      home.textContent = `Processes: ${procCount} · Memory: ${(memUsed/1024/1024).toFixed(1)}MB / ${(memTotal/1024/1024).toFixed(1)}MB`;
    }

    const disksEl = document.getElementById('adv-disks');
    if (disksEl) {
      const disks = info.disks || [];
      if (disks.length === 0) {
        disksEl.textContent = 'No disk information available.';
      } else {
        disksEl.innerHTML = disks.map(d => {
          const used = d.total_space - d.available_space;
          return `${d.name} (${d.mount_point}) — ${ (used/1024/1024).toFixed(1) } MB used of ${ (d.total_space/1024/1024).toFixed(1) } MB`;
        }).join('<br>');
      }
    }
  } catch (e) {
    console.error('Failed to load advanced sysinfo:', e);
  }
}

async function updateProcesses() {
  try {
    const processes = await invoke("get_processes");
    const tbody = document.getElementById('process-table-body');

    tbody.innerHTML = processes.map(p => `
      <tr>
        <td class="ps-4 text-muted" style="font-family: monospace;">${p.pid}</td>
        <td class="fw-medium text-dark">${p.name}</td>
        <td class="text-secondary" style="font-family: monospace;">${formatBytes(p.memory)}</td>
        <td class="text-secondary" style="font-family: monospace;">${p.cpu_usage.toFixed(1)}%</td>
      </tr>
    `).join('');
  } catch (error) {
    console.error("Failed to fetch processes:", error);
  }
}

async function loadStaticSysInfo() {
  try {
    const info = await invoke("get_static_sysinfo");
    document.getElementById('sys-cpu').textContent = info.cpu_model;
    document.getElementById('sys-cores').textContent = info.cpu_cores;
    document.getElementById('sys-os').textContent = info.os_name;
    document.getElementById('sys-kernel').textContent = info.kernel_version;
    document.getElementById('sys-host').textContent = info.hostname;
  } catch (e) {
    console.error("Failed to load generic sysinfo: ", e);
  }
}

async function loadInstalledApps() {
  try {
    const apps = await invoke("get_installed_apps");
    const tbody = document.getElementById('app-table-body');
    const emptyState = document.getElementById('empty-apps-state');
    const tableContainer = tbody.closest('.glass-card');

    if (apps.length === 0) {
      tableContainer.classList.add('d-none');
      emptyState.classList.remove('d-none');
      return;
    }

    tbody.innerHTML = apps.map(app => `
      <tr id="row-${app.id}">
        <td class="ps-4 fw-medium text-dark"><i class="${app.icon} text-muted me-2" style="width:20px; text-align:center;"></i>${app.name}</td>
        <td class="text-secondary" style="font-family: monospace;">${app.size}</td>
        <td class="text-end pe-4">
          <button class="btn btn-sm btn-outline-danger shadow-sm fw-bold uninstall-btn" data-id="${app.id}">Uninstall</button>
        </td>
      </tr>
    `).join('');

    document.querySelectorAll('.uninstall-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        // Use the button element directly (avoid e.target which may be an inner node)
        const button = e.currentTarget;
        const id = button.getAttribute('data-id');
        promptSafetyModal(`Are you absolutely sure you want to completely uninstall this? This will execute an irrevocable root <code>apt-get remove -y</code> logic block natively.`, async () => {
          button.disabled = true;
          button.innerHTML = '<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span>';

          try {
            await invoke("uninstall_app", { pkg: id }); // Using generic id because dpkg name map applies.
            setTimeout(() => {
              const row = document.getElementById(`row-${id}`);
              if (row) row.remove();
              if (document.querySelectorAll('.uninstall-btn').length === 0) {
                tableContainer.classList.add('d-none');
                emptyState.classList.remove('d-none');
              }
            }, 800);
          } catch (err) {
            console.error(err);
            button.disabled = false;
            button.innerHTML = 'Uninstall';
          }
        });
      });
    });
  } catch (error) {
    console.error("Failed to fetch installed apps:", error);
  }
}

// Loop orchestrator
function pollData() {
  if (currentTab === 'dashboard') {
    updateMetrics();
  } else if (currentTab === 'optimizer') {
    updateProcesses();
  }
}

// Modal Safety Orchestrator
let safetyModalInstance = null;
let currentSafetyCallback = null;

function promptSafetyModal(message, callback) {
  if (!safetyModalInstance) {
    // Relying on global bootstrap bundle
    safetyModalInstance = new bootstrap.Modal(document.getElementById('safetyModal'));
    document.getElementById('safety-modal-confirm').addEventListener('click', () => {
      if (currentSafetyCallback) currentSafetyCallback();
      safetyModalInstance.hide();
    });
  }
  document.getElementById('safety-modal-msg').innerHTML = message;
  currentSafetyCallback = callback;
  safetyModalInstance.show();
}

// Form & Interaction Event Listeners
window.addEventListener("DOMContentLoaded", async () => {
  initChart();
  initMemoryChart();
  initNetChart();
  initTitlebar();

  // Start polling
  pollData();
  dataPollInterval = setInterval(() => {
    // Only poll backend when the window is actually visible to save intense CPU cycles
    if (!document.hidden) {
      pollData();
    }
  }, 2500);

  // Navigation handling
  const navBtns = document.querySelectorAll('.nav-btn');
  const tabs = document.querySelectorAll('.spa-tab');

  navBtns.forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();

      // Update UI active state
      navBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      // Show correct tab
      const target = btn.getAttribute('data-target');
      currentTab = target;

      tabs.forEach(tab => {
        if (tab.id === target) {
          tab.classList.remove('d-none');
        } else {
          tab.classList.add('d-none');
        }
      });

      // Force immediate poll on switch if appropriate
      if (target === 'dashboard' || target === 'optimizer') {
        pollData();
      } else if (target === 'your-pc') {
        loadStaticSysInfo();
      } else if (target === 'uninstaller') {
        loadInstalledApps();
      }
    });
  });

  // Maintenance Logic (Cleaner Tab)
  document.getElementById('run-maintenance-btn')?.addEventListener('click', () => {
    promptSafetyModal("Are you sure you want to run a physical System Cleanup? This will natively wipe temporary memory allocations and unused filesystem caching violently under root permissions via <code>pkexec</code>.", async () => {
      const btn = document.getElementById('run-maintenance-btn');
      const alertBox = document.getElementById('maintenance-alert');
      const msg = document.getElementById('maintenance-msg');

      btn.disabled = true;
      btn.innerHTML = '<span class="spinner-border spinner-border-sm me-2" role="status" aria-hidden="true"></span>Cleaning Caches...';

      try {
        const resp = await invoke("run_maintenance");
        setTimeout(() => {
          msg.innerHTML = `<i class="fas fa-check-circle"></i> <span>${resp}</span>`;
          alertBox.className = "alert mt-4 custom-alert alert-success mx-auto";
          alertBox.classList.remove('d-none');
          btn.innerHTML = 'Clean Cache Files';
          btn.disabled = false;

          setTimeout(() => alertBox.classList.add('d-none'), 4000);
        }, 800);
      } catch (e) {
        console.error(e);
        msg.innerHTML = `<i class="fas fa-exclamation-triangle"></i> <span>${e}</span>`;
        alertBox.className = "alert mt-4 custom-alert alert-danger mx-auto";
        alertBox.classList.remove('d-none');
        btn.disabled = false;
        btn.innerHTML = 'Clean Cache Files';
      }
    });
  });

  // Booster Logic
  document.getElementById('run-boost-btn')?.addEventListener('click', () => {
    promptSafetyModal(`Ready to Boost?<br><br>This action executes <code>sync; echo 3 > /proc/sys/vm/drop_caches</code> securely under pkexec, ripping out un-allocated OS caches dynamically.`, async () => {
      const btn = document.getElementById('run-boost-btn');
      const alertBox = document.getElementById('boost-alert');
      const msg = document.getElementById('boost-msg');

      btn.disabled = true;
      btn.innerHTML = '<span class="spinner-border spinner-border-sm me-2" role="status" aria-hidden="true"></span>Optimizing Workload...';

      try {
        const resp = await invoke("run_booster");
        setTimeout(() => {
          msg.innerHTML = `<i class="fas fa-bolt"></i> <span>${resp}</span>`;
          alertBox.className = "alert alert-success mt-4 custom-alert mx-auto";
          btn.innerHTML = 'Boost Performance';
          btn.disabled = false;
          alertBox.classList.remove('d-none');
          setTimeout(() => alertBox.classList.add('d-none'), 4000);
        }, 1000);
      } catch (e) {
        msg.innerHTML = `<i class="fas fa-exclamation-circle"></i> <span>${e}</span>`;
        alertBox.className = "alert alert-danger mt-4 custom-alert mx-auto";
        alertBox.classList.remove('d-none');
        btn.disabled = false;
        btn.innerHTML = 'Boost Performance';
      }
    });
  });

  // Configurator / LocalStorage Setup natively bound
  const startupEl = document.getElementById('setting-startup');
  if (startupEl) {
    try {
      startupEl.checked = await invoke('plugin:autostart|is_enabled');
    } catch (e) { }

    startupEl.addEventListener('change', async (e) => {
      try {
        if (e.target.checked) {
          await invoke('plugin:autostart|enable');
        } else {
          await invoke('plugin:autostart|disable');
        }
      } catch (err) {
        console.error("Autostart error:", err);
      }
    });
  }

  const alertEl = document.getElementById('setting-alerts');
  if (alertEl) {
    alertEl.checked = localStorage.getItem('setting-alerts') !== 'false';
    alertEl.addEventListener('change', async (e) => {
      if (e.target.checked) {
        try {
          let granted = await invoke("plugin:notification|is_permission_granted");
          if (!granted) {
            granted = (await invoke("plugin:notification|request_permission")) === 'granted';
          }
          if (!granted) {
            e.target.checked = false;
            return;
          }
        } catch (err) { console.error(err); }
      }
      localStorage.setItem('setting-alerts', e.target.checked.toString());
    });
  }

  const dmEl = document.getElementById('setting-darkmode');
  if (dmEl) {
    const isDark = localStorage.getItem('setting-darkmode') === 'true';
    dmEl.checked = isDark;
    if (isDark) {
      document.body.classList.add('dark-mode');
      document.documentElement.setAttribute('data-bs-theme', 'dark');
    }

    dmEl.addEventListener('change', (e) => {
      localStorage.setItem('setting-darkmode', e.target.checked);
      if (e.target.checked) {
        document.body.classList.add('dark-mode');
        document.documentElement.setAttribute('data-bs-theme', 'dark');
      } else {
        document.body.classList.remove('dark-mode');
        document.documentElement.removeAttribute('data-bs-theme');
      }
    });
  }

  const animEl = document.getElementById('setting-animations');
  if (animEl) {
    const noAnim = localStorage.getItem('setting-animations') === 'true';
    animEl.checked = noAnim;
    if (noAnim) document.body.classList.add('no-animations');

    animEl.addEventListener('change', (e) => {
      localStorage.setItem('setting-animations', e.target.checked);
      if (e.target.checked) document.body.classList.add('no-animations');
      else document.body.classList.remove('no-animations');
    });
  }

  const teleEl = document.getElementById('setting-telemetry');
  if (teleEl) {
    const isEnabled = localStorage.getItem('setting-telemetry') === 'true';
    teleEl.checked = isEnabled;
    teleEl.addEventListener('change', async (e) => {
      localStorage.setItem('setting-telemetry', e.target.checked.toString());
      try {
        await invoke("send_telemetry", { enabled: e.target.checked });
      } catch (err) { console.error("Telemetry toggle error:", err); }
    });
  }

  // Advanced Mode toggle (power-user features)
  const advEl = document.getElementById('setting-advanced');
  const applyAdvancedMode = (enabled) => {
    document.querySelectorAll('.advanced-only').forEach(el => {
      if (enabled) el.classList.remove('d-none');
      else el.classList.add('d-none');
    });
  };

  if (advEl) {
    const isAdv = localStorage.getItem('setting-advanced') === 'true';
    advEl.checked = isAdv;
    applyAdvancedMode(isAdv);
    advEl.addEventListener('change', (e) => {
      const on = e.target.checked;
      localStorage.setItem('setting-advanced', on.toString());
      applyAdvancedMode(on);
      if (on) loadAdvancedSysInfo();
    });
    if (isAdv) loadAdvancedSysInfo();
  }

  // Open Website
  document.getElementById('open-website-btn')?.addEventListener('click', async () => {
    try {
      await invoke("plugin:opener|open_url", { url: "https://utilities.arcbase.one" });
    } catch (e) {
      console.error("Native opener failed, attempting window fallback:", e);
      window.open("https://utilities.arcbase.one", "_blank");
    }
  });

  // OS Updater Trigger
  document.getElementById('run-os-update-btn')?.addEventListener('click', () => {
    promptSafetyModal(`This incredibly aggressive background task natively invokes your OS package manager to fetch missing core distribution headers natively. Depending on your configuration, PolKit authentication may freeze over your application briefly to verify encryption keys.<br><br><strong>Are you absolutely sure you want to securely embed this terminal streaming payload?</strong>`, async () => {
      const btn = document.getElementById('run-os-update-btn');
      const container = document.getElementById('os-terminal-container');
      const consoleNode = document.getElementById('os-updater-console');
      const loader = document.getElementById('os-terminal-loader');

      btn.disabled = true;
      btn.innerHTML = '<span class="spinner-border spinner-border-sm me-2" role="status" aria-hidden="true"></span>Authenticating Target...';

      container.classList.remove('d-none');
      consoleNode.innerHTML = 'Connecting to securely elevated native hook bindings...\n<br>';
      loader.classList.remove('d-none');

      try {
        const resp = await invoke("run_system_update");
        console.log("OS Upgrade Native Bridge Passed Payload: ", resp);
      } catch (e) {
        console.error("OS Update Hook Rejected: ", e);
      } finally {
        setTimeout(() => {
          btn.disabled = false;
          btn.innerHTML = '<i class="fas fa-hammer me-2"></i>Upgrade OS';
          loader.classList.add('d-none');
        }, 1200);
      }
    });
  });

  // Clear OS Console
  document.getElementById('clear-os-console-btn')?.addEventListener('click', () => {
    const consoleNode = document.getElementById('os-updater-console');
    if (consoleNode) consoleNode.innerHTML = '<span class="text-muted">Terminal output cleared.</span>\n<br>';
  });

  // Map Global Async Terminal Events
  if (window.__TAURI__ && window.__TAURI__.event) {
    listen('os-update-log', (event) => {
      const consoleNode = document.getElementById('os-updater-console');
      if (consoleNode) {
        const span = document.createElement('span');
        span.style.display = 'block';
        span.innerText = event.payload;
        consoleNode.appendChild(span);
        consoleNode.scrollTop = consoleNode.scrollHeight;
      }
    });
    // Advanced command streaming
    listen('advanced-log', (event) => {
      const out = document.getElementById('adv-output');
      if (out) {
        const span = document.createElement('div');
        span.innerText = event.payload;
        out.appendChild(span);
        out.scrollTop = out.scrollHeight;
      }
    });
  }

  // Update Checker
  document.getElementById('run-updater-btn')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    const alertBox = document.getElementById('update-alert');
    const title = document.getElementById('update-title');
    const msg = document.getElementById('update-msg');

    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm me-2" role="status" aria-hidden="true"></span>Checking servers...';
    alertBox.classList.add('d-none');

    try {
      const resp = await invoke("check_for_updates");
      title.innerHTML = `<i class="fas ${resp.status === 'upgrade' ? 'fa-arrow-up-from-bracket' : 'fa-circle-check'}"></i> ${resp.title}`;
      msg.innerHTML = resp.message;
      alertBox.className = `alert mt-3 custom-alert mx-auto text-start alert-${resp.status === 'upgrade' ? 'primary' : 'success'}`;
    } catch (err) {
      title.innerHTML = `<i class="fas fa-triangle-exclamation"></i> Update Failed`;
      msg.textContent = err;
      alertBox.className = 'alert mt-3 custom-alert mx-auto text-start alert-danger';
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-cloud-arrow-down me-2"></i>Check for Updates';
    }
  });

  // Initial Telemetry Ping on Load
  const teleOnLoad = localStorage.getItem('setting-telemetry') === 'true';
  if (teleOnLoad) {
    invoke("send_telemetry", { enabled: true }).catch(err => console.error("Boot telemetry failed:", err));
  }

  // Wire enterprise header links and version display
  try {
    const versionEl = document.getElementById('app-version');
    if (versionEl && window.__TAURI__?.app) {
      // Attempt to read the package version from the Tauri context (fallback to package.json value)
      try {
        const info = await window.__TAURI__.app.getTauriVersion();
        // app.getTauriVersion returns a version map; keep existing display if not present
      } catch (e) {
        // no-op fallback
    }
  }

  // Net direction switch
  const netSwitch = document.getElementById('net-direction-switch');
  if (netSwitch) {
    const netLabel = document.getElementById('net-direction-label');
    // initialize label state
    if (netLabel) netLabel.textContent = netSwitch.checked ? 'Out' : 'In';
    netSwitch.addEventListener('change', (e) => {
      netView = e.target.checked ? 'out' : 'in';
      if (netLabel) netLabel.textContent = netView === 'in' ? 'In' : 'Out';
      // update chart color immediately
      if (netChart) {
        netChart.data.datasets[0].borderColor = netView === 'in' ? '#10b981' : '#6366f1';
        netChart.update();
      }
    });
  }
  } catch (e) { /* silence harmless errors while trying to enhance header */ }

  document.getElementById('support-link')?.addEventListener('click', (evt) => {
    evt.preventDefault();
    // Open the support page (uses opener plugin and falls back to window.open)
    invoke("plugin:opener|open_url", { url: "https://utilities.arcbase.one/support" }).catch(() => window.open("https://utilities.arcbase.one/support", "_blank"));
  });

  // Advanced tools UI wiring
  const advRunBtn = document.getElementById('adv-run-btn');
  if (advRunBtn) {
    advRunBtn.addEventListener('click', async () => {
      const cmd = document.getElementById('adv-cmd-input').value.trim();
      const useRoot = document.getElementById('adv-use-root').checked;
      const out = document.getElementById('adv-output');
      if (!cmd) return;
      if (out) out.textContent = `Running: ${cmd}\n`;
      try {
        await invoke('run_advanced_cmd', { cmd, use_root: useRoot });
      } catch (e) {
        if (out) out.textContent += 'Error: ' + e + '\n';
      }
    });
  }

  const sysGet = document.getElementById('sysctl-get');
  const sysSet = document.getElementById('sysctl-set');
  if (sysGet) {
    sysGet.addEventListener('click', async () => {
      const key = document.getElementById('sysctl-key').value.trim();
      const out = document.getElementById('adv-output');
      if (!key) return;
      try {
        const val = await invoke('get_sysctl', { key });
        if (out) out.textContent += `${key} = ${val}\n`;
      } catch (e) {
        if (out) out.textContent += `Error getting ${key}: ${e}\n`;
      }
    });
  }
  if (sysSet) {
    sysSet.addEventListener('click', async () => {
      const key = document.getElementById('sysctl-key').value.trim();
      const value = document.getElementById('sysctl-value').value.trim();
      const out = document.getElementById('adv-output');
      if (!key || !value) return;
      try {
        const resp = await invoke('set_sysctl', { key, value });
        if (out) out.textContent += `Set ${key} -> ${resp}\n`;
      } catch (e) {
        if (out) out.textContent += `Error setting ${key}: ${e}\n`;
      }
    });
  }
});

let memChart;

function initMemoryChart() {
  const ctx = document.getElementById('memChart').getContext('2d');

  // Green gradient fill
  const gradient = ctx.createLinearGradient(0, 0, 0, 300);
  gradient.addColorStop(0, 'rgba(16, 185, 129, 0.25)');
  gradient.addColorStop(1, 'rgba(16, 185, 129, 0)');

  // Initialize chart
  memChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: Array(20).fill(''),
      datasets: [{
        label: 'Memory Usage (%)',
        data: Array(20).fill(0),
        borderColor: '#10b981',
        backgroundColor: gradient,
        borderWidth: 2,
        tension: 0.2,
        fill: true,
        pointRadius: 0,
        pointHoverRadius: 4
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 0 },
      scales: {
        y: {
          min: 0,
          max: 100,
          grid: { color: 'rgba(0,0,0,0.05)', borderDash: [5, 5] },
          ticks: { color: '#64748b' }
        },
        x: {
          grid: { display: false },
          ticks: { display: false }
        }
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => ctx.parsed.y.toFixed(1) + '%'
          }
        }
      }
    }
  });
}

function initNetChart() {
  const ctx = document.getElementById('netChart').getContext('2d');
  const gradientIn = ctx.createLinearGradient(0, 0, 0, 120);
  gradientIn.addColorStop(0, 'rgba(16,185,129,0.25)');
  gradientIn.addColorStop(1, 'rgba(16,185,129,0)');

  const gradientOut = ctx.createLinearGradient(0, 0, 0, 120);
  gradientOut.addColorStop(0, 'rgba(99,102,241,0.25)');
  gradientOut.addColorStop(1, 'rgba(99,102,241,0)');

  netChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: Array(20).fill(''),
      datasets: [{
        label: 'Net (B/s)',
        data: Array(20).fill(0),
        borderColor: netView === 'in' ? '#10b981' : '#6366f1',
        backgroundColor: netView === 'in' ? gradientIn : gradientOut,
        borderWidth: 2,
        tension: 0.3,
        fill: true,
        pointRadius: 0
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 0 },
      scales: { y: { min: 0, ticks: { color: '#64748b' } }, x: { display: false } },
      plugins: { legend: { display: false } }
    }
  });
}

function initTitlebar() {
  if (window.__TAURI__?.window) {
    try {
      const { getCurrentWindow } = window.__TAURI__.window;
      const appWindow = getCurrentWindow();

      document.getElementById('titlebar-minimize')?.addEventListener('click', () => appWindow.minimize());
      document.getElementById('titlebar-maximize')?.addEventListener('click', () => appWindow.toggleMaximize());
      document.getElementById('titlebar-close')?.addEventListener('click', () => appWindow.close());
      console.log("Seeker Utilities: Custom Titlebar initialized.");
    } catch (err) {
      console.error("Tauri: Window Controls Hook failed", err);
    }
  } else {
    // Hide controls if not in Tauri
    const controls = document.querySelector('.titlebar-controls');
    if (controls) controls.style.display = 'none';
  }
}

// Call this function whenever you fetch new memory data
function updateMemoryChart(usedMemory, totalMemory) {
  if (!memChart) return;

  const percent = (usedMemory / totalMemory) * 100;
  const dataset = memChart.data.datasets[0].data;

  dataset.shift();        // remove oldest value
  dataset.push(percent);  // add newest value
  memChart.update();

  // Update DOM
  document.getElementById('mem-stat').textContent = `${(usedMemory / (1024 ** 3)).toFixed(1)} / ${(totalMemory / (1024 ** 3)).toFixed(1)} GB`;
  document.getElementById('mem-bar').style.width = percent + '%';
}

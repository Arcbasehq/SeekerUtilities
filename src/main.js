const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

// State
let currentTab = 'dashboard';
let cpuChart;
let dataPollInterval;
let netChart;
let netGradientIn;
let netGradientOut;
let prevNetRx = null;
let prevNetTx = null;
let prevNetTs = null;
let netView = 'in';

const htmlEscapeMap = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
};

const PASSWORD_SETS = {
  lower: 'abcdefghijklmnopqrstuvwxyz',
  upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  digits: '0123456789',
  symbols: '!@#$%^&*()-_=+[]{};:,.?/|~'
};

const PASSPHRASE_WORDS = [
  'anchor', 'apex', 'atlas', 'amber', 'aster', 'breeze', 'brick', 'canyon',
  'carbon', 'cedar', 'cipher', 'clover', 'comet', 'copper', 'cosmos', 'crisp',
  'dawn', 'delta', 'ember', 'fable', 'falcon', 'feather', 'forest', 'forge',
  'frost', 'galaxy', 'glade', 'glimmer', 'glow', 'harbor', 'horizon', 'iceberg',
  'island', 'ivory', 'jupiter', 'karma', 'keeper', 'lattice', 'legend', 'lilac',
  'lumen', 'marble', 'meadow', 'midnight', 'monsoon', 'nebula', 'nova',
  'obsidian', 'oasis', 'onyx', 'orbit', 'paper', 'pebble', 'phoenix', 'pillow',
  'pixel', 'polar', 'prism', 'quartz', 'raven', 'river', 'rocket', 'sable',
  'saffron', 'sage', 'sailor', 'saturn', 'shadow', 'signal', 'silver',
  'skylight', 'solstice', 'sparrow', 'stellar', 'stone', 'summit', 'sunset',
  'tangent', 'terra', 'thunder', 'torch', 'tundra', 'velvet', 'vertex',
  'violet', 'whisper', 'wild', 'winter', 'zenith', 'zero', 'alpha', 'bravo',
  'charlie', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo',
  'lima', 'mango', 'nectar', 'olive', 'panda', 'quill', 'ripple', 'sierra',
  'tango', 'ultra', 'victor', 'whisky', 'xray', 'yonder', 'zebra'
];

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => htmlEscapeMap[char]);
}

function sanitizeClassList(value) {
  return String(value || '').replace(/[^a-zA-Z0-9\s_-]/g, '').trim();
}

function toSafeDomId(prefix, value) {
  return `${prefix}${String(value).replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

function setButtonText(button, text) {
  if (!button) return;
  button.replaceChildren();
  button.appendChild(document.createTextNode(text));
}

function setButtonLoading(button, text) {
  if (!button) return;
  button.replaceChildren();
  const spinner = document.createElement('span');
  spinner.className = 'spinner-border spinner-border-sm';
  spinner.setAttribute('role', 'status');
  spinner.setAttribute('aria-hidden', 'true');
  if (text) spinner.classList.add('me-2');
  button.appendChild(spinner);
  if (text) button.appendChild(document.createTextNode(text));
}

function setButtonIcon(button, iconClass, text) {
  if (!button) return;
  button.replaceChildren();
  const icon = document.createElement('i');
  icon.className = iconClass;
  button.appendChild(icon);
  if (text) button.appendChild(document.createTextNode(text));
}

let securityAlertTimer = null;

function showSecurityAlert(type, title, message) {
  const alertEl = document.getElementById('security-alert');
  if (!alertEl) return;
  const titleEl = document.getElementById('security-alert-title');
  const msgEl = document.getElementById('security-alert-msg');
  const tone = type === 'error' ? 'alert-danger' : type === 'success' ? 'alert-success' : 'alert-primary';

  titleEl.textContent = title;
  msgEl.textContent = message;
  alertEl.className = `alert custom-alert d-flex align-items-center ${tone}`;
  alertEl.classList.remove('d-none');

  if (securityAlertTimer) clearTimeout(securityAlertTimer);
  securityAlertTimer = setTimeout(() => {
    alertEl.classList.add('d-none');
  }, 4500);
}

function setStatusBadge(el, status, labels) {
  if (!el) return;
  const normalized = status || 'unknown';
  const map = {
    enabled: { label: labels?.enabled || 'Enabled', className: 'bg-success' },
    disabled: { label: labels?.disabled || 'Disabled', className: 'bg-warning' },
    unknown: { label: labels?.unknown || 'Unknown', className: 'bg-secondary' }
  };
  const config = map[normalized] || map.unknown;
  el.className = `badge ${config.className}`;
  el.textContent = config.label;
}

function firstLine(text) {
  return String(text || '').split('\n')[0].trim() || 'No details available.';
}

function getCrypto() {
  return window.crypto || window.msCrypto;
}

function bytesToBase64(bytes) {
  let binary = '';
  bytes.forEach((b) => {
    binary += String.fromCharCode(b);
  });
  return btoa(binary);
}

function base64ToBytes(str) {
  const binary = atob(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function bufferToHex(buffer) {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function getRandomInt(max) {
  const cryptoApi = getCrypto();
  if (!cryptoApi) throw new Error('Crypto unavailable');
  const array = new Uint32Array(1);
  const limit = Math.floor(0xffffffff / max) * max;
  let value = 0;
  do {
    cryptoApi.getRandomValues(array);
    value = array[0];
  } while (value >= limit);
  return value % max;
}

function shuffleArray(items) {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = getRandomInt(i + 1);
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

async function copyToClipboard(text) {
  if (!text) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (err) {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const success = document.execCommand('copy');
    document.body.removeChild(textarea);
    return success;
  }
}

async function loadSecurityStatus() {
  const fwBadge = document.getElementById('fw-status-badge');
  const fwEngine = document.getElementById('fw-engine');
  const fwMsg = document.getElementById('fw-status-msg');
  const sshBadge = document.getElementById('ssh-status-badge');
  const sshName = document.getElementById('ssh-service-name');
  const sshMsg = document.getElementById('ssh-status-msg');

  setStatusBadge(fwBadge, 'unknown');
  setStatusBadge(sshBadge, 'unknown', { enabled: 'Active', disabled: 'Inactive' });
  if (fwMsg) fwMsg.textContent = 'Checking...';
  if (sshMsg) sshMsg.textContent = 'Checking...';

  const [fwResult, sshResult] = await Promise.allSettled([
    invoke('get_firewall_status'),
    invoke('get_ssh_status')
  ]);

  if (fwResult.status === 'fulfilled') {
    const fw = fwResult.value;
    if (fwEngine) fwEngine.textContent = `Engine: ${fw.engine === 'none' ? 'Not detected' : fw.engine.toUpperCase()}`;
    setStatusBadge(fwBadge, fw.status, { enabled: 'Enabled', disabled: 'Disabled' });
    if (fwMsg) fwMsg.textContent = firstLine(fw.message);
  } else {
    if (fwMsg) fwMsg.textContent = 'Failed to read firewall status.';
    setStatusBadge(fwBadge, 'unknown');
  }

  if (sshResult.status === 'fulfilled') {
    const ssh = sshResult.value;
    if (sshName) sshName.textContent = `Service: ${ssh.service}.service`;
    setStatusBadge(sshBadge, ssh.status, { enabled: 'Active', disabled: 'Inactive' });
    if (sshMsg) sshMsg.textContent = firstLine(ssh.message);
  } else {
    if (sshMsg) sshMsg.textContent = 'Failed to read SSH status.';
    setStatusBadge(sshBadge, 'unknown', { enabled: 'Active', disabled: 'Inactive' });
  }
}

async function runPortScan() {
  const output = document.getElementById('ports-output');
  if (!output) return;
  output.textContent = 'Scanning open ports...';
  try {
    const data = await invoke('get_open_ports');
    output.textContent = data || 'No open ports detected.';
  } catch (err) {
    output.textContent = `Scan failed: ${err}`;
  }
}

function buildPasswordOptions() {
  const lower = document.getElementById('pwd-lower')?.checked;
  const upper = document.getElementById('pwd-upper')?.checked;
  const digits = document.getElementById('pwd-digits')?.checked;
  const symbols = document.getElementById('pwd-symbols')?.checked;
  return { lower, upper, digits, symbols };
}

function generatePassword(length, options) {
  const selections = [];
  let pool = '';
  if (options.lower) {
    pool += PASSWORD_SETS.lower;
    selections.push(PASSWORD_SETS.lower);
  }
  if (options.upper) {
    pool += PASSWORD_SETS.upper;
    selections.push(PASSWORD_SETS.upper);
  }
  if (options.digits) {
    pool += PASSWORD_SETS.digits;
    selections.push(PASSWORD_SETS.digits);
  }
  if (options.symbols) {
    pool += PASSWORD_SETS.symbols;
    selections.push(PASSWORD_SETS.symbols);
  }

  if (!pool) {
    throw new Error('Select at least one character set.');
  }

  const passwordChars = selections.map((set) => set[getRandomInt(set.length)]);
  while (passwordChars.length < length) {
    passwordChars.push(pool[getRandomInt(pool.length)]);
  }
  return shuffleArray(passwordChars).join('');
}

function generatePassphrase(count) {
  const words = [];
  for (let i = 0; i < count; i += 1) {
    words.push(PASSPHRASE_WORDS[getRandomInt(PASSPHRASE_WORDS.length)]);
  }
  return words.join('-');
}

async function hashText(text, algo) {
  const cryptoApi = getCrypto();
  if (!cryptoApi?.subtle) throw new Error('Web Crypto unavailable');
  const data = new TextEncoder().encode(text);
  const hashBuffer = await cryptoApi.subtle.digest(algo, data);
  return bufferToHex(hashBuffer);
}

async function deriveKey(passphrase, salt) {
  const cryptoApi = getCrypto();
  if (!cryptoApi?.subtle) throw new Error('Web Crypto unavailable');
  const keyMaterial = await cryptoApi.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );
  return cryptoApi.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 120000, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function encryptText(plaintext, passphrase) {
  const cryptoApi = getCrypto();
  if (!cryptoApi?.subtle) throw new Error('Web Crypto unavailable');
  const salt = new Uint8Array(16);
  const iv = new Uint8Array(12);
  cryptoApi.getRandomValues(salt);
  cryptoApi.getRandomValues(iv);
  const key = await deriveKey(passphrase, salt);
  const cipherBuffer = await cryptoApi.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(plaintext)
  );
  return `v1:${bytesToBase64(salt)}:${bytesToBase64(iv)}:${bytesToBase64(new Uint8Array(cipherBuffer))}`;
}

async function decryptText(ciphertext, passphrase) {
  const cryptoApi = getCrypto();
  if (!cryptoApi?.subtle) throw new Error('Web Crypto unavailable');
  const parts = ciphertext.split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new Error('Ciphertext format is invalid.');
  }
  const salt = base64ToBytes(parts[1]);
  const iv = base64ToBytes(parts[2]);
  const data = base64ToBytes(parts[3]);
  const key = await deriveKey(passphrase, salt);
  const plainBuffer = await cryptoApi.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    data
  );
  return new TextDecoder().decode(plainBuffer);
}

function redactText(text) {
  let result = text;
  result = result.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted-email]');
  result = result.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[redacted-ip]');
  result = result.replace(/\+?\d[\d\s\-().]{7,}\d/g, '[redacted-phone]');
  return result;
}

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
        netChart.data.datasets[0].backgroundColor = netGradientIn;
      } else {
        netChart.data.datasets[0].borderColor = '#6366f1';
        netChart.data.datasets[0].backgroundColor = netGradientOut;
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
        disksEl.replaceChildren();
        disks.forEach((d) => {
          const used = d.total_space - d.available_space;
          const line = document.createElement('div');
          line.textContent = `${d.name} (${d.mount_point}) - ${(used / 1024 / 1024).toFixed(1)} MB used of ${(d.total_space / 1024 / 1024).toFixed(1)} MB`;
          disksEl.appendChild(line);
        });
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

    tbody.replaceChildren();
    processes.forEach((p) => {
      const row = document.createElement('tr');

      const pidCell = document.createElement('td');
      pidCell.className = 'ps-4 text-muted';
      pidCell.style.fontFamily = 'monospace';
      pidCell.textContent = p.pid;

      const nameCell = document.createElement('td');
      nameCell.className = 'fw-medium text-dark';
      nameCell.textContent = p.name;

      const memCell = document.createElement('td');
      memCell.className = 'text-secondary';
      memCell.style.fontFamily = 'monospace';
      memCell.textContent = formatBytes(p.memory);

      const cpuCell = document.createElement('td');
      cpuCell.className = 'text-secondary';
      cpuCell.style.fontFamily = 'monospace';
      cpuCell.textContent = `${p.cpu_usage.toFixed(1)}%`;

      row.append(pidCell, nameCell, memCell, cpuCell);
      tbody.appendChild(row);
    });
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

    tbody.replaceChildren();
    apps.forEach((app) => {
      const safeRowId = toSafeDomId('row-', app.id);
      const safeIcon = sanitizeClassList(app.icon || 'fa-solid fa-box');

      const row = document.createElement('tr');
      row.id = safeRowId;

      const nameCell = document.createElement('td');
      nameCell.className = 'ps-4 fw-medium text-dark';

      const icon = document.createElement('i');
      icon.className = `${safeIcon} text-muted me-2`;
      icon.style.width = '20px';
      icon.style.textAlign = 'center';
      nameCell.appendChild(icon);
      nameCell.appendChild(document.createTextNode(app.name));

      const sizeCell = document.createElement('td');
      sizeCell.className = 'text-secondary';
      sizeCell.style.fontFamily = 'monospace';
      sizeCell.textContent = app.size;

      const actionCell = document.createElement('td');
      actionCell.className = 'text-end pe-4';

      const button = document.createElement('button');
      button.className = 'btn btn-sm btn-outline-danger shadow-sm fw-bold uninstall-btn';
      button.setAttribute('data-id', app.id);
      button.textContent = 'Uninstall';

      button.addEventListener('click', (e) => {
        const currentButton = e.currentTarget;
        const id = currentButton.getAttribute('data-id');
        promptSafetyModal(
          'Are you absolutely sure you want to completely uninstall this? This will execute an irrevocable root apt-get remove -y logic block natively.',
          async () => {
            currentButton.disabled = true;
            setButtonLoading(currentButton, '');
            try {
              await invoke("uninstall_app", { id });
              setTimeout(() => {
                const rowEl = document.getElementById(toSafeDomId('row-', id));
                if (rowEl) rowEl.remove();
                if (document.querySelectorAll('.uninstall-btn').length === 0) {
                  tableContainer.classList.add('d-none');
                  emptyState.classList.remove('d-none');
                }
              }, 800);
            } catch (err) {
              console.error(err);
              currentButton.disabled = false;
              setButtonText(currentButton, 'Uninstall');
            }
          }
        );
      });

      actionCell.appendChild(button);
      row.append(nameCell, sizeCell, actionCell);
      tbody.appendChild(row);
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
  document.getElementById('safety-modal-msg').textContent = message;
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
      } else if (target === 'security') {
        loadSecurityStatus();
      }
    });
  });

  // Security tab actions
  document.getElementById('security-refresh-btn')?.addEventListener('click', () => {
    loadSecurityStatus();
    showSecurityAlert('info', 'Quick Audit', 'Refreshing firewall and SSH status...');
  });

  document.getElementById('fw-refresh-btn')?.addEventListener('click', () => {
    loadSecurityStatus();
  });

  document.getElementById('fw-enable-btn')?.addEventListener('click', () => {
    promptSafetyModal('Enable firewall protection? This requires elevated privileges.', async () => {
      try {
        const resp = await invoke('set_firewall_enabled', { enable: true });
        showSecurityAlert('success', 'Firewall Updated', resp);
        loadSecurityStatus();
      } catch (err) {
        showSecurityAlert('error', 'Firewall Failed', String(err));
      }
    });
  });

  document.getElementById('fw-disable-btn')?.addEventListener('click', () => {
    promptSafetyModal('Disable firewall protection? This reduces network security.', async () => {
      try {
        const resp = await invoke('set_firewall_enabled', { enable: false });
        showSecurityAlert('success', 'Firewall Updated', resp);
        loadSecurityStatus();
      } catch (err) {
        showSecurityAlert('error', 'Firewall Failed', String(err));
      }
    });
  });

  document.getElementById('ssh-refresh-btn')?.addEventListener('click', () => {
    loadSecurityStatus();
  });

  document.getElementById('ssh-enable-btn')?.addEventListener('click', () => {
    promptSafetyModal('Start the SSH service? This enables remote login access.', async () => {
      try {
        const resp = await invoke('set_ssh_enabled', { enable: true });
        showSecurityAlert('success', 'SSH Updated', resp);
        loadSecurityStatus();
      } catch (err) {
        showSecurityAlert('error', 'SSH Failed', String(err));
      }
    });
  });

  document.getElementById('ssh-disable-btn')?.addEventListener('click', () => {
    promptSafetyModal('Stop the SSH service? Remote login will be unavailable.', async () => {
      try {
        const resp = await invoke('set_ssh_enabled', { enable: false });
        showSecurityAlert('success', 'SSH Updated', resp);
        loadSecurityStatus();
      } catch (err) {
        showSecurityAlert('error', 'SSH Failed', String(err));
      }
    });
  });

  document.getElementById('ports-scan-btn')?.addEventListener('click', () => {
    runPortScan();
  });

  document.getElementById('dns-flush-btn')?.addEventListener('click', () => {
    promptSafetyModal('Flush DNS cache? This requires elevated privileges.', async () => {
      try {
        const resp = await invoke('flush_dns_cache');
        showSecurityAlert('success', 'DNS Cache Flushed', resp);
      } catch (err) {
        showSecurityAlert('error', 'DNS Flush Failed', String(err));
      }
    });
  });

  document.getElementById('recent-clear-btn')?.addEventListener('click', async () => {
    try {
      const resp = await invoke('clear_recent_files');
      showSecurityAlert('success', 'Recent Files Cleared', resp);
    } catch (err) {
      showSecurityAlert('error', 'Cleanup Failed', String(err));
    }
  });

  document.getElementById('thumbs-clear-btn')?.addEventListener('click', async () => {
    try {
      const resp = await invoke('clear_thumbnail_cache');
      showSecurityAlert('success', 'Thumbnails Cleared', resp);
    } catch (err) {
      showSecurityAlert('error', 'Cleanup Failed', String(err));
    }
  });

  document.getElementById('history-clear-btn')?.addEventListener('click', async () => {
    try {
      const resp = await invoke('clear_shell_history');
      showSecurityAlert('success', 'Shell History Cleared', resp);
    } catch (err) {
      showSecurityAlert('error', 'Cleanup Failed', String(err));
    }
  });

  const pwdLength = document.getElementById('pwd-length');
  if (pwdLength) {
    const label = document.getElementById('pwd-length-label');
    label.textContent = pwdLength.value;
    pwdLength.addEventListener('input', (e) => {
      label.textContent = e.target.value;
    });
  }

  document.getElementById('pwd-generate')?.addEventListener('click', () => {
    const output = document.getElementById('pwd-output');
    const length = parseInt(document.getElementById('pwd-length').value, 10);
    try {
      const password = generatePassword(length, buildPasswordOptions());
      output.value = password;
      showSecurityAlert('success', 'Password Generated', 'Strong password ready to copy.');
    } catch (err) {
      showSecurityAlert('error', 'Password Error', String(err));
    }
  });

  document.getElementById('pwd-copy')?.addEventListener('click', async () => {
    const output = document.getElementById('pwd-output');
    const ok = await copyToClipboard(output.value);
    showSecurityAlert(ok ? 'success' : 'error', 'Copy Password', ok ? 'Password copied to clipboard.' : 'Failed to copy password.');
  });

  const phraseCount = document.getElementById('phrase-count');
  if (phraseCount) {
    const label = document.getElementById('phrase-count-label');
    label.textContent = phraseCount.value;
    phraseCount.addEventListener('input', (e) => {
      label.textContent = e.target.value;
    });
  }

  document.getElementById('phrase-generate')?.addEventListener('click', () => {
    const output = document.getElementById('phrase-output');
    const count = parseInt(document.getElementById('phrase-count').value, 10);
    try {
      output.value = generatePassphrase(count);
      showSecurityAlert('success', 'Passphrase Generated', 'Memorable passphrase ready.');
    } catch (err) {
      showSecurityAlert('error', 'Passphrase Error', String(err));
    }
  });

  document.getElementById('phrase-copy')?.addEventListener('click', async () => {
    const output = document.getElementById('phrase-output');
    const ok = await copyToClipboard(output.value);
    showSecurityAlert(ok ? 'success' : 'error', 'Copy Passphrase', ok ? 'Passphrase copied to clipboard.' : 'Failed to copy passphrase.');
  });

  document.getElementById('hash-run')?.addEventListener('click', async () => {
    const input = document.getElementById('hash-input').value;
    const algo = document.getElementById('hash-algo').value;
    const output = document.getElementById('hash-output');
    if (!input.trim()) {
      showSecurityAlert('error', 'Hash Error', 'Enter text to hash.');
      return;
    }
    try {
      output.value = await hashText(input, algo);
      showSecurityAlert('success', 'Hash Ready', `${algo} generated.`);
    } catch (err) {
      showSecurityAlert('error', 'Hash Failed', String(err));
    }
  });

  document.getElementById('hash-copy')?.addEventListener('click', async () => {
    const output = document.getElementById('hash-output');
    const ok = await copyToClipboard(output.value);
    showSecurityAlert(ok ? 'success' : 'error', 'Copy Hash', ok ? 'Hash copied to clipboard.' : 'Failed to copy hash.');
  });

  document.getElementById('crypto-encrypt')?.addEventListener('click', async () => {
    const passphrase = document.getElementById('crypto-passphrase').value;
    const plain = document.getElementById('crypto-plain').value;
    const cipher = document.getElementById('crypto-cipher');
    if (!passphrase || !plain) {
      showSecurityAlert('error', 'Encrypt Error', 'Passphrase and plaintext are required.');
      return;
    }
    try {
      cipher.value = await encryptText(plain, passphrase);
      showSecurityAlert('success', 'Encrypted', 'Ciphertext generated.');
    } catch (err) {
      showSecurityAlert('error', 'Encrypt Failed', String(err));
    }
  });

  document.getElementById('crypto-decrypt')?.addEventListener('click', async () => {
    const passphrase = document.getElementById('crypto-passphrase').value;
    const plain = document.getElementById('crypto-plain');
    const cipher = document.getElementById('crypto-cipher').value;
    if (!passphrase || !cipher) {
      showSecurityAlert('error', 'Decrypt Error', 'Passphrase and ciphertext are required.');
      return;
    }
    try {
      plain.value = await decryptText(cipher, passphrase);
      showSecurityAlert('success', 'Decrypted', 'Plaintext restored.');
    } catch (err) {
      showSecurityAlert('error', 'Decrypt Failed', String(err));
    }
  });

  document.getElementById('crypto-copy')?.addEventListener('click', async () => {
    const cipher = document.getElementById('crypto-cipher');
    const ok = await copyToClipboard(cipher.value);
    showSecurityAlert(ok ? 'success' : 'error', 'Copy Ciphertext', ok ? 'Ciphertext copied.' : 'Failed to copy ciphertext.');
  });

  document.getElementById('redact-run')?.addEventListener('click', () => {
    const input = document.getElementById('redact-input').value;
    const output = document.getElementById('redact-output');
    output.value = redactText(input);
    showSecurityAlert('success', 'Redaction Complete', 'Sensitive data masked.');
  });

  document.getElementById('redact-copy')?.addEventListener('click', async () => {
    const output = document.getElementById('redact-output');
    const ok = await copyToClipboard(output.value);
    showSecurityAlert(ok ? 'success' : 'error', 'Copy Redaction', ok ? 'Redacted text copied.' : 'Failed to copy.');
  });

  // Maintenance Logic (Cleaner Tab)
  document.getElementById('run-maintenance-btn')?.addEventListener('click', () => {
    promptSafetyModal("Are you sure you want to run a physical System Cleanup? This will natively wipe temporary memory allocations and unused filesystem caching violently under root permissions via pkexec.", async () => {
      const btn = document.getElementById('run-maintenance-btn');
      const alertBox = document.getElementById('maintenance-alert');
      const msg = document.getElementById('maintenance-msg');

      btn.disabled = true;
      setButtonLoading(btn, 'Cleaning Caches...');

      try {
        const resp = await invoke("run_maintenance");
        setTimeout(() => {
          msg.textContent = resp;
          alertBox.className = "alert mt-4 custom-alert alert-success mx-auto";
          alertBox.classList.remove('d-none');
          setButtonText(btn, 'Clean Cache Files');
          btn.disabled = false;

          setTimeout(() => alertBox.classList.add('d-none'), 4000);
        }, 800);
      } catch (e) {
        console.error(e);
        msg.textContent = String(e);
        alertBox.className = "alert mt-4 custom-alert alert-danger mx-auto";
        alertBox.classList.remove('d-none');
        btn.disabled = false;
        setButtonText(btn, 'Clean Cache Files');
      }
    });
  });

  // Booster Logic
  document.getElementById('run-boost-btn')?.addEventListener('click', () => {
    promptSafetyModal(`Ready to Boost? This action executes sync; echo 3 > /proc/sys/vm/drop_caches securely under pkexec, ripping out un-allocated OS caches dynamically.`, async () => {
      const btn = document.getElementById('run-boost-btn');
      const alertBox = document.getElementById('boost-alert');
      const msg = document.getElementById('boost-msg');

      btn.disabled = true;
      setButtonLoading(btn, 'Optimizing Workload...');

      try {
        const resp = await invoke("run_booster");
        setTimeout(() => {
          msg.textContent = resp;
          alertBox.className = "alert alert-success mt-4 custom-alert mx-auto";
          setButtonText(btn, 'Boost Performance');
          btn.disabled = false;
          alertBox.classList.remove('d-none');
          setTimeout(() => alertBox.classList.add('d-none'), 4000);
        }, 1000);
      } catch (e) {
        msg.textContent = String(e);
        alertBox.className = "alert alert-danger mt-4 custom-alert mx-auto";
        alertBox.classList.remove('d-none');
        btn.disabled = false;
        setButtonText(btn, 'Boost Performance');
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

  // OS Updater Trigger
  document.getElementById('run-os-update-btn')?.addEventListener('click', () => {
    promptSafetyModal(`This incredibly aggressive background task natively invokes your OS package manager to fetch missing core distribution headers natively. Depending on your configuration, PolKit authentication may freeze over your application briefly to verify encryption keys. Are you absolutely sure you want to securely embed this terminal streaming payload?`, async () => {
      const btn = document.getElementById('run-os-update-btn');
      const container = document.getElementById('os-terminal-container');
      const consoleNode = document.getElementById('os-updater-console');
      const loader = document.getElementById('os-terminal-loader');

      btn.disabled = true;
      setButtonLoading(btn, 'Authenticating Target...');

      container.classList.remove('d-none');
      consoleNode.textContent = 'Connecting to securely elevated native hook bindings...\n';
      loader.classList.remove('d-none');

      try {
        const resp = await invoke("run_system_update");
        console.log("OS Upgrade Native Bridge Passed Payload: ", resp);
      } catch (e) {
        console.error("OS Update Hook Rejected: ", e);
      } finally {
        setTimeout(() => {
          btn.disabled = false;
          setButtonIcon(btn, 'fas fa-hammer me-2', 'Upgrade OS');
          loader.classList.add('d-none');
        }, 1200);
      }
    });
  });

  // Clear OS Console
  document.getElementById('clear-os-console-btn')?.addEventListener('click', () => {
    const consoleNode = document.getElementById('os-updater-console');
    if (consoleNode) consoleNode.textContent = 'Terminal output cleared.\n';
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
    // Diagnostics log streaming
    listen('diag-log', (event) => {
      const out = document.getElementById('diag-log-output');
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
    setButtonLoading(btn, 'Checking servers...');
    alertBox.classList.add('d-none');

    try {
      const resp = await invoke("check_for_updates");
      title.textContent = resp.title;
      msg.textContent = resp.message;
      alertBox.className = `alert mt-3 custom-alert mx-auto text-start alert-${resp.status === 'upgrade' ? 'primary' : 'success'}`;
    } catch (err) {
      title.textContent = 'Update Failed';
      msg.textContent = String(err);
      alertBox.className = 'alert mt-3 custom-alert mx-auto text-start alert-danger';
    } finally {
      btn.disabled = false;
      setButtonIcon(btn, 'fas fa-cloud-arrow-down me-2', 'Check for Updates');
    }
  });

  // Initial Telemetry Ping on Load
  const teleOnLoad = localStorage.getItem('setting-telemetry') === 'true';
  if (teleOnLoad) {
    invoke("send_telemetry", { enabled: true }).catch(err => console.error("Boot telemetry failed:", err));
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
        netChart.data.datasets[0].backgroundColor = netView === 'in' ? netGradientIn : netGradientOut;
        netChart.update();
      }
    });
  }

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

  // Diagnostics start/stop
  const diagStart = document.getElementById('diag-start');
  const diagStop = document.getElementById('diag-stop');
  if (diagStart) {
    diagStart.addEventListener('click', async () => {
      const unit = document.getElementById('diag-unit').value.trim();
      const out = document.getElementById('diag-log-output');
      if (out) out.textContent = 'Starting...\n';
      try {
        await invoke('start_log_tail', { unit: unit || null });
      } catch (e) {
        if (out) out.textContent += 'Error starting diagnostics: ' + e + '\n';
      }
    });
  }
  if (diagStop) {
    diagStop.addEventListener('click', async () => {
      const out = document.getElementById('diag-log-output');
      try {
        const resp = await invoke('stop_log_tail');
        if (out) out.textContent += resp + '\n';
      } catch (e) {
        if (out) out.textContent += 'Error stopping diagnostics: ' + e + '\n';
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
  netGradientIn = ctx.createLinearGradient(0, 0, 0, 120);
  netGradientIn.addColorStop(0, 'rgba(16,185,129,0.25)');
  netGradientIn.addColorStop(1, 'rgba(16,185,129,0)');

  netGradientOut = ctx.createLinearGradient(0, 0, 0, 120);
  netGradientOut.addColorStop(0, 'rgba(99,102,241,0.25)');
  netGradientOut.addColorStop(1, 'rgba(99,102,241,0)');

  netChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: Array(20).fill(''),
      datasets: [{
        label: 'Net (B/s)',
        data: Array(20).fill(0),
        borderColor: netView === 'in' ? '#10b981' : '#6366f1',
        backgroundColor: netView === 'in' ? netGradientIn : netGradientOut,
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

window.addEventListener('beforeunload', () => {
  if (dataPollInterval) {
    clearInterval(dataPollInterval);
    dataPollInterval = null;
  }
});

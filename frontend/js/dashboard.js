// TecXPaneL — dashboard (sparklines, stats WebSocket, servicios, procesos)

// ── Sparkline Charts (Dashboard) ──────────────────────────────
const maxSamples = 30;
const cpuHistory = [];
const memHistory = [];
const netRxHistory = [];
const netTxHistory = [];

// drawSparkline: dibuja un mini-gráfico de líneas (CPU/RAM/red) en un <canvas>.
function drawSparkline(canvasId, data, color, isNet = false, data2 = null) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;

  const dpr = window.devicePixelRatio || 1;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  ctx.scale(dpr, dpr);

  ctx.clearRect(0, 0, w, h);
  if (data.length < 2) return;

  let maxVal = 100;
  if (isNet) {
    maxVal = Math.max(...data, ...(data2 || []), 1024 * 1024); // Mínimo 1MB/s (auto-escala dinámicamente)
  }

  const drawLine = (values, lineColor, fillColor) => {
    ctx.beginPath();
    const getX = (i) => (i / (maxSamples - 1)) * w;
    const getY = (val) => h - (val / maxVal) * (h - 4) - 2;

    ctx.moveTo(getX(0), getY(values[0]));
    for (let i = 1; i < values.length; i++) {
      ctx.lineTo(getX(i), getY(values[i]));
    }

    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 1.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();

    ctx.lineTo(getX(values.length - 1), h);
    ctx.lineTo(getX(0), h);
    ctx.closePath();
    ctx.fillStyle = fillColor;
    ctx.fill();
  };

  if (isNet && data2) {
    drawLine(data, 'rgba(100, 172, 255, 1)', 'rgba(100, 172, 255, 0.1)'); // RX (blue)
    drawLine(data2, 'rgba(232, 160, 32, 1)', 'rgba(232, 160, 32, 0.05)'); // TX (orange)
  } else {
    drawLine(data, color, color.replace(', 1)', ', 0.15)'));
  }
}

// ── Stats WebSocket ───────────────────────────────────────────
// connectStatsWS: abre el WebSocket /ws/stats y actualiza los gráficos en vivo
// cada vez que el servidor envía datos (CPU, RAM, red).
function connectStatsWS() {
  const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
  const wsUrl = `${wsProto}://${location.host}/ws/stats?token=${TOKEN}`;
  statsWS = new WebSocket(wsUrl);

  statsWS.onmessage = (e) => {
    const d = JSON.parse(e.data);
    if (d.type !== 'stats') return;

    // CPU
    document.getElementById('cpu-val').textContent = d.cpu;
    document.getElementById('cpu-bar').style.width = d.cpu + '%';
    document.getElementById('cpu-bar').style.background = d.cpu > 80 ? 'var(--red)' : d.cpu > 60 ? 'var(--yellow)' : 'var(--accent)';

    cpuHistory.push(d.cpu);
    if (cpuHistory.length > maxSamples) cpuHistory.shift();
    drawSparkline('cpu-chart', cpuHistory, 'rgba(232, 160, 32, 1)');

    // MEM
    document.getElementById('mem-val').textContent = d.memory.percent;
    document.getElementById('mem-bar').style.width = d.memory.percent + '%';
    document.getElementById('mem-detail').textContent = `${fmtBytes(d.memory.used)} / ${fmtBytes(d.memory.total)}`;

    memHistory.push(d.memory.percent);
    if (memHistory.length > maxSamples) memHistory.shift();
    drawSparkline('mem-chart', memHistory, 'rgba(90, 200, 250, 1)');

    // NET
    document.getElementById('net-rx').textContent = fmtBytes(d.network.rx) + '/s';
    document.getElementById('net-tx').textContent = fmtBytes(d.network.tx) + '/s';

    netRxHistory.push(d.network.rx);
    netTxHistory.push(d.network.tx);
    if (netRxHistory.length > maxSamples) netRxHistory.shift();
    if (netTxHistory.length > maxSamples) netTxHistory.shift();
    drawSparkline('net-chart', netRxHistory, '', true, netTxHistory);
  };

  statsWS.onclose = () => setTimeout(connectStatsWS, 5000);
}

// ── Dashboard ─────────────────────────────────────────────────
// loadDashboard: carga las tarjetas del panel principal (stats y resúmenes).
async function loadDashboard() {
  const data = await req('GET', '/system/stats');
  if (!data) return;

  const mainDisk = data.disk.find(d => d.mount === '/') || data.disk[0];
  if (mainDisk) {
    document.getElementById('disk-val').textContent = Math.round(mainDisk.percent);
    document.getElementById('disk-bar').style.width = mainDisk.percent + '%';
    document.getElementById('disk-detail').textContent = `${fmtBytes(mainDisk.used)} / ${fmtBytes(mainDisk.size)}`;
  }

  const os = data.os;
  document.getElementById('server-hostname').textContent = os.hostname;
  document.getElementById('uptime-display').textContent = `↑ ${Math.floor(os.uptime / 3600)}h ${Math.floor((os.uptime % 3600) / 60)}m`;

  const osGrid = document.getElementById('os-info');
  const items = [
    { icon: 'ti-server', label: 'Hostname', value: os.hostname },
    { icon: 'ti-brand-ubuntu', label: 'Sistema', value: `${os.distro} ${os.release}` },
    { icon: 'ti-cpu', label: 'Arquitectura', value: os.arch },
    { icon: 'ti-clock', label: 'Uptime', value: `${Math.floor(os.uptime / 3600)}h ${Math.floor((os.uptime % 3600)/60)}m` },
  ];
  osGrid.innerHTML = items.map(i => `
    <div style="background:var(--bg-card2);border-radius:var(--radius-sm);padding:12px;border:1px solid var(--border)">
      <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px;display:flex;align-items:center;gap:6px">
        <i class="ti ${i.icon}" style="font-size:14px;color:var(--accent)"></i>${i.label}
      </div>
      <div style="font-size:14px;font-weight:600">${i.value}</div>
    </div>
  `).join('');
}

// ── Services ──────────────────────────────────────────────────
// loadServices: lista los servicios del sistema (nginx, mysql...) y su estado.
async function loadServices() {
  const data = await req('GET', '/system/services');
  if (!data) return;
  const list = document.getElementById('services-list');
  const icons = { nginx: 'ti-layout', mysql: 'ti-database', postgresql: 'ti-elephant', redis: 'ti-bolt', ssh: 'ti-key' };
  list.innerHTML = data.map(s => `
    <div class="service-row">
      <div class="service-name">
        <i class="ti ${icons[s.name] || 'ti-server'}" style="color:var(--accent);font-size:16px"></i>
        ${esc(s.name.charAt(0).toUpperCase() + s.name.slice(1))}
      </div>
      <div style="display:flex;align-items:center;gap:8px">
        <span class="badge ${s.status === 'running' ? 'badge-green' : 'badge-red'}">${s.status === 'running' ? 'Activo' : 'Parado'}</span>
        <div class="service-actions">
          ${s.status === 'running'
            ? `<button class="btn btn-sm btn-danger" onclick="svcAction('${s.name}','stop')"><i class="ti ti-player-stop"></i></button>
               <button class="btn btn-sm" onclick="svcAction('${s.name}','restart')"><i class="ti ti-refresh"></i></button>`
            : `<button class="btn btn-sm btn-success" onclick="svcAction('${s.name}','start')"><i class="ti ti-player-play"></i></button>`}
        </div>
      </div>
    </div>
  `).join('');
}

// svcAction: arranca/para/reinicia un servicio del sistema y refresca la lista.
async function svcAction(name, action) {
  toast(`${action} ${name}...`, 'info');
  const r = await req('POST', `/system/service/${name}/${action}`);
  if (r?.success) { toast(`${name} ${action} correcto`, 'success'); loadServices(); }
  else toast(r?.error || 'Error', 'error');
}

// ── Processes ─────────────────────────────────────────────────
// loadProcesses: muestra los procesos que más CPU consumen.
async function loadProcesses() {
  const data = await req('GET', '/system/processes');
  if (!data) return;
  const tb = document.getElementById('procs-table');
  tb.innerHTML = data.slice(0,10).map(p => `
    <tr>
      <td style="color:var(--text-muted);font-family:var(--mono)">${p.pid}</td>
      <td style="font-weight:500">${esc(p.name)}</td>
      <td><span style="color:${p.cpu > 50 ? 'var(--red)' : p.cpu > 20 ? 'var(--yellow)' : 'var(--green)'}">${p.cpu.toFixed(1)}%</span></td>
      <td>${p.mem.toFixed(1)}%</td>
    </tr>
  `).join('');
}

// TecXPaneL — plugins (Docker/phpMyAdmin/Adminer/Redis/Fail2Ban/Composer/Certbot)

// ── Plugins ──────────────────────────────────────────────────
// loadPlugins: lista los plugins del servidor (Docker, Redis...) y si están instalados.
async function loadPlugins() {
  const data = await req('GET', '/plugins');
  if (!data) return;
  const grid = document.getElementById('plugins-grid');
  const icons = { 'brand-docker':'#2496ED', 'database-cog':'#F89820', 'database-heart':'#DC382D', 'shield-lock':'#4CAF50', 'package':'#F28D1A', 'certificate':'#0E9E6E' };
  grid.innerHTML = data.map(p => `
    <div style="background:var(--bg-card2);border:1px solid var(--border);border-radius:var(--radius);padding:1rem;display:flex;flex-direction:column;gap:0.5rem">
      <div style="display:flex;align-items:center;gap:10px">
        <i class="ti ti-${esc(p.icon)}" style="font-size:24px;color:${icons[p.icon]||'var(--accent)'}"></i>
        <div>
          <div style="font-weight:600;font-size:14px">${esc(p.name)}</div>
          <div style="font-size:11px;color:var(--text-muted)">${esc(p.category)}</div>
        </div>
        <span class="badge ${p.installed ? 'badge-green' : 'badge-red'}" style="margin-left:auto">${p.installed ? '● Instalado' : '○ No instalado'}</span>
      </div>
      <div style="font-size:12px;color:var(--text-secondary)">${esc(p.desc)}</div>
      <div style="margin-top:auto;display:flex;gap:6px">
        ${p.installed
          ? `<button class="btn btn-sm btn-danger" onclick="uninstallPlugin('${esc(p.id)}','${esc(p.name)}')"><i class="ti ti-trash"></i> Desinstalar</button>`
          : `<button class="btn btn-sm btn-primary" onclick="installPlugin('${esc(p.id)}','${esc(p.name)}')"><i class="ti ti-download"></i> Instalar</button>`}
      </div>
    </div>
  `).join('');
}

// installPlugin: instala un plugin (con confirmación) mostrando la salida en vivo.
function installPlugin(id, name) {
  if (!confirm(`¿Instalar ${name}? Esto puede tardar unos minutos.`)) return;
  streamPlugin(id, 'install', name);
}

// uninstallPlugin: desinstala un plugin (con confirmación).
function uninstallPlugin(id, name) {
  if (!confirm(`¿Desinstalar ${name}?`)) return;
  streamPlugin(id, 'uninstall', name);
}

// Ejecuta install/uninstall mostrando la salida en vivo en la consola de plugins.
// streamPlugin: ejecuta install/uninstall de un plugin y muestra la salida en
// directo (lee el stream y detecta el marcador __TXPL_DONE__ del final).
async function streamPlugin(id, action, name) {
  const wrap = document.getElementById('plugin-console');
  const out = document.getElementById('plugin-console-output');
  const titleEl = document.getElementById('plugin-console-title');
  const spinner = document.getElementById('plugin-console-spinner');
  const DONE = '__TXPL_DONE__';

  wrap.style.display = 'block';
  titleEl.textContent = (action === 'install' ? 'Instalando ' : 'Desinstalando ') + name;
  spinner.style.display = 'inline';
  out.textContent = '';
  wrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  let exitCode = 1;
  try {
    const r = await fetch(API + `/api/plugins/${id}/${action}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${TOKEN}` },
    });
    if (r.status === 401) { doLogout(); return; }
    if (!r.body) { out.textContent = 'El navegador no soporta streaming.'; return; }

    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += dec.decode(value, { stream: true });
      let display = buffer;
      const idx = buffer.indexOf(DONE);
      if (idx >= 0) { exitCode = parseInt(buffer.slice(idx + DONE.length).trim(), 10) || 0; display = buffer.slice(0, idx); }
      out.textContent = display;
      out.scrollTop = out.scrollHeight;
    }
  } catch (e) {
    out.textContent += '\n✖ Error de conexión: ' + (e?.message || e);
  }

  spinner.style.display = 'none';
  const success = exitCode === 0;
  out.textContent += success ? `\n✅ ${action === 'install' ? 'Instalado' : 'Desinstalado'} correctamente.\n`
    : `\n✖ Terminó con errores (código ${exitCode}).\n`;
  out.scrollTop = out.scrollHeight;
  toast(success ? `${name} ${action === 'install' ? 'instalado' : 'desinstalado'}` : `${name}: terminó con errores`, success ? 'success' : 'error');
  loadPlugins();
}

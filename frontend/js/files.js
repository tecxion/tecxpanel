// TecXPaneL — files (file manager, drag&drop, editor)
let currentFilePath = '/';

// loadFiles: lista el contenido de la carpeta actual en el gestor de archivos.
async function loadFiles() {
  const path = currentFilePath;
  const data = await req('GET', `/files?path=${encodeURIComponent(path)}`);
  if (!data) { toast('Error cargando directorio', 'error'); return; }

  updateBreadcrumb(path);
  const tb = document.getElementById('files-table');
  const items = data.items || [];

  if (!items.length) {
    tb.innerHTML = '<tr><td colspan="5" style="padding:2rem;text-align:center;color:var(--text-muted)"><i class="ti ti-inbox"></i> Directorio vacío</td></tr>';
    return;
  }

  let itemsHtml = items.map(f => {
    const icon = f.type === 'directory' ? 'ti-folder' : getFileIcon(f.name);
    const onClick = f.type === 'directory' ? `onclick="browseDir('${esc(f.path)}')"` : '';
    const style = f.type === 'directory' ? 'cursor:pointer;color:var(--accent)' : '';
    const isArchive = /\.(zip|tar\.gz|tgz|tar)$/i.test(f.name);
    return `
      <tr>
        <td style="width:40px"><i class="ti ${icon}" style="font-size:16px;opacity:0.7"></i></td>
        <td><span ${onClick} style="${style};display:inline-block;${f.type === 'directory' ? 'text-decoration:underline' : ''}">${esc(f.name)}</span></td>
        <td>${f.type === 'file' ? fmtBytes(f.size) : '—'}</td>
        <td style="color:var(--text-muted)">${fmtDate(f.modified)}</td>
        <td>
          <div style="display:flex;gap:5px;justify-content:flex-end">
            ${isArchive ? `<button class="btn btn-sm btn-success" onclick="extractFile('${esc(f.path)}')" title="Extraer aquí"><i class="ti ti-file-zip"></i></button>` : ''}
            ${f.type === 'file' && !isArchive ? `<button class="btn btn-sm" onclick="editFile('${esc(f.path)}')" title="Editar"><i class="ti ti-edit"></i></button>` : ''}
            <button class="btn btn-sm btn-danger" onclick="deleteFile('${esc(f.path)}')" title="Eliminar"><i class="ti ti-trash"></i></button>
          </div>
        </td>
      </tr>
    `;
  }).join('');

  if (path !== '/') {
    const parentPath = path.substring(0, path.lastIndexOf('/')) || '/';
    itemsHtml = `
      <tr>
        <td style="width:40px"><i class="ti ti-arrow-up" style="font-size:16px;opacity:0.7"></i></td>
        <td colspan="4"><span onclick="browseDir('${esc(parentPath)}')" style="cursor:pointer;color:var(--accent);text-decoration:underline">.. (Volver arriba)</span></td>
      </tr>
    ` + itemsHtml;
  }

  tb.innerHTML = itemsHtml;
  setupDragDrop();
}

// updateBreadcrumb: dibuja la barra de "migas de pan" (la ruta clicable de carpetas).
function updateBreadcrumb(path) {
  if (path === '/') {
    document.getElementById('file-breadcrumb').innerHTML = '<span style="color:var(--text-muted)">/</span>';
    return;
  }

  const parts = path.split('/').filter(p => p);
  const crumbs = parts.map((part, i) => {
    const subPath = '/' + parts.slice(0, i + 1).join('/');
    return `<a href="#" onclick="event.preventDefault();browseDir('${subPath}')" style="color:var(--accent);text-decoration:none;cursor:pointer">${esc(part)}</a>`;
  }).join(' <span style="color:var(--text-muted)">/</span> ');
  document.getElementById('file-breadcrumb').innerHTML = `<a href="#" onclick="event.preventDefault();browseDir('/')" style="color:var(--text-muted);text-decoration:none;cursor:pointer">/</a> <span style="color:var(--text-muted)">/</span> ${crumbs}`;
}

// getFileIcon: elige un icono según la extensión del archivo.
function getFileIcon(filename) {
  const ext = filename.split('.').pop().toLowerCase();
  const iconMap = {
    'html': 'ti-file-type-html', 'css': 'ti-file-type-css', 'js': 'ti-file-type-js',
    'json': 'ti-file-type-json', 'php': 'ti-file-type-php', 'py': 'ti-file-type-python',
    'txt': 'ti-file-type-txt', 'pdf': 'ti-file-type-pdf', 'zip': 'ti-file-type-zip',
    'jpg': 'ti-file-type-jpg', 'png': 'ti-file-type-png', 'gif': 'ti-file-type-gif'
  };
  return iconMap[ext] || 'ti-file';
}

let dragDropBound = false;
// setupDragDrop: activa arrastrar y soltar archivos/carpetas en el gestor.
function setupDragDrop() {
  const zone = document.getElementById('drop-zone');
  if (!zone || dragDropBound) return;
  dragDropBound = true;

  // Evita que el navegador abra el archivo al soltarlo fuera de la zona exacta
  ['dragover', 'drop'].forEach(ev => {
    window.addEventListener(ev, (e) => { e.preventDefault(); }, false);
  });

  zone.addEventListener('dragenter', (e) => {
    e.preventDefault(); e.stopPropagation();
    zone.style.background = 'var(--accent-glow)';
    zone.style.borderColor = 'var(--accent)';
  });
  zone.addEventListener('dragover', (e) => {
    e.preventDefault(); e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    zone.style.background = 'var(--accent-glow)';
    zone.style.borderColor = 'var(--accent)';
  });
  zone.addEventListener('dragleave', (e) => {
    e.preventDefault(); e.stopPropagation();
    zone.style.background = 'var(--bg-card2)';
    zone.style.borderColor = 'var(--border)';
  });
  zone.addEventListener('drop', (e) => {
    e.preventDefault(); e.stopPropagation();
    zone.style.background = 'var(--bg-card2)';
    zone.style.borderColor = 'var(--border)';
    handleDrop(e);
  });
  zone.addEventListener('click', () => document.getElementById('file-upload').click());
}

// handleDrop: procesa los archivos/carpetas soltados en el gestor.
function handleDrop(e) {
  const dt = e.dataTransfer;
  if (!dt) return;

  // IMPORTANTE: las entries deben leerse de forma síncrona dentro del handler
  const entries = [];
  if (dt.items && dt.items.length) {
    for (let i = 0; i < dt.items.length; i++) {
      const item = dt.items[i];
      if (item.kind && item.kind !== 'file') continue;
      const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry()
                  : (item.getAsEntry ? item.getAsEntry() : null);
      if (entry) entries.push(entry);
    }
  }

  if (entries.length > 0) {
    processEntries(entries);
  } else if (dt.files && dt.files.length > 0) {
    // Fallback: el navegador no soporta entries de directorio
    uploadFlatFiles(dt.files);
  } else {
    toast('No se detectaron archivos. Prueba con otro navegador (Chrome/Edge).', 'error');
  }
}

// handleFileUpload: gestiona la subida desde el botón de seleccionar archivos.
function handleFileUpload(e) {
  uploadFlatFiles(e.target.files);
  e.target.value = '';
}

// showProgress: actualiza la barra de progreso de subida de archivos.
function showProgress(done, total, currentName) {
  const wrap = document.getElementById('upload-progress');
  const bar = document.getElementById('upload-bar');
  const pct = document.getElementById('upload-percent');
  const status = document.getElementById('upload-status');
  const detail = document.getElementById('upload-detail');
  if (!wrap) return;
  wrap.style.display = 'block';
  const p = total > 0 ? Math.round((done / total) * 100) : 0;
  bar.style.width = p + '%';
  pct.textContent = p + '%';
  status.textContent = done < total ? `Subiendo: ${currentName}` : 'Completado';
  detail.textContent = `${done} / ${total} archivos`;
}

// hideProgress: oculta la barra de progreso al terminar.
function hideProgress() {
  const wrap = document.getElementById('upload-progress');
  if (wrap) setTimeout(() => { wrap.style.display = 'none'; }, 3000);
}

// readEntryAsFile: convierte una entrada del drag-drop en un objeto File (promesa).
function readEntryAsFile(entry) {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

// readDirEntries: lee todas las entradas de una carpeta arrastrada.
function readDirEntries(reader) {
  return new Promise((resolve, reject) => {
    const all = [];
    (function batch() {
      reader.readEntries(results => {
        if (!results.length) return resolve(all);
        all.push(...results);
        batch();
      }, reject);
    })();
  });
}

// flattenEntry: recorre recursivamente una carpeta y devuelve su lista de archivos.
async function flattenEntry(entry, basePath) {
  const list = [];
  if (entry.isFile) {
    list.push({ entry, destPath: basePath + '/' + entry.name, isDir: false });
  } else if (entry.isDirectory) {
    const dirPath = basePath + '/' + entry.name;
    list.push({ destPath: dirPath, isDir: true });
    const reader = entry.createReader();
    const children = await readDirEntries(reader);
    for (const child of children) {
      const sub = await flattenEntry(child, dirPath);
      list.push(...sub);
    }
  }
  return list;
}

// Sube un archivo por streaming binario (sin base64, sin límite de JSON)
// uploadBinary: sube un archivo al servidor por streaming binario.
async function uploadBinary(file, destPath) {
  const r = await fetch(API + '/api/files/upload?path=' + encodeURIComponent(destPath), {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/octet-stream' },
    body: file,
  });
  if (r.status === 401) { doLogout(); return { success: false }; }
  if (r.status === 413) return { success: false, tooBig: true };
  try { return await r.json(); } catch (_) { return { success: r.ok }; }
}

// processEntries: sube en orden todos los archivos arrastrados, con progreso.
async function processEntries(entries) {
  const allItems = [];
  for (const entry of entries) {
    allItems.push(...await flattenEntry(entry, currentFilePath));
  }
  const fileItems = allItems.filter(i => !i.isDir);
  const total = fileItems.length;
  if (total === 0) { toast('La carpeta está vacía', 'error'); return; }

  let done = 0, errors = 0, tooBig = false;
  showProgress(0, total, '');

  for (const item of allItems) {
    if (item.isDir) {
      await req('POST', '/files/mkdir', { path: item.destPath });
      continue;
    }
    try {
      const file = await readEntryAsFile(item.entry);
      showProgress(done, total, file.name);
      const r = await uploadBinary(file, item.destPath);
      if (r?.success) done++;
      else { errors++; if (r?.tooBig) tooBig = true; }
    } catch (_) { errors++; }
    showProgress(done, total, '');
  }

  showProgress(total, total, '');
  hideProgress();
  if (errors === 0) toast(`${done} archivo${done > 1 ? 's' : ''} subido${done > 1 ? 's' : ''}`, 'success');
  else if (tooBig) toast('Archivo demasiado grande para el servidor (nginx). Sube el límite: client_max_body_size.', 'error');
  else toast(`${done} subidos, ${errors} fallidos`, 'error');
  loadFiles();
}

// uploadFlatFiles: sube una lista plana de archivos (sin estructura de carpetas).
async function uploadFlatFiles(fileList) {
  const files = Array.from(fileList);
  const total = files.length;
  if (total === 0) return;

  let done = 0, errors = 0, tooBig = false;
  showProgress(0, total, '');

  for (const file of files) {
    try {
      showProgress(done, total, file.name);
      const r = await uploadBinary(file, currentFilePath + '/' + file.name);
      if (r?.success) done++;
      else { errors++; if (r?.tooBig) tooBig = true; }
    } catch (_) { errors++; }
    showProgress(done, total, '');
  }

  showProgress(total, total, '');
  hideProgress();
  if (errors === 0) toast(`${done} archivo${done > 1 ? 's' : ''} subido${done > 1 ? 's' : ''}`, 'success');
  else if (tooBig) toast('Archivo demasiado grande para el servidor (nginx). Sube el límite: client_max_body_size.', 'error');
  else toast(`${done} subidos, ${errors} fallidos`, 'error');
  loadFiles();
}

// createFolder: crea una carpeta nueva en la ruta actual.
async function createFolder() {
  const name = document.getElementById('folder-name').value.trim();
  if (!name) { toast('Nombre requerido', 'error'); return; }
  const path = currentFilePath + '/' + name;
  const r = await req('POST', '/files/mkdir', { path });
  if (r?.success) { toast('Carpeta creada', 'success'); closeModal('modal-new-folder'); loadFiles(); }
  else toast(r?.error || 'Error', 'error');
}

// createFile: crea un archivo vacío en la ruta actual.
async function createFile() {
  const name = document.getElementById('file-name').value.trim();
  if (!name) { toast('Nombre requerido', 'error'); return; }
  const path = currentFilePath + '/' + name;
  const r = await req('POST', '/files/write', { path, content: '' });
  if (r?.success) { toast('Archivo creado', 'success'); closeModal('modal-new-file'); loadFiles(); }
  else toast(r?.error || 'Error', 'error');
}

// browseDir: entra en una carpeta y recarga la lista de archivos.
function browseDir(path) {
  currentFilePath = path;
  loadFiles();
}

// deleteFile: borra un archivo o carpeta (con confirmación).
async function deleteFile(path) {
  const name = path.split('/').pop();
  if (!confirm(`¿Eliminar "${name}"?`)) return;
  const r = await req('DELETE', '/files', { path });
  if (r?.success) { toast('Eliminado', 'success'); loadFiles(); }
  else toast(r?.error || 'Error', 'error');
}

// extractFile: descomprime un archivo .zip/.tar en su carpeta.
async function extractFile(path) {
  const name = path.split('/').pop();
  if (!confirm(`¿Extraer "${name}" en esta carpeta?`)) return;
  toast(`Extrayendo ${name}...`, 'info');
  const r = await req('POST', '/files/extract', { path });
  if (r?.success) { toast('Archivo extraído', 'success'); loadFiles(); }
  else toast(r?.error || 'Error al extraer', 'error');
}

// editFile: abre un archivo de texto en el editor del panel.
async function editFile(path) {
  const name = path.split('/').pop();
  const r = await req('GET', `/files/read?path=${encodeURIComponent(path)}`);
  if (!r?.content && r?.content !== '') { toast('No se pudo leer el archivo', 'error'); return; }

  const modal = document.createElement('div');
  modal.className = 'modal-overlay open';
  modal.id = 'modal-edit-file';
  modal.dataset.dynamic = 'true';
  modal.innerHTML = `
    <div class="modal" style="width:90%;max-width:900px;max-height:90vh;display:flex;flex-direction:column">
      <div class="modal-header">
        <div class="modal-title"><i class="ti ti-edit" style="color:var(--accent)"></i> Editar: ${esc(name)}</div>
        <button class="btn btn-sm" onclick="closeModal('modal-edit-file')"><i class="ti ti-x"></i></button>
      </div>
      <div style="flex:1;overflow:hidden;padding:1rem;border-top:1px solid var(--border);border-bottom:1px solid var(--border)">
        <textarea id="file-editor" style="width:100%;height:100%;background:var(--bg-app);color:var(--text-primary);border:1px solid var(--border);border-radius:var(--radius);padding:12px;font-family:var(--mono);font-size:13px;resize:none;outline:none">${esc(r.content)}</textarea>
      </div>
      <div class="modal-footer">
        <button class="btn" onclick="closeModal('modal-edit-file')"><i class="ti ti-x"></i> Cancelar</button>
        <button class="btn btn-primary" onclick="saveFile('${esc(path)}')"><i class="ti ti-check"></i> Guardar</button>
      </div>
    </div>
  `;
  modal.addEventListener('click', e => { if (e.target === modal) closeModal('modal-edit-file'); });
  document.body.appendChild(modal);
}

// saveFile: guarda los cambios del editor en el archivo.
async function saveFile(path) {
  const content = document.getElementById('file-editor').value;
  const r = await req('POST', '/files/write', { path, content });
  if (r?.success) { toast('Guardado', 'success'); closeModal('modal-edit-file'); loadFiles(); }
  else toast(r?.error || 'Error', 'error');
}

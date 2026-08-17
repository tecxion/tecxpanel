// TecXPaneL — files (file manager, drag&drop, editor)
let currentFilePath = '/';
let fileEditorState = null;

function pathCall(fn, path) {
  return fn + '(' + esc(JSON.stringify(path)) + ')';
}

// loadFiles: lista el contenido de la carpeta actual en el gestor de archivos.
async function loadFiles() {
  const path = currentFilePath;
  const data = await req('GET', `/files?path=${encodeURIComponent(path)}`);
  if (!data) { toast('Error cargando directorio', 'error'); return; }

  updateBreadcrumb(path);
  const tb = document.getElementById('files-table');
  const items = data.items || [];

  if (!items.length) {
    tb.innerHTML = '<tr><td colspan="5" class="files-empty"><i class="ti ti-inbox"></i><strong>Directorio vacío</strong><span>Arrastra archivos aquí o crea uno nuevo.</span></td></tr>';
    setupDragDrop();
    return;
  }

  let itemsHtml = items.map(f => {
    const icon = f.type === 'directory' ? 'ti-folder' : getFileIcon(f.name);
    const onClick = f.type === 'directory' ? `onclick="${pathCall('browseDir', f.path)}"` : '';
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
            ${isArchive ? `<button class="btn btn-sm btn-success" onclick="${pathCall('extractFile', f.path)}" title="Extraer aquí"><i class="ti ti-file-zip"></i></button>` : ''}
            ${f.type === 'file' && !isArchive ? `<button class="btn btn-sm" onclick="${pathCall('editFile', f.path)}" title="Editar"><i class="ti ti-edit"></i></button>` : ''}
            <button class="btn btn-sm" onclick="${pathCall('renameFile', f.path)}" title="Renombrar"><i class="ti ti-pencil"></i></button>
            <button class="btn btn-sm btn-danger" onclick="${pathCall('deleteFile', f.path)}" title="Eliminar"><i class="ti ti-trash"></i></button>
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
        <td colspan="4"><span onclick="${pathCall('browseDir', parentPath)}" style="cursor:pointer;color:var(--accent);text-decoration:underline">.. (Volver arriba)</span></td>
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
    document.getElementById('files-current-path').textContent = '/';
    return;
  }

  const parts = path.split('/').filter(p => p);
  const crumbs = parts.map((part, i) => {
    const subPath = '/' + parts.slice(0, i + 1).join('/');
    return '<a href="#" onclick="event.preventDefault();' + pathCall('browseDir', subPath) + '" style="color:var(--accent);text-decoration:none;cursor:pointer">' + esc(part) + '</a>';
  }).join(' <span style="color:var(--text-muted)">/</span> ');
  document.getElementById('file-breadcrumb').innerHTML = '<a href="#" onclick="event.preventDefault();browseDir('/')" style="color:var(--text-muted);text-decoration:none;cursor:pointer">/</a> <span style="color:var(--text-muted)">/</span> ' + crumbs;
  document.getElementById('files-current-path').textContent = path;
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
let dragDropZone = null;
// setupDragDrop: activa arrastrar y soltar archivos/carpetas en el gestor.
function setupDragDrop() {
  const zone = document.getElementById('drop-zone');
  if (!zone || dragDropZone === zone) return;
  dragDropZone = zone;
  if (!dragDropBound) {
    dragDropBound = true;

  // Evita que el navegador abra el archivo al soltarlo fuera de la zona exacta
    ['dragover', 'drop'].forEach(ev => {
      window.addEventListener(ev, (e) => { e.preventDefault(); }, false);
    });
  }

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

function updateEditorState() {
  if (!fileEditorState) return;
  const editor = document.getElementById('file-editor');
  const dirty = editor.value !== fileEditorState.original;
  fileEditorState.dirty = dirty;
  document.getElementById('file-editor-status').textContent = dirty ? 'Cambios sin guardar' : 'Sin cambios';
  document.getElementById('file-editor-status').className = dirty ? 'file-editor-status is-dirty' : 'file-editor-status';
  document.getElementById('file-editor-save').disabled = !dirty;
  document.getElementById('file-editor-stats').textContent = editor.value.length.toLocaleString('es-ES') + ' caracteres · ' + editor.value.split('\n').length + ' líneas';
  const preview = document.getElementById('file-editor-preview');
  if (preview && !preview.hidden) preview.srcdoc = editor.value;
}

function toggleFilePreview() {
  const preview = document.getElementById('file-editor-preview');
  const editor = document.getElementById('file-editor');
  const button = document.getElementById('file-editor-preview-toggle');
  if (!preview || !editor) return;
  const visible = preview.hidden;
  preview.hidden = !visible;
  button.classList.toggle('active', visible);
  if (visible) preview.srcdoc = editor.value;
}

function closeFileEditor(force = false) {
  if (fileEditorState?.dirty && !force && !confirm('Hay cambios sin guardar. ¿Cerrar sin guardar?')) return;
  document.getElementById('modal-edit-file')?.remove();
  fileEditorState = null;
}

// editFile: abre un editor de texto con estado de cambios y vista previa HTML segura.
async function editFile(path) {
  const name = path.split('/').pop();
  const r = await req('GET', '/files/read?path=' + encodeURIComponent(path));
  if (!r || typeof r.content !== 'string') { toast(r?.error || 'No se pudo leer el archivo', 'error'); return; }
  fileEditorState = { path, original: r.content, dirty: false, language: r.language || 'text' };
  const modal = document.createElement('div');
  modal.className = 'modal-overlay open';
  modal.id = 'modal-edit-file';
  modal.dataset.dynamic = 'true';
  modal.innerHTML = '<div class="modal file-editor-modal">'
    + '<div class="modal-header file-editor-header"><div><div class="modal-title"><i class="ti ti-edit"></i> ' + esc(name) + '</div><div class="file-editor-path">' + esc(path) + '</div></div>'
    + '<div class="file-editor-header-actions"><span class="file-editor-language">' + esc(fileEditorState.language) + '</span><button class="btn btn-sm" id="file-editor-close" aria-label="Cerrar editor"><i class="ti ti-x"></i></button></div></div>'
    + '<div class="file-editor-toolbar"><span id="file-editor-status" class="file-editor-status">Sin cambios</span><span id="file-editor-stats" class="file-editor-stats"></span><div class="file-editor-toolbar-actions">'
    + (fileEditorState.language === 'html' ? '<button class="btn btn-sm" id="file-editor-preview-toggle"><i class="ti ti-eye"></i> Vista previa</button>' : '')
    + '<button class="btn btn-sm btn-primary" id="file-editor-save" disabled><i class="ti ti-device-floppy"></i> Guardar <kbd>⌘/Ctrl S</kbd></button></div></div>'
    + '<div class="file-editor-workspace"><textarea id="file-editor" spellcheck="false" autocomplete="off" autocapitalize="off" aria-label="Contenido del archivo">' + esc(r.content) + '</textarea>'
    + (fileEditorState.language === 'html' ? '<iframe id="file-editor-preview" class="file-editor-preview" title="Vista previa HTML" sandbox hidden></iframe>' : '') + '</div>'
    + '<div class="modal-footer"><span class="file-editor-hint">Tab inserta dos espacios · Los archivos binarios no se abren como texto</span><button class="btn" id="file-editor-cancel">Cerrar</button></div></div>';
  document.body.appendChild(modal);
  const editor = document.getElementById('file-editor');
  editor.addEventListener('input', updateEditorState);
  editor.addEventListener('keydown', (event) => {
    if (event.key === 'Tab') { event.preventDefault(); editor.setRangeText('  ', editor.selectionStart, editor.selectionEnd, 'end'); updateEditorState(); }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); saveFile(path); }
  });
  document.getElementById('file-editor-save').addEventListener('click', () => saveFile(path));
  document.getElementById('file-editor-close').addEventListener('click', () => closeFileEditor());
  document.getElementById('file-editor-cancel').addEventListener('click', () => closeFileEditor());
  document.getElementById('file-editor-preview-toggle')?.addEventListener('click', toggleFilePreview);
  modal.addEventListener('click', (event) => { if (event.target === modal) closeFileEditor(); });
  editor.focus();
  updateEditorState();
}

async function saveFile(path) {
  const editor = document.getElementById('file-editor');
  if (!editor) return;
  const targetPath = fileEditorState?.path || path;
  const r = await req('POST', '/files/write', { path: targetPath, content: editor.value });
  if (r?.success) { fileEditorState.original = editor.value; updateEditorState(); toast('Archivo guardado', 'success'); loadFiles(); }
  else toast(r?.error || 'Error al guardar', 'error');
}

async function renameFile(path) {
  const name = path.split('/').pop();
  const next = prompt('Nuevo nombre:', name);
  if (!next || next.trim() === name) return;
  const parent = path.slice(0, path.lastIndexOf('/') + 1);
  const r = await req('POST', '/files/rename', { from: path, to: parent + next.trim() });
  if (r?.success) { toast('Renombrado', 'success'); loadFiles(); }
  else toast(r?.error || 'No se pudo renombrar', 'error');
}

Object.assign(window, {
  browseDir, closeFileEditor, createFile, createFolder, deleteFile, editFile, extractFile, flattenEntry, getFileIcon, handleDrop, handleFileUpload, hideProgress, loadFiles, processEntries, readDirEntries, readEntryAsFile, renameFile, saveFile, setupDragDrop, showProgress, toggleFilePreview, updateBreadcrumb, uploadBinary, uploadFlatFiles,
});

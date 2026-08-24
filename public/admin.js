const adminState = {
  token: sessionStorage.getItem('admin_token') || '',
  csrfToken: '',
  page: 1,
  totalPages: 1,
  filters: { sexo: '', estado: '', fecha_desde: '', fecha_hasta: '', q: '' }
};

const loginView = document.getElementById('loginView');
const dashboardView = document.getElementById('dashboardView');
const loginStatus = document.getElementById('loginStatus');
const rowsBody = document.getElementById('rowsBody');
const pageLabel = document.getElementById('pageLabel');
const statsGrid = document.getElementById('statsGrid');
const logsBody = document.getElementById('logsBody');
const codeDialog = document.getElementById('codeDialog');
const editDialog = document.getElementById('editDialog');
const editForm = document.getElementById('editForm');
const editStatus = document.getElementById('editStatus');

async function bootstrapAdmin() {
  const csrfRes = await fetch('/api/csrf-token').then(r => r.json());
  adminState.csrfToken = csrfRes.csrfToken;
  bindTabs();
  if (adminState.token) {
    showDashboard();
    await Promise.all([loadTable(), loadConfig(), loadLogs()]);
  }
}

function authHeaders(extra = {}) {
  return {
    ...extra,
    'Authorization': `Bearer ${adminState.token}`,
    'x-csrf-token': adminState.csrfToken
  };
}

function showDashboard() {
  loginView.classList.add('hidden');
  dashboardView.classList.remove('hidden');
}

function showLogin() {
  dashboardView.classList.add('hidden');
  loginView.classList.remove('hidden');
}

document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  loginStatus.textContent = 'Verificando acceso...';
  const res = await fetch('/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-csrf-token': adminState.csrfToken },
    body: JSON.stringify({ usuario: fd.get('usuario'), password: fd.get('password') })
  });
  const data = await res.json();
  if (!res.ok) {
    loginStatus.textContent = data.mensaje || 'No fue posible iniciar sesión.';
    return;
  }
  adminState.token = data.token;
  sessionStorage.setItem('admin_token', data.token);
  document.getElementById('adminWelcome').textContent = `Sesión activa como ${data.usuario}.`; 
  loginStatus.textContent = '';
  showDashboard();
  await Promise.all([loadTable(), loadConfig(), loadLogs()]);
});

document.getElementById('logoutBtn').addEventListener('click', async () => {
  if (adminState.token) {
    await fetch('/api/admin/logout', { method: 'POST', headers: authHeaders() }).catch(() => {});
  }
  adminState.token = '';
  sessionStorage.removeItem('admin_token');
  showLogin();
});

async function loadTable() {
  const params = new URLSearchParams({ page: String(adminState.page), per_page: '25' });
  Object.entries(adminState.filters).forEach(([k, v]) => { if (v) params.set(k, v); });
  const res = await fetch(`/api/admin/preinscripciones?${params.toString()}`, { headers: authHeaders() });
  if (res.status === 401) {
    adminState.token = '';
    sessionStorage.removeItem('admin_token');
    showLogin();
    return;
  }
  const data = await res.json();
  adminState.totalPages = data.meta.total_pages;
  pageLabel.textContent = `Página ${data.meta.page} de ${data.meta.total_pages} · ${data.meta.total} registros`;
  statsGrid.innerHTML = [
    card('Total inscritos', data.stats.total || 0),
    card('👨 Hombres', data.stats.hombres || 0),
    card('👩 Mujeres', data.stats.mujeres || 0),
    card('✅ Pagados', data.stats.pagados || 0),
    card('🕓 Pendientes', data.stats.pendientes || 0)
  ].join('');

  rowsBody.innerHTML = data.rows.map(row => `
    <tr>
      <td>${row.id}</td>
      <td>${escapeHtml(row.nombre_completo)}</td>
      <td>${formatPhone(row.celular)}</td>
      <td>${row.sexo === 'H' ? '👨' : '👩'}</td>
      <td><span class="status-chip ${row.estado}">${labelEstado(row.estado)}</span></td>
      <td>${escapeHtml(row.origen)}</td>
      <td>${formatDate(row.created_at)}</td>
      <td>
        <div class="actions-col">
          <button class="mini-btn" onclick='quickConfirm(${JSON.stringify(row.id)})'>✅ Pago</button>
          <button class="mini-btn" onclick='openEdit(${JSON.stringify(encodeURIComponent(JSON.stringify(row)))})'>✏️ Editar</button>
          <button class="mini-btn warn" onclick='changeState(${JSON.stringify(row.id)}, "rechazado")'>❌ Rechazar</button>
          <button class="mini-btn danger" onclick='removeRow(${JSON.stringify(row.id)}, ${JSON.stringify(row.nombre_completo)})'>🗑 Eliminar</button>
        </div>
      </td>
    </tr>`).join('') || '<tr><td colspan="8" class="empty-row">Sin resultados para los filtros actuales.</td></tr>';
}

function card(label, value) {
  return `<article class="stat-card"><span>${label}</span><strong>${value}</strong></article>`;
}

function formatPhone(raw) {
  const s = String(raw || '');
  return s.length === 10 ? `+57 ${s.slice(0, 3)} ${s.slice(3, 6)} ${s.slice(6)}` : s;
}
function formatDate(dateStr) {
  const iso = dateStr.replace(' ', 'T') + '-05:00';
  const d = new Date(iso);
  return new Intl.DateTimeFormat('es-CO', { dateStyle: 'medium', timeStyle: 'short' }).format(d);
}
function labelEstado(v) {
  return ({ pendiente: 'Pendiente', confirmado_pago: 'Confirmado pago', rechazado: 'Rechazado', asignado: 'Asignado' })[v] || v;
}
function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

window.quickConfirm = async function (id) {
  await changeState(id, 'confirmado_pago', true);
};

window.changeState = async function (id, estado, showCode = false) {
  const res = await fetch(`/api/admin/preinscripciones/${id}`, {
    method: 'PATCH',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ estado })
  });
  const data = await res.json();
  if (!res.ok) {
    alert(data.mensaje || 'No se pudo actualizar el estado.');
    return;
  }
  if (showCode && data.codigo_generado) {
    document.getElementById('generatedCode').textContent = data.codigo_generado;
    codeDialog.showModal();
  }
  await loadTable();
};

window.openEdit = function (payload) {
  const row = JSON.parse(decodeURIComponent(payload));
  editForm.id.value = row.id;
  editForm.nombre_completo.value = row.nombre_completo;
  editForm.celular.value = row.celular;
  editForm.sexo.value = row.sexo;
  editForm.estado.value = row.estado;
  editStatus.textContent = '';
  editDialog.showModal();
};

document.getElementById('cancelEdit').addEventListener('click', () => editDialog.close());
editForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(editForm);
  const payload = Object.fromEntries(fd.entries());
  const res = await fetch(`/api/admin/preinscripciones/${payload.id}`, {
    method: 'PATCH',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(payload)
  });
  const data = await res.json();
  if (!res.ok) {
    editStatus.textContent = data?.mensaje || data?.detalles?.celular || 'No se pudo guardar.';
    return;
  }
  editDialog.close();
  if (data.codigo_generado) {
    document.getElementById('generatedCode').textContent = data.codigo_generado;
    codeDialog.showModal();
  }
  await loadTable();
});

window.removeRow = async function (id, nombre) {
  const first = confirm(`¿Eliminar el registro de ${nombre}?`);
  if (!first) return;
  const second = confirm('Confirmación final: esta acción ocultará el registro del panel.');
  if (!second) return;
  const res = await fetch(`/api/admin/preinscripciones/${id}`, { method: 'DELETE', headers: authHeaders() });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    alert(data.mensaje || 'No se pudo eliminar.');
    return;
  }
  await loadTable();
};

document.getElementById('applyFilters').addEventListener('click', () => {
  adminState.page = 1;
  adminState.filters = {
    sexo: document.getElementById('filterSexo').value,
    estado: document.getElementById('filterEstado').value,
    fecha_desde: document.getElementById('filterDesde').value,
    fecha_hasta: document.getElementById('filterHasta').value,
    q: document.getElementById('filterQ').value.trim()
  };
  loadTable();
});

document.getElementById('clearFilters').addEventListener('click', () => {
  document.getElementById('filterSexo').value = '';
  document.getElementById('filterEstado').value = '';
  document.getElementById('filterDesde').value = '';
  document.getElementById('filterHasta').value = '';
  document.getElementById('filterQ').value = '';
  adminState.page = 1;
  adminState.filters = { sexo: '', estado: '', fecha_desde: '', fecha_hasta: '', q: '' };
  loadTable();
});

document.getElementById('prevPage').addEventListener('click', () => {
  if (adminState.page > 1) {
    adminState.page -= 1;
    loadTable();
  }
});
document.getElementById('nextPage').addEventListener('click', () => {
  if (adminState.page < adminState.totalPages) {
    adminState.page += 1;
    loadTable();
  }
});

document.getElementById('exportXlsx').addEventListener('click', () => downloadExport('/api/admin/export.xlsx', 'preinscripciones.xlsx'));
document.getElementById('exportCsv').addEventListener('click', () => downloadExport('/api/admin/export.csv', 'preinscripciones.csv'));

async function downloadExport(url, fallbackName) {
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) {
    alert('No se pudo generar la exportación.');
    return;
  }
  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const disposition = res.headers.get('Content-Disposition') || '';
  const match = disposition.match(/filename="([^"]+)"/);
  a.href = objectUrl;
  a.download = match?.[1] || fallbackName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(objectUrl);
}

async function loadConfig() {
  const res = await fetch('/api/admin/config', { headers: authHeaders() });
  const data = await res.json();
  const form = document.getElementById('configForm');
  form.EVENTO_NOMBRE.value = data.config.EVENTO_NOMBRE;
  form.EVENTO_FECHA.value = data.config.EVENTO_FECHA;
  form.MODO_INSCRIPCION.value = data.config.MODO_INSCRIPCION;
}

document.getElementById('configForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const payload = Object.fromEntries(fd.entries());
  const res = await fetch('/api/admin/config', {
    method: 'PATCH',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(payload)
  });
  const data = await res.json();
  document.getElementById('configStatus').textContent = res.ok ? 'Configuración guardada.' : (data.mensaje || 'No se pudo guardar.');
});

document.getElementById('passwordForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const payload = Object.fromEntries(fd.entries());
  const res = await fetch('/api/admin/change-password', {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(payload)
  });
  const data = await res.json();
  document.getElementById('passwordStatus').textContent = res.ok ? 'Contraseña actualizada.' : (data.mensaje || 'No se pudo actualizar la contraseña.');
  if (res.ok) e.target.reset();
});

async function loadLogs() {
  const res = await fetch('/api/admin/logs', { headers: authHeaders() });
  const data = await res.json();
  logsBody.innerHTML = data.rows.map(row => `<tr><td>${formatDate(row.created_at)}</td><td>${escapeHtml(row.ip_origen || '')}</td><td>${escapeHtml(row.tipo)}</td><td>${escapeHtml(row.user_agent || '')}</td></tr>`).join('') || '<tr><td colspan="4">Sin logs todavía.</td></tr>';
}

function bindTabs() {
  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
      if (btn.dataset.tab === 'configuracion' && adminState.token) loadLogs();
    });
  });
}

bootstrapAdmin();

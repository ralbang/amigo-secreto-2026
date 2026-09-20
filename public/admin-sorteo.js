const S = { token: sessionStorage.getItem('admin_token') || '', csrf: '', cierreHabilitado: false };

const loginView = document.getElementById('loginView');
const boardView = document.getElementById('boardView');

function h(extra = {}) {
  return { ...extra, 'Authorization': `Bearer ${S.token}`, 'x-csrf-token': S.csrf };
}

async function boot() {
  const r = await fetch('/api/csrf-token').then(x => x.json()).catch(() => null);
  if (r) S.csrf = r.csrfToken;
  if (S.token) {
    loginView.classList.add('hidden');
    boardView.classList.remove('hidden');
    await refresh();
  }
}

document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const res = await fetch('/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-csrf-token': S.csrf },
    body: JSON.stringify({ usuario: fd.get('usuario'), password: fd.get('password') })
  });
  const data = await res.json();
  if (!res.ok) {
    document.getElementById('loginStatus').textContent = data.mensaje || 'No fue posible iniciar sesión.';
    return;
  }
  S.token = data.token;
  sessionStorage.setItem('admin_token', data.token);
  loginView.classList.add('hidden');
  boardView.classList.remove('hidden');
  await refresh();
});

document.getElementById('logoutBtn').addEventListener('click', async () => {
  await fetch('/api/admin/logout', { method: 'POST', headers: h() }).catch(() => {});
  sessionStorage.removeItem('admin_token');
  S.token = '';
  boardView.classList.add('hidden');
  loginView.classList.remove('hidden');
});

async function refresh() {
  const res = await fetch('/api/admin/sorteo/tablero', { headers: h() });
  if (res.status === 401) {
    S.token = '';
    sessionStorage.removeItem('admin_token');
    boardView.classList.add('hidden');
    loginView.classList.remove('hidden');
    return;
  }
  const data = await res.json();
  const p = data.progreso;
  document.getElementById('progresoTitulo').textContent = `Van ${p.completados} de ${p.total} 💕`;
  document.getElementById('progresoSub').textContent =
    `Grupo A: ${p.grupoA.completados}/${p.grupoA.total} · Grupo B: ${p.grupoB.completados}/${p.grupoB.total} · texto para compartir: "${p.texto_compartible}"`;

  document.getElementById('lightsGrid').innerHTML = data.luces.map(l => `
    <div class="light-card ${l.encendida ? 'on' : 'off'}">
      <span class="light-bulb">${l.encendida ? '💡' : '⚪'}</span>
      <span class="light-code">${l.codigo}</span>
      <span class="light-state">${l.encendida ? 'Ya escogió' : (l.giros_usados >= 2 ? 'En giro definitivo' : l.giros_usados === 0 ? 'Sin girar' : `Ensayo ${l.giros_usados}/2`)}</span>
    </div>`).join('');

  S.cierreHabilitado = data.cierre_habilitado;
  document.getElementById('cierreTexto').value = data.mensaje_cierre || '';
  document.getElementById('cierreEstado').textContent = data.cierre_habilitado
    ? '✅ Las 36 luces están encendidas: ya puedes copiar y enviar el mensaje de cierre.'
    : `⏳ El texto de cierre se habilita cuando las 36 luces estén encendidas (faltan ${p.pendientes}).`;

  const audit = await fetch('/api/admin/sorteo/auditoria', { headers: h() }).then(r => r.json());
  document.getElementById('auditBody').innerHTML = audit.asignaciones.map(a => `
    <tr><td>${a.sorteo}</td><td>${a.total}</td><td>${a.destinos_unicos}</td><td>${a.biyeccion_ok ? '✅ 1 a 1' : '❌'}</td><td>${a.revelados}</td></tr>
  `).join('');
  document.getElementById('auditNote').textContent = `Emparejamiento legible en la base de datos: ${audit.emparejamiento_en_texto_plano} · Huella de clave: ${audit.key_id}`;
}

document.getElementById('refreshBtn').addEventListener('click', refresh);
document.getElementById('linksXlsx').addEventListener('click', () => dl('/api/admin/sorteo/enlaces.xlsx', 'enlaces-sorteo.xlsx'));
document.getElementById('linksCsv').addEventListener('click', () => dl('/api/admin/sorteo/enlaces.csv', 'enlaces-sorteo.csv'));

async function dl(url, fallback) {
  const res = await fetch(url, { headers: h() });
  if (!res.ok) { alert('No se pudo generar la descarga.'); return; }
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const m = (res.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/);
  a.download = m?.[1] || fallback;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);
}

document.getElementById('saveCierre').addEventListener('click', async () => {
  const res = await fetch('/api/admin/sorteo/cierre', {
    method: 'PATCH',
    headers: h({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ mensaje_cierre: document.getElementById('cierreTexto').value })
  });
  document.getElementById('cierreNote').textContent = res.ok ? 'Mensaje guardado.' : 'No se pudo guardar.';
});

document.getElementById('copyCierre').addEventListener('click', async () => {
  if (!S.cierreHabilitado) {
    document.getElementById('cierreNote').textContent = 'Aún no: las 36 luces deben estar encendidas para habilitar el texto de cierre.';
    return;
  }
  try {
    await navigator.clipboard.writeText(document.getElementById('cierreTexto').value);
    document.getElementById('cierreNote').textContent = 'Mensaje copiado. Ya puedes pegarlo en tu grupo. 💕';
  } catch {
    document.getElementById('cierreNote').textContent = 'No se pudo copiar; selecciona el texto manualmente.';
  }
});

boot();

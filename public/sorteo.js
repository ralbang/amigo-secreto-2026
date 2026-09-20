const token = location.pathname.split('/').filter(Boolean).pop();
const SEGMENTS = 18;
const PALETTE = ['#ffd9e8','#ffe8f0','#ffcfe0','#fff2f7','#ffdceb','#ffe3ef','#ffd3e4','#fff0f5','#ffdae9'];
let state = { csrf: '', locked: false, spinning: false, current: 0, assignmentIndex: 0, result: null };

const wheelGroup = document.getElementById('wheelGroup');
const wheelEl = document.getElementById('wheel');
const giraBtn = document.getElementById('giraBtn');
const spinNote = document.getElementById('spinNote');
const giroNum = document.getElementById('giroNum');
const hubText = document.getElementById('hubText');

function polar(cx, cy, r, deg) {
  const rad = (deg - 90) * Math.PI / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function buildWheel(codes) {
  const cx = 200, cy = 200, r = 178;
  const step = 360 / SEGMENTS;
  let svg = '';
  codes.forEach((code, i) => {
    const a0 = i * step, a1 = (i + 1) * step;
    const p0 = polar(cx, cy, r, a0), p1 = polar(cx, cy, r, a1);
    const large = step > 180 ? 1 : 0;
    svg += `<path d="M ${cx} ${cy} L ${p0.x.toFixed(2)} ${p0.y.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${p1.x.toFixed(2)} ${p1.y.toFixed(2)} Z"
             fill="${PALETTE[i % PALETTE.length]}" stroke="#ffffff" stroke-width="2.4" data-code="${code}"></path>`;
    const mid = a0 + step / 2;
    const lp = polar(cx, cy, r * 0.66, mid);
    const rotate = mid + 90;
    svg += `<text class="seg-label" x="${lp.x.toFixed(2)}" y="${lp.y.toFixed(2)}" text-anchor="middle" dominant-baseline="middle"
             transform="rotate(${rotate.toFixed(2)} ${lp.x.toFixed(2)} ${lp.y.toFixed(2)})">${code}</text>`;
  });
  wheelGroup.innerHTML = svg;
}

async function bootstrap() {
  paintHearts();
  const csrfRes = await fetch('/api/csrf-token').then(r => r.json()).catch(() => null);
  if (csrfRes) state.csrf = csrfRes.csrfToken;
  const res = await fetch(`/api/sorteo/${token}`);
  if (!res.ok) {
    document.querySelector('.wheel-card').innerHTML = '<div class="error-box">❌ Este enlace no es válido o fue desactivado.</div>';
    return;
  }
  const data = await res.json();
  window.__data = data;
  buildWheel(data.rueda);
  document.getElementById('yoInfo').textContent = `Te toca girar como ${data.yo.codigo} (Grupo ${data.yo.grupo}).`;
  giroNum.textContent = data.giros_usados;
  if (data.bloqueado) {
    lockUI(data.resultado);
  } else {
    giraBtn.disabled = false;
    if (data.giros_usados === 2) spinNote.textContent = 'Este será tu giro DEFINITIVO 🎀';
  }
  if (data.mensaje_cierre) {
    document.getElementById('cierreCard').classList.remove('hidden');
    document.getElementById('cierreTexto').textContent = data.mensaje_cierre;
  }
}

function lockUI(resultado) {
  state.locked = true;
  giraBtn.disabled = true;
  giraBtn.textContent = '🔒 Ya escogiste';
  document.getElementById('lockedNote').classList.remove('hidden');
  if (resultado) showResult(resultado, true);
}

giraBtn.addEventListener('click', async () => {
  if (state.spinning || state.locked) return;
  state.spinning = true;
  giraBtn.disabled = true;
  spinNote.textContent = 'Girando… 🎡';
  hubText.textContent = '✨';

  const res = await fetch(`/api/sorteo/${token}/girar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-csrf-token': state.csrf },
    body: JSON.stringify({})
  });
  const data = await res.json();

  if (!res.ok && data.error === 'bloqueado') {
    lockUI(data.resultado);
    spinNote.textContent = 'Ya escogiste';
    state.spinning = false;
    return;
  }
  if (!res.ok) {
    spinNote.textContent = data.mensaje || 'No fue posible girar. Intenta de nuevo.';
    giraBtn.disabled = false;
    state.spinning = false;
    return;
  }

  spinTo(data.segmento - 1, () => {
    state.spinning = false;
    hubText.textContent = data.definitivo ? '💝' : '🍀';
    giroNum.textContent = data.giro;
    showResult(data.resultado, data.definitivo);
    if (data.definitivo) {
      lockUI(data.resultado);
      spinNote.textContent = 'Giro definitivo completado. ¡Ya escogiste! 💕';
    } else {
      giraBtn.disabled = false;
      spinNote.textContent = `Ensayo ${data.giro} de 2. Te quedan ${data.giros_restantes} giro(s) antes del definitivo.`;
    }
  });
});

function spinTo(segmentIndex, done) {
  const step = 360 / SEGMENTS;
  const targetCenter = segmentIndex * step + step / 2;
  const desired = 360 - targetCenter;
  const turns = 6;
  state.assignmentIndex = segmentIndex;
  const base = (state.current % 360 + 360) % 360;
  const target = turns * 360 + desired + (base > desired ? 360 : 0);
  state.current = target;
  wheelEl.style.transform = `rotate(${target}deg)`;
  setTimeout(done, 5400);
}

function showResult(r, definitivo) {
  state.result = r;
  const card = document.getElementById('resultCard');
  card.classList.remove('hidden');
  document.getElementById('resultTitle').textContent = definitivo ? '🎀 Tu amigo secreto es…' : '🍀 Resultado de ensayo';
  document.getElementById('resultAviso').textContent = definitivo
    ? 'Este es tu resultado DEFINITIVO y quedó guardado con tu enlace personal.'
    : (r.aviso || 'ENSAYO · datos ficticios, sin efecto real.');
  document.getElementById('resultCodigo').textContent = `Código: ${r.codigo}`;
  document.getElementById('resultNombre').textContent = r.nombre;
  document.getElementById('resultCelular').textContent = r.celular ? `📱 ${r.celular}` : '📱 (sin celular registrado)';
  card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function waMessage() {
  const r = state.result;
  if (!r) return '';
  const definitivo = r.ensayo === false;
  const head = definitivo ? '🎀 Mi Amigo Secreto 2026' : '🍀 Ensayo de mi rueda (resultado ficticio)';
  return encodeURIComponent(`${head}\nCódigo: ${r.codigo}\nNombre: ${r.nombre}\nCelular: ${r.celular || 'sin celular'}${definitivo ? '\n\n¡Feliz Día del Amor y la Amistad! 💕' : ''}`);
}

document.getElementById('waBtn').addEventListener('click', () => {
  const msg = waMessage();
  if (!msg) return;
  window.open(`https://wa.me/?text=${msg}`, '_blank');
});
document.getElementById('copyBtn').addEventListener('click', async () => {
  if (!state.result) return;
  const r = state.result;
  const text = `Código: ${r.codigo} · Nombre: ${r.nombre} · Celular: ${r.celular || 'sin celular'}`;
  try {
    await navigator.clipboard.writeText(text);
    spinNote.textContent = 'Resultado copiado ✅';
  } catch {
    spinNote.textContent = 'No se pudo copiar. Selecciona el texto manualmente.';
  }
});

function paintHearts() {
  const box = document.querySelector('.hearts-bg');
  const icons = ['💕','💖','💗','💝','🌹','🌸','💐','✨'];
  for (let i = 0; i < 18; i++) {
    const s = document.createElement('span');
    s.textContent = icons[i % icons.length];
    s.style.left = `${Math.random() * 100}%`;
    s.style.animationDelay = `${Math.random() * 9}s`;
    s.style.animationDuration = `${9 + Math.random() * 9}s`;
    s.style.fontSize = `${17 + Math.random() * 20}px`;
    box.appendChild(s);
  }
}

bootstrap();

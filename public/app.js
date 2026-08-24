const state = { csrfToken: '' };
const form = document.getElementById('preinscripcionForm');
const statusMsg = document.getElementById('statusMsg');
const formCard = document.getElementById('formCard');
const successCard = document.getElementById('successCard');
const successText = document.getElementById('successText');
const resetBtn = document.getElementById('resetBtn');
const celularInput = document.getElementById('celular');

async function bootstrap() {
  const [csrfRes, configRes] = await Promise.all([
    fetch('/api/csrf-token').then(r => r.json()),
    fetch('/api/public-config').then(r => r.json())
  ]);
  state.csrfToken = csrfRes.csrfToken;
  if (configRes.ok) {
    document.getElementById('eventoNombre').textContent = configRes.EVENTO_NOMBRE;
    document.getElementById('eventoFecha').textContent = new Date(configRes.EVENTO_FECHA + 'T00:00:00').toLocaleDateString('es-CO', { dateStyle: 'long' });
    if (configRes.MODO_INSCRIPCION !== 'on') {
      form.innerHTML = '<p class="closed-box">💌 Las preinscripciones están pausadas por el momento. Vuelve pronto.</p>';
    }
  }
  paintHearts();
}

function normalizeCelular(value) {
  const digits = String(value).replace(/\D/g, '');
  if (digits.startsWith('57') && digits.length === 12) return digits.slice(2);
  if (digits.startsWith('057') && digits.length === 13) return digits.slice(3);
  return digits;
}

function validateForm() {
  const nombre = form.nombre_completo.value.replace(/[\u0000-\u001F\u007F]/g, '').trim().replace(/\s+/g, ' ');
  const celular = normalizeCelular(form.celular.value);
  const sexo = form.querySelector('input[name="sexo"]:checked')?.value || '';
  const errors = {};
  if (nombre.length < 3 || nombre.length > 120) errors.nombre = 'Escribe un nombre válido de 3 a 120 caracteres.';
  if (!/^3\d{9}$/.test(celular)) errors.celular = 'Debe tener 10 dígitos y empezar por 3.';
  if (!['H', 'M'].includes(sexo)) errors.sexo = 'Selecciona una opción.';
  document.getElementById('error-nombre').textContent = errors.nombre || '';
  document.getElementById('error-celular').textContent = errors.celular || '';
  document.getElementById('error-sexo').textContent = errors.sexo || '';
  return { ok: Object.keys(errors).length === 0, nombre, celular, sexo };
}

celularInput.addEventListener('blur', () => {
  const normalized = normalizeCelular(celularInput.value);
  celularInput.value = normalized;
  document.getElementById('error-celular').textContent = /^3\d{9}$/.test(normalized) ? '' : 'Debe tener 10 dígitos y empezar por 3.';
});

form?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const checked = validateForm();
  if (!checked.ok) return;
  statusMsg.textContent = 'Enviando tu preinscripción...';
  const submitBtn = document.getElementById('submitBtn');
  submitBtn.disabled = true;
  try {
    const res = await fetch('/api/preinscripciones', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-csrf-token': state.csrfToken
      },
      body: JSON.stringify({
        nombre_completo: checked.nombre,
        celular: checked.celular,
        sexo: checked.sexo,
        website: form.website.value || ''
      })
    });
    const data = await res.json();
    if (res.status === 201) {
      formCard.classList.add('hidden');
      successCard.classList.remove('hidden');
      successText.textContent = `¡Listo, ${checked.nombre}! 💕 Tu preinscripción quedó registrada. Te contactaremos para confirmar el pago.`;
      launchConfetti();
      form.reset();
      statusMsg.textContent = '';
      return;
    }
    if (res.status === 409) {
      statusMsg.textContent = 'Este celular ya está preinscrito. Si necesitas ayuda, contacta al administrador.';
      return;
    }
    if (res.status === 429) {
      statusMsg.textContent = 'Estás enviando muchos registros seguidos. Espera un momento 💕';
      return;
    }
    if (data?.detalles?.celular) document.getElementById('error-celular').textContent = data.detalles.celular;
    if (data?.detalles?.nombre_completo) document.getElementById('error-nombre').textContent = data.detalles.nombre_completo;
    if (data?.detalles?.sexo) document.getElementById('error-sexo').textContent = data.detalles.sexo;
    statusMsg.textContent = data?.mensaje || 'No se pudo registrar la preinscripción.';
  } catch {
    statusMsg.textContent = 'No fue posible conectar con el servidor. Inténtalo de nuevo.';
  } finally {
    submitBtn.disabled = false;
  }
});

resetBtn?.addEventListener('click', () => {
  successCard.classList.add('hidden');
  formCard.classList.remove('hidden');
  statusMsg.textContent = '';
  form.nombre_completo.focus();
});

function paintHearts() {
  const container = document.querySelector('.floating-hearts');
  if (!container) return;
  const icons = ['💕', '💖', '💗', '💝', '🌹', '🌸', '💐', '✨'];
  for (let i = 0; i < 20; i++) {
    const span = document.createElement('span');
    span.className = 'floaty';
    span.textContent = icons[i % icons.length];
    span.style.left = `${Math.random() * 100}%`;
    span.style.animationDelay = `${Math.random() * 8}s`;
    span.style.animationDuration = `${8 + Math.random() * 10}s`;
    span.style.fontSize = `${18 + Math.random() * 20}px`;
    container.appendChild(span);
  }
}

function launchConfetti() {
  const zone = document.querySelector('.confetti-zone');
  zone.innerHTML = '';
  const icons = ['💖', '✨', '🌸', '💕', '💝'];
  for (let i = 0; i < 32; i++) {
    const bit = document.createElement('span');
    bit.className = 'confetti';
    bit.textContent = icons[i % icons.length];
    bit.style.left = `${Math.random() * 100}%`;
    bit.style.animationDelay = `${Math.random() * 0.9}s`;
    zone.appendChild(bit);
  }
}

bootstrap();

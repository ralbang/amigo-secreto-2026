const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const ExcelJS = require('exceljs');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function loadEnvFile() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    if (!line || line.trim().startsWith('#') || !line.includes('=')) continue;
    const idx = line.indexOf('=');
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadEnvFile();

const PORT = Number(process.env.PORT || 3000);
const DB_PATH = path.resolve(ROOT, process.env.DB_PATH || './data/amigo-secreto.db');
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin12345';
const EVENTO_NOMBRE = process.env.EVENTO_NOMBRE || 'Amigo Secreto – Día del Amor y la Amistad 🇨🇴 2026';
const EVENTO_FECHA = process.env.EVENTO_FECHA || '2026-09-19';
const MODO_INSCRIPCION = (process.env.MODO_INSCRIPCION || 'on').toLowerCase();

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function nowBogota() {
  const dtf = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'America/Bogota',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
  const parts = Object.fromEntries(dtf.formatToParts(new Date()).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function sanitizeName(name = '') {
  return String(name)
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeCelular(input = '') {
  const digits = String(input).replace(/\D/g, '');
  if (digits.startsWith('57') && digits.length === 12) return digits.slice(2);
  if (digits.startsWith('057') && digits.length === 13) return digits.slice(3);
  return digits;
}

function validatePreinscripcion(payload) {
  const errores = {};
  const nombre = sanitizeName(payload.nombre_completo);
  const celular = normalizeCelular(payload.celular);
  const sexo = String(payload.sexo || '').trim().toUpperCase();
  const comentario = payload.comentario ? String(payload.comentario).replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, 255) : null;

  if (!nombre || nombre.length < 3 || nombre.length > 120) {
    errores.nombre_completo = 'Debe tener entre 3 y 120 caracteres';
  }
  if (!/^3\d{9}$/.test(celular)) {
    errores.celular = 'Debe tener 10 dígitos y empezar por 3';
  }
  if (!['H', 'M'].includes(sexo)) {
    errores.sexo = 'Selecciona Hombre o Mujer';
  }

  return {
    ok: Object.keys(errores).length === 0,
    errores,
    data: { nombre_completo: nombre, celular, sexo, comentario }
  };
}

function generateAccessCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 6; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim().slice(0, 45);
  return (req.ip || req.socket?.remoteAddress || '').slice(0, 45);
}

function setConfigDefaults() {
  const stmt = db.prepare('INSERT OR IGNORE INTO configuracion (clave, valor, updated_at) VALUES (?, ?, ?)');
  const ts = nowBogota();
  stmt.run('EVENTO_NOMBRE', EVENTO_NOMBRE, ts);
  stmt.run('EVENTO_FECHA', EVENTO_FECHA, ts);
  stmt.run('MODO_INSCRIPCION', MODO_INSCRIPCION, ts);
}

function getConfig() {
  const rows = db.prepare('SELECT clave, valor FROM configuracion').all();
  const cfg = Object.fromEntries(rows.map(r => [r.clave, r.valor]));
  return {
    EVENTO_NOMBRE: cfg.EVENTO_NOMBRE || EVENTO_NOMBRE,
    EVENTO_FECHA: cfg.EVENTO_FECHA || EVENTO_FECHA,
    MODO_INSCRIPCION: cfg.MODO_INSCRIPCION || MODO_INSCRIPCION
  };
}

function logEvent(tipo, req, detalle = {}) {
  db.prepare(`INSERT INTO audit_logs (tipo, detalle_json, ip_origen, user_agent, created_at)
              VALUES (?, ?, ?, ?, ?)`)
    .run(tipo, JSON.stringify(detalle), getClientIp(req), String(req.headers['user-agent'] || '').slice(0, 255), nowBogota());
}

function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS preinscripciones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre_completo VARCHAR(120) NOT NULL,
      celular VARCHAR(15) NOT NULL UNIQUE,
      sexo CHAR(1) NOT NULL CHECK (sexo IN ('H','M')),
      comentario VARCHAR(255),
      ip_origen VARCHAR(45),
      user_agent VARCHAR(255),
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      origen VARCHAR(20) NOT NULL DEFAULT 'web',
      estado VARCHAR(20) NOT NULL DEFAULT 'pendiente',
      deleted_at TIMESTAMP NULL
    );

    CREATE INDEX IF NOT EXISTS idx_preinscripciones_estado ON preinscripciones(estado);
    CREATE INDEX IF NOT EXISTS idx_preinscripciones_sexo ON preinscripciones(sexo);
    CREATE INDEX IF NOT EXISTS idx_preinscripciones_created_at ON preinscripciones(created_at);

    CREATE TABLE IF NOT EXISTS administradores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      usuario VARCHAR(40) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL,
      created_at TIMESTAMP NOT NULL
    );

    CREATE TABLE IF NOT EXISTS codigos_acceso (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      preinscripcion_id INTEGER NOT NULL UNIQUE,
      codigo VARCHAR(6) NOT NULL UNIQUE,
      created_at TIMESTAMP NOT NULL,
      FOREIGN KEY (preinscripcion_id) REFERENCES preinscripciones(id)
    );

    CREATE TABLE IF NOT EXISTS configuracion (
      clave VARCHAR(50) PRIMARY KEY,
      valor VARCHAR(255) NOT NULL,
      updated_at TIMESTAMP NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tipo VARCHAR(50) NOT NULL,
      detalle_json TEXT,
      ip_origen VARCHAR(45),
      user_agent VARCHAR(255),
      created_at TIMESTAMP NOT NULL
    );
  `);

  setConfigDefaults();

  const totalAdmins = db.prepare('SELECT COUNT(*) AS total FROM administradores').get().total;
  if (!totalAdmins) {
    const hash = bcrypt.hashSync(ADMIN_PASS, 12);
    db.prepare('INSERT INTO administradores (usuario, password_hash, created_at) VALUES (?, ?, ?)')
      .run(ADMIN_USER, hash, nowBogota());
  }
}
initDb();

const app = express();
app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      fontSrc: ["'self'", 'data:']
    }
  }
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use('/static', express.static(path.join(ROOT, 'public')));

const publicLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    return res.status(429).json({
      ok: false,
      error: 'rate_limit',
      mensaje: 'Estás enviando muchos registros seguidos. Espera un momento 💕'
    });
  }
});

function requireCsrf(req, res, next) {
  const cookieToken = req.cookies.csrf_token;
  const headerToken = req.headers['x-csrf-token'] || req.body.csrf_token;
  if (!cookieToken || !headerToken || cookieToken !== headerToken) {
    return res.status(403).json({ ok: false, error: 'csrf', mensaje: 'Token CSRF inválido' });
  }
  next();
}

function requireAuth(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : req.cookies.admin_token;
  if (!token) return res.status(401).json({ ok: false, error: 'unauthorized' });
  try {
    req.admin = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    return next();
  } catch {
    return res.status(401).json({ ok: false, error: 'token_invalido' });
  }
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'amigo-secreto-2026', now: nowBogota() });
});

app.get('/api/csrf-token', (req, res) => {
  const token = crypto.randomBytes(24).toString('hex');
  res.cookie('csrf_token', token, {
    sameSite: 'lax',
    secure: false,
    httpOnly: false,
    maxAge: 8 * 60 * 60 * 1000
  });
  res.json({ ok: true, csrfToken: token });
});

app.get('/api/public-config', (req, res) => {
  res.json({ ok: true, ...getConfig() });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(ROOT, 'public', 'index.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(ROOT, 'public', 'admin.html'));
});

app.post('/api/preinscripciones', publicLimiter, requireCsrf, (req, res) => {
  const cfg = getConfig();
  if ((cfg.MODO_INSCRIPCION || 'on') !== 'on') {
    return res.status(403).json({ ok: false, error: 'formulario_cerrado', mensaje: 'Las preinscripciones están cerradas por el momento.' });
  }

  if (req.body.website && String(req.body.website).trim() !== '') {
    logEvent('honeypot_block', req, { motivo: 'website_llenado' });
    return res.status(200).json({ ok: true });
  }

  const parsed = validatePreinscripcion(req.body);
  if (!parsed.ok) {
    logEvent('validacion_error', req, { errores: parsed.errores });
    return res.status(400).json({ ok: false, error: 'validacion', detalles: parsed.errores });
  }

  const duplicate = db.prepare('SELECT id FROM preinscripciones WHERE celular = ?').get(parsed.data.celular);
  if (duplicate) {
    logEvent('duplicado', req, { celular: parsed.data.celular });
    return res.status(409).json({
      ok: false,
      error: 'duplicado',
      mensaje: 'Este celular ya está preinscrito. Si necesitas actualizar tus datos, contacta al administrador.'
    });
  }

  const info = db.prepare(`
    INSERT INTO preinscripciones
      (nombre_completo, celular, sexo, comentario, ip_origen, user_agent, created_at, origen, estado)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'web', 'pendiente')
  `).run(
    parsed.data.nombre_completo,
    parsed.data.celular,
    parsed.data.sexo,
    parsed.data.comentario,
    getClientIp(req),
    String(req.headers['user-agent'] || '').slice(0, 255),
    nowBogota()
  );

  logEvent('preinscripcion_ok', req, { id: info.lastInsertRowid, celular: parsed.data.celular });
  return res.status(201).json({ ok: true, id: info.lastInsertRowid, mensaje: '¡Preinscripción registrada!' });
});

app.post('/api/admin/login', requireCsrf, (req, res) => {
  const usuario = String(req.body.usuario || '').trim();
  const password = String(req.body.password || '');
  const admin = db.prepare('SELECT * FROM administradores WHERE usuario = ?').get(usuario);
  if (!admin || !bcrypt.compareSync(password, admin.password_hash)) {
    logEvent('login_fallido', req, { usuario });
    return res.status(401).json({ ok: false, error: 'credenciales_invalidas', mensaje: 'Usuario o contraseña incorrectos' });
  }
  const token = jwt.sign({ sub: admin.id, usuario: admin.usuario }, JWT_SECRET, { algorithm: 'HS256', expiresIn: '8h' });
  logEvent('login_ok', req, { usuario });
  res.json({ ok: true, token, usuario: admin.usuario, expira_en: '8h' });
});

app.post('/api/admin/logout', requireAuth, (req, res) => {
  logEvent('logout_ok', req, { usuario: req.admin.usuario });
  res.json({ ok: true });
});

app.get('/api/admin/preinscripciones', requireAuth, (req, res) => {
  const page = Math.max(1, parseInt(req.query.page || '1', 10));
  const perPage = Math.min(100, Math.max(1, parseInt(req.query.per_page || '25', 10)));
  const offset = (page - 1) * perPage;
  const conditions = ['deleted_at IS NULL'];
  const params = [];

  if (req.query.sexo && ['H', 'M'].includes(String(req.query.sexo))) {
    conditions.push('sexo = ?');
    params.push(String(req.query.sexo));
  }
  if (req.query.estado && ['pendiente', 'confirmado_pago', 'rechazado', 'asignado'].includes(String(req.query.estado))) {
    conditions.push('estado = ?');
    params.push(String(req.query.estado));
  }
  if (req.query.q) {
    conditions.push('(LOWER(nombre_completo) LIKE ? OR celular LIKE ?)');
    const term = `%${String(req.query.q).toLowerCase()}%`;
    params.push(term, `%${String(req.query.q).replace(/\D/g, '')}%`);
  }
  if (req.query.fecha_desde) {
    conditions.push('date(created_at) >= date(?)');
    params.push(String(req.query.fecha_desde));
  }
  if (req.query.fecha_hasta) {
    conditions.push('date(created_at) <= date(?)');
    params.push(String(req.query.fecha_hasta));
  }

  const where = `WHERE ${conditions.join(' AND ')}`;
  const total = db.prepare(`SELECT COUNT(*) AS total FROM preinscripciones ${where}`).get(...params).total;
  const rows = db.prepare(`
    SELECT p.*, c.codigo AS codigo_acceso
    FROM preinscripciones p
    LEFT JOIN codigos_acceso c ON c.preinscripcion_id = p.id
    ${where}
    ORDER BY p.created_at DESC, p.id DESC
    LIMIT ? OFFSET ?
  `).all(...params, perPage, offset);

  const stats = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN sexo='H' THEN 1 ELSE 0 END) AS hombres,
      SUM(CASE WHEN sexo='M' THEN 1 ELSE 0 END) AS mujeres,
      SUM(CASE WHEN estado='confirmado_pago' THEN 1 ELSE 0 END) AS pagados,
      SUM(CASE WHEN estado='pendiente' THEN 1 ELSE 0 END) AS pendientes
    FROM preinscripciones
    WHERE deleted_at IS NULL
  `).get();

  res.json({
    ok: true,
    rows,
    meta: { page, per_page: perPage, total, total_pages: Math.max(1, Math.ceil(total / perPage)) },
    stats
  });
});

app.patch('/api/admin/preinscripciones/:id', requireAuth, requireCsrf, (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM preinscripciones WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!existing) return res.status(404).json({ ok: false, error: 'no_encontrado' });

  const payload = {
    nombre_completo: req.body.nombre_completo ?? existing.nombre_completo,
    celular: req.body.celular ?? existing.celular,
    sexo: req.body.sexo ?? existing.sexo,
    comentario: req.body.comentario ?? existing.comentario
  };
  const parsed = validatePreinscripcion(payload);
  if (!parsed.ok) {
    return res.status(400).json({ ok: false, error: 'validacion', detalles: parsed.errores });
  }

  const nuevoEstado = req.body.estado ? String(req.body.estado) : existing.estado;
  if (!['pendiente', 'confirmado_pago', 'rechazado', 'asignado'].includes(nuevoEstado)) {
    return res.status(400).json({ ok: false, error: 'validacion', detalles: { estado: 'Estado inválido' } });
  }

  const dup = db.prepare('SELECT id FROM preinscripciones WHERE celular = ? AND id <> ?').get(parsed.data.celular, id);
  if (dup) {
    return res.status(409).json({
      ok: false,
      error: 'duplicado',
      mensaje: 'Este celular ya está preinscrito. Si necesitas actualizar tus datos, contacta al administrador.'
    });
  }

  db.prepare(`
    UPDATE preinscripciones
    SET nombre_completo = ?, celular = ?, sexo = ?, comentario = ?, estado = ?
    WHERE id = ?
  `).run(parsed.data.nombre_completo, parsed.data.celular, parsed.data.sexo, parsed.data.comentario, nuevoEstado, id);

  let generatedCode = null;
  if (nuevoEstado === 'confirmado_pago') {
    const current = db.prepare('SELECT codigo FROM codigos_acceso WHERE preinscripcion_id = ?').get(id);
    if (!current) {
      while (!generatedCode) {
        const candidate = generateAccessCode();
        try {
          db.prepare('INSERT INTO codigos_acceso (preinscripcion_id, codigo, created_at) VALUES (?, ?, ?)').run(id, candidate, nowBogota());
          generatedCode = candidate;
        } catch {}
      }
    } else {
      generatedCode = current.codigo;
    }
  }

  logEvent('admin_update', req, { id, estado: nuevoEstado });
  const updated = db.prepare(`
    SELECT p.*, c.codigo AS codigo_acceso
    FROM preinscripciones p
    LEFT JOIN codigos_acceso c ON c.preinscripcion_id = p.id
    WHERE p.id = ?
  `).get(id);
  res.json({ ok: true, row: updated, codigo_generado: generatedCode });
});

app.delete('/api/admin/preinscripciones/:id', requireAuth, requireCsrf, (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT id FROM preinscripciones WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!existing) return res.status(404).json({ ok: false, error: 'no_encontrado' });
  db.prepare('UPDATE preinscripciones SET deleted_at = ? WHERE id = ?').run(nowBogota(), id);
  logEvent('admin_delete', req, { id });
  res.json({ ok: true });
});

app.get('/api/admin/export.csv', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT nombre_completo, celular, sexo, comentario, created_at, estado
    FROM preinscripciones
    WHERE deleted_at IS NULL
    ORDER BY created_at ASC, id ASC
  `).all();

  const escapeCsv = (v) => {
    const value = v == null ? '' : String(v);
    if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
    return value;
  };

  const header = ['nombre_completo', 'celular', 'sexo', 'comentario', 'created_at', 'estado'];
  const csv = [header.join(',')].concat(rows.map(row => header.map(k => escapeCsv(row[k])).join(','))).join('\n');
  const today = nowBogota().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="preinscripciones-${today}.csv"`);
  res.send('\uFEFF' + csv);
});

app.get('/api/admin/export.xlsx', requireAuth, async (req, res) => {
  const rows = db.prepare(`
    SELECT nombre_completo, celular, sexo, comentario, created_at, estado
    FROM preinscripciones
    WHERE deleted_at IS NULL
    ORDER BY created_at ASC, id ASC
  `).all();
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Preinscripciones');
  sheet.columns = [
    { header: 'nombre_completo', key: 'nombre_completo', width: 32 },
    { header: 'celular', key: 'celular', width: 16 },
    { header: 'sexo', key: 'sexo', width: 10 },
    { header: 'comentario', key: 'comentario', width: 30 },
    { header: 'created_at', key: 'created_at', width: 22 },
    { header: 'estado', key: 'estado', width: 18 }
  ];
  rows.forEach(r => sheet.addRow(r));
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  const today = nowBogota().slice(0, 10);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="preinscripciones-${today}.xlsx"`);
  await workbook.xlsx.write(res);
  res.end();
});

app.get('/api/admin/config', requireAuth, (req, res) => {
  res.json({ ok: true, config: getConfig() });
});

app.patch('/api/admin/config', requireAuth, requireCsrf, (req, res) => {
  const current = getConfig();
  const next = {
    EVENTO_NOMBRE: String(req.body.EVENTO_NOMBRE || current.EVENTO_NOMBRE).trim().slice(0, 120),
    EVENTO_FECHA: String(req.body.EVENTO_FECHA || current.EVENTO_FECHA).trim().slice(0, 10),
    MODO_INSCRIPCION: String(req.body.MODO_INSCRIPCION || current.MODO_INSCRIPCION).trim() === 'off' ? 'off' : 'on'
  };
  const stmt = db.prepare('INSERT INTO configuracion (clave, valor, updated_at) VALUES (?, ?, ?) ON CONFLICT(clave) DO UPDATE SET valor=excluded.valor, updated_at=excluded.updated_at');
  const ts = nowBogota();
  Object.entries(next).forEach(([k, v]) => stmt.run(k, v, ts));
  logEvent('config_update', req, next);
  res.json({ ok: true, config: next });
});

app.post('/api/admin/change-password', requireAuth, requireCsrf, (req, res) => {
  const actual = String(req.body.password_actual || '');
  const nueva = String(req.body.password_nueva || '');
  const repetir = String(req.body.password_nueva_2 || '');
  const admin = db.prepare('SELECT * FROM administradores WHERE id = ?').get(req.admin.sub);
  if (!admin || !bcrypt.compareSync(actual, admin.password_hash)) {
    return res.status(400).json({ ok: false, error: 'password_actual_invalida' });
  }
  if (nueva.length < 8 || nueva !== repetir) {
    return res.status(400).json({ ok: false, error: 'password_nueva_invalida' });
  }
  const hash = bcrypt.hashSync(nueva, 12);
  db.prepare('UPDATE administradores SET password_hash = ? WHERE id = ?').run(hash, admin.id);
  logEvent('password_change', req, { usuario: admin.usuario });
  res.json({ ok: true });
});

app.get('/api/admin/logs', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT created_at, ip_origen, user_agent, tipo, detalle_json FROM audit_logs ORDER BY id DESC LIMIT 100').all();
  res.json({ ok: true, rows });
});

app.use((req, res) => {
  res.status(404).json({ ok: false, error: 'not_found' });
});

app.listen(PORT, () => {
  console.log(`Servidor activo en http://localhost:${PORT}`);
  console.log(`Base de datos: ${DB_PATH}`);
});

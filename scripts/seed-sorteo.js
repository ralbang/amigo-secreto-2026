const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const Database = require('better-sqlite3');

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = process.env.DB_PATH ? path.resolve(ROOT, process.env.DB_PATH) : path.resolve(ROOT, 'data/amigo-secreto.db');
const FILE = path.resolve(process.argv.find(a => a.endsWith('.xlsx')) || path.join(ROOT, 'data/source/participantes-sorteo.xlsx'));
const FORCE = process.argv.includes('--force');
const db = new Database(DB_PATH);

const KEY_FILE = path.join(ROOT, 'data/.sorteo.key');
function loadKey() {
  const envKey = (process.env.SORTEO_SECRET_KEY || '').trim();
  if (/^[0-9a-fA-F]{64}$/.test(envKey)) return Buffer.from(envKey, 'hex');
  if (fs.existsSync(KEY_FILE)) {
    const raw = fs.readFileSync(KEY_FILE, 'utf8').trim();
    if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  }
  const key = crypto.randomBytes(32);
  fs.writeFileSync(KEY_FILE, key.toString('hex'));
  return key;
}
const KEY = loadKey();
const encrypt = (plain) => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([cipher.update(Buffer.from(plain, 'utf8')), cipher.final()]);
  return { c: enc.toString('base64'), i: iv.toString('base64'), t: cipher.getAuthTag().toString('base64') };
};
const decrypt = (r) => {
  const d = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(r.i, 'base64'));
  d.setAuthTag(Buffer.from(r.t, 'base64'));
  return Buffer.concat([d.update(Buffer.from(r.c, 'base64')), d.final()]).toString('utf8');
};
const bidx = (v) => crypto.createHmac('sha256', KEY).update('bidx:' + String(v)).digest('hex');
const thash = (t) => crypto.createHash('sha256').update('tok:' + String(t)).digest('hex');
function nowBogota() {
  const dtf = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const p = Object.fromEntries(dtf.formatToParts(new Date()).filter(x => x.type !== 'literal').map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

db.exec(`
  CREATE TABLE IF NOT EXISTS sorteo_participantes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, grupo CHAR(1) NOT NULL CHECK (grupo IN ('A','B')),
    numero INTEGER NOT NULL, sexo VARCHAR(2) NOT NULL, codigo VARCHAR(8) NOT NULL UNIQUE,
    nombre_completo VARCHAR(120) NOT NULL, celular VARCHAR(15),
    token_hash VARCHAR(64) NOT NULL UNIQUE, token_cipher TEXT NOT NULL, token_iv TEXT NOT NULL, token_tag TEXT NOT NULL,
    created_at TIMESTAMP NOT NULL, UNIQUE (grupo, numero));
  CREATE TABLE IF NOT EXISTS sorteo_asignaciones (
    id INTEGER PRIMARY KEY AUTOINCREMENT, sorteo CHAR(2) NOT NULL CHECK (sorteo IN ('AB','BA')),
    origen_id INTEGER NOT NULL, origen_grupo CHAR(1) NOT NULL,
    destino_bidx VARCHAR(64) NOT NULL, destino_cipher TEXT NOT NULL, destino_iv TEXT NOT NULL, destino_tag TEXT NOT NULL,
    segmento INTEGER NOT NULL, spins_used INTEGER NOT NULL DEFAULT 0, locked_at TIMESTAMP NULL,
    resultado_cipher TEXT, resultado_iv TEXT, resultado_tag TEXT,
    ensayo1_cipher TEXT, ensayo1_iv TEXT, ensayo1_tag TEXT, ensayo2_cipher TEXT, ensayo2_iv TEXT, ensayo2_tag TEXT,
    updated_at TIMESTAMP NOT NULL, UNIQUE (sorteo, origen_id), UNIQUE (sorteo, destino_bidx));
  CREATE INDEX IF NOT EXISTS idx_sorteo_asig_origen ON sorteo_asignaciones(sorteo, origen_id);
  CREATE INDEX IF NOT EXISTS idx_sorteo_part_grupo ON sorteo_participantes(grupo, numero);
`);

async function main() {
  const existing = db.prepare('SELECT COUNT(*) AS n FROM sorteo_participantes').get().n;
  if (existing > 0 && !FORCE) {
    console.log(JSON.stringify({ skipped: true, motivo: 'ya existen participantes; usa --force para regenerar', total: existing }, null, 2));
    return;
  }
  if (FORCE) {
    db.exec('DELETE FROM sorteo_asignaciones; DELETE FROM sorteo_participantes;');
  }

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(FILE);
  const ws = wb.worksheets[0];
  const A = [], B = [];
  for (let i = 2; i <= ws.rowCount; i++) {
    const row = ws.getRow(i);
    const cellText = (c) => {
      const v = row.getCell(c).value;
      if (v === null || v === undefined) return '';
      if (typeof v === 'object' && v.richText) return v.richText.map(r => r.text).join('');
      return String(v).trim();
    };
    const aNum = cellText(1), aSexo = cellText(2), aNombre = cellText(3), aCel = cellText(4);
    if (aNum && aNombre) A.push({ numero: parseInt(aNum, 10), sexo: aSexo, nombre: aNombre, celular: aCel });
    const bNum = cellText(7), bSexo = cellText(8), bNombre = cellText(9), bCel = cellText(10);
    if (bNum && bNombre) B.push({ numero: parseInt(bNum, 10), sexo: bSexo, nombre: bNombre, celular: bCel });
  }
  if (A.length === 0 || B.length === 0) throw new Error('No se pudieron leer los grupos del Excel');

  const mkCode = (p) => `${p.numero}-${(p.sexo || '?').toUpperCase()}`;
  const insPart = db.prepare(`INSERT INTO sorteo_participantes
    (grupo, numero, sexo, codigo, nombre_completo, celular, token_hash, token_cipher, token_iv, token_tag, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  const ids = { A: [], B: [] };
  const tokensByGroup = { A: [], B: [] };
  const ts = nowBogota();
  const tx = db.transaction(() => {
    for (const [grupo, list] of [['A', A], ['B', B]]) {
      for (const p of list) {
        const token = crypto.randomBytes(24).toString('base64url');
        const tok = encrypt(token);
        const info = insPart.run(grupo, p.numero, (p.sexo || '?').toUpperCase(), mkCode(p), p.nombre, p.celular || null,
          thash(token), tok.c, tok.i, tok.t, ts);
        ids[grupo].push({ id: info.lastInsertRowid, ...p, codigo: mkCode(p) });
        tokensByGroup[grupo].push({ token, codigo: mkCode(p), nombre: p.nombre });
      }
    }
  });
  tx();

  const shuffled = (arr) => {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = crypto.randomInt(i + 1);
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };

  const insAsig = db.prepare(`INSERT INTO sorteo_asignaciones
    (sorteo, origen_id, origen_grupo, destino_bidx, destino_cipher, destino_iv, destino_tag, segmento, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  // Sorteo AB (Grupo A -> Grupo B) y Sorteo BA (Grupo B -> Grupo A). Biyecciones independientes.
  const runs = [
    { sorteo: 'AB', grupo: 'A', origenes: ids.A, destinos: ids.B },
    { sorteo: 'BA', grupo: 'B', origenes: ids.B, destinos: ids.A }
  ];
  for (const run of runs) {
    const cycle = shuffled(run.destinos);
    if (cycle.length !== run.origenes.length) throw new Error(`Tamaños distintos en sorteo ${run.sorteo}`);
    const destinosOrdenados = [...run.destinos].sort((a, b) => a.numero - b.numero);
    const segmentos = cycle.map(d => destinosOrdenados.findIndex(x => x.id === d.id) + 1);
    run.origenes.forEach((origen, index) => {
      const destino = cycle[index];
      const payload = JSON.stringify({
        id: destino.id, grupo: run.grupo === 'A' ? 'B' : 'A', codigo: destino.codigo,
        nombre_completo: destino.nombre, celular: destino.celular || ''
      });
      const d = encrypt(payload);
      insAsig.run(run.sorteo, origen.id, run.grupo, bidx(destino.id), d.c, d.i, d.t, segmentos[index], ts);
    });
  }

  const verify = db.prepare(`SELECT sorteo, COUNT(*) n, COUNT(DISTINCT destino_bidx) u, MIN(segmento) mn, MAX(segmento) mx
                             FROM sorteo_asignaciones GROUP BY sorteo`).all();
  console.log(JSON.stringify({
    ok: true,
    grupoA: { total: ids.A.length, participantes: ids.A.map(p => p.codigo) },
    grupoB: { total: ids.B.length, participantes: ids.B.map(p => p.codigo) },
    asignaciones: verify,
    tokens_generados: tokensByGroup.A.length + tokensByGroup.B.length
  }, null, 2));
}
main();

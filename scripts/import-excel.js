const ExcelJS = require('exceljs');
const Database = require('better-sqlite3');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.resolve(ROOT, 'data/amigo-secreto.db');
const FILE = path.resolve(process.argv[2] || path.join(ROOT, 'data/source/AMIGO_SECRETO_2026.xlsx'));
const db = new Database(DB_PATH);

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
`);

function sanitizeName(name = '') {
  return String(name).replace(/[\u0000-\u001F\u007F]/g, '').replace(/\s+/g, ' ').trim();
}
function normalizeCelular(input = '') {
  const digits = String(input).replace(/\D/g, '');
  if (digits.startsWith('57') && digits.length === 12) return digits.slice(2);
  return digits;
}
function nowBogota() {
  const dtf = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  });
  const parts = Object.fromEntries(dtf.formatToParts(new Date()).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

(async () => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(FILE);
  const ws = wb.worksheets[0];
  const insert = db.prepare(`INSERT INTO preinscripciones
    (nombre_completo, celular, sexo, created_at, origen, estado)
    VALUES (?, ?, ?, ?, 'importado_excel', 'pendiente')`);
  let imported = 0, skipped = 0;
  for (let i = 2; i <= ws.rowCount; i++) {
    const row = ws.getRow(i);
    const nombre = sanitizeName(row.getCell(2).text || row.getCell(2).value || '');
    const celular = normalizeCelular(row.getCell(3).text || row.getCell(3).value || '');
    const sexo = String(row.getCell(4).text || row.getCell(4).value || '').trim().toUpperCase();
    if (!nombre || nombre.length < 3 || !/^3\d{9}$/.test(celular) || !['H','M'].includes(sexo)) {
      skipped++;
      continue;
    }
    try {
      insert.run(nombre, celular, sexo, nowBogota());
      imported++;
    } catch {
      skipped++;
    }
  }
  console.log(JSON.stringify({ imported, skipped, file: FILE }, null, 2));
})();

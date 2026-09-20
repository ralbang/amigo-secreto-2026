const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const FAKE_PERSONAS = [
  { nombre: 'Karol G (ficticio)', celular: '300 555 0101' },
  { nombre: 'Maluma (ficticio)', celular: '310 555 0142' },
  { nombre: 'Shakira (ficticio)', celular: '320 555 0177' },
  { nombre: 'J Balvin (ficticio)', celular: '311 555 0198' },
  { nombre: 'Sofía Vergara (ficticio)', celular: '315 555 0123' },
  { nombre: 'Juanes (ficticio)', celular: '318 555 0155' },
  { nombre: 'Carlos Vives (ficticio)', celular: '312 555 0166' },
  { nombre: 'Greeicy Rendón (ficticio)', celular: '314 555 0188' },
  { nombre: 'Sebastián Yatra (ficticio)', celular: '317 555 0134' },
  { nombre: 'Margarita Rosa de Francisco (ficticio)', celular: '301 555 0149' },
  { nombre: 'Yuri Buenaventura (ficticio)', celular: '319 555 0119' },
  { nombre: 'Danna García (ficticio)', celular: '313 555 0171' }
];

module.exports = function mountSorteo(app, deps) {
  const { db, jwt, JWT_SECRET, ExcelJS, ROOT, nowBogota, getClientIp, logEvent, requireAuth, requireCsrf } = deps;

  const DATA_DIR = path.join(ROOT, 'data');
  const KEY_FILE = path.join(DATA_DIR, '.sorteo.key');
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
  const KEY_ID = crypto.createHash('sha256').update(KEY).digest('hex').slice(0, 12);

  function encrypt(plain) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
    const enc = Buffer.concat([cipher.update(Buffer.from(plain, 'utf8')), cipher.final()]);
    return {
      c: enc.toString('base64'),
      i: iv.toString('base64'),
      t: cipher.getAuthTag().toString('base64')
    };
  }
  function decrypt(rec) {
    if (!rec || !rec.c) return null;
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(rec.i, 'base64'));
      decipher.setAuthTag(Buffer.from(rec.t, 'base64'));
      const out = Buffer.concat([decipher.update(Buffer.from(rec.c, 'base64')), decipher.final()]);
      return out.toString('utf8');
    } catch {
      return null;
    }
  }
  const blindIndex = (value) => crypto.createHmac('sha256', KEY).update('bidx:' + String(value)).digest('hex');
  const tokenHash = (token) => crypto.createHash('sha256').update('tok:' + String(token)).digest('hex');
  const pack = (obj) => encrypt(JSON.stringify(obj));

  db.exec(`
    CREATE TABLE IF NOT EXISTS sorteo_participantes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      grupo CHAR(1) NOT NULL CHECK (grupo IN ('A','B')),
      numero INTEGER NOT NULL,
      sexo VARCHAR(2) NOT NULL,
      codigo VARCHAR(8) NOT NULL UNIQUE,
      nombre_completo VARCHAR(120) NOT NULL,
      celular VARCHAR(15),
      token_hash VARCHAR(64) NOT NULL UNIQUE,
      token_cipher TEXT NOT NULL,
      token_iv TEXT NOT NULL,
      token_tag TEXT NOT NULL,
      created_at TIMESTAMP NOT NULL,
      UNIQUE (grupo, numero)
    );

    CREATE TABLE IF NOT EXISTS sorteo_asignaciones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sorteo CHAR(2) NOT NULL CHECK (sorteo IN ('AB','BA')),
      origen_id INTEGER NOT NULL,
      origen_grupo CHAR(1) NOT NULL,
      destino_bidx VARCHAR(64) NOT NULL,
      destino_cipher TEXT NOT NULL,
      destino_iv TEXT NOT NULL,
      destino_tag TEXT NOT NULL,
      segmento INTEGER NOT NULL,
      spins_used INTEGER NOT NULL DEFAULT 0,
      locked_at TIMESTAMP NULL,
      resultado_cipher TEXT,
      resultado_iv TEXT,
      resultado_tag TEXT,
      ensayo1_cipher TEXT, ensayo1_iv TEXT, ensayo1_tag TEXT,
      ensayo2_cipher TEXT, ensayo2_iv TEXT, ensayo2_tag TEXT,
      updated_at TIMESTAMP NOT NULL,
      UNIQUE (sorteo, origen_id),
      UNIQUE (sorteo, destino_bidx)
    );

    CREATE INDEX IF NOT EXISTS idx_sorteo_asig_origen ON sorteo_asignaciones(sorteo, origen_id);
    CREATE INDEX IF NOT EXISTS idx_sorteo_part_grupo ON sorteo_participantes(grupo, numero);
  `);

  const insertConfig = db.prepare(`INSERT INTO configuracion (clave, valor, updated_at) VALUES (?, ?, ?)
                                   ON CONFLICT(clave) DO NOTHING`);
  insertConfig.run('SORTEO_MENSAJE_CIERRE', '¡Gracias por jugar! Que este Día del Amor y la Amistad nos recuerde lo mucho que nos queremos. 💕', nowBogota());
  insertConfig.run('SORTEO_ACTIVO', 'on', nowBogota());

  function getConf(clave, fallback) {
    const row = db.prepare('SELECT valor FROM configuracion WHERE clave = ?').get(clave);
    return row ? row.valor : fallback;
  }
  function setConf(clave, valor) {
    db.prepare(`INSERT INTO configuracion (clave, valor, updated_at) VALUES (?, ?, ?)
                ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor, updated_at = excluded.updated_at`)
      .run(clave, valor, nowBogota());
  }

  function wheelCodes(grupo) {
    const contrario = grupo === 'A' ? 'B' : 'A';
    return db.prepare('SELECT id, numero, sexo, codigo FROM sorteo_participantes WHERE grupo = ? ORDER BY numero ASC')
      .all(contrario);
  }

  function participantByToken(token) {
    if (!token || typeof token !== 'string' || token.length < 20) return null;
    return db.prepare('SELECT * FROM sorteo_participantes WHERE token_hash = ?').get(tokenHash(token)) || null;
  }

  function assignmentFor(part) {
    const sorteo = part.grupo === 'A' ? 'AB' : 'BA';
    return db.prepare('SELECT * FROM sorteo_asignaciones WHERE sorteo = ? AND origen_id = ?').get(sorteo, part.id);
  }

  const spinLimiter = require('express-rate-limit')({
    windowMs: 10 * 60 * 1000,
    max: Number(process.env.SORTEO_SPIN_MAX || 60),
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => res.status(429).json({ ok: false, error: 'rate_limit', mensaje: 'Demasiados giros seguidos. Espera un momento 💕' })
  });

  function publicState(part) {
    const asig = assignmentFor(part);
    const codes = wheelCodes(part.grupo);
    const base = {
      ok: true,
      yo: { codigo: part.codigo, grupo: part.grupo, nombre: part.nombre_completo },
      rueda: codes.map(c => c.codigo),
      giros_usados: asig ? asig.spins_used : 0,
      giros_max: 3,
      bloqueado: Boolean(asig && asig.locked_at),
      ya_escogiste: Boolean(asig && asig.locked_at),
      mensaje_cierre: getConf('SORTEO_MENSAJE_CIERRE', '')
    };
    if (asig && asig.ensayo1_cipher) {
      base.ensayo1 = JSON.parse(decrypt({ c: asig.ensayo1_cipher, i: asig.ensayo1_iv, t: asig.ensayo1_tag }) || 'null');
    }
    if (asig && asig.ensayo2_cipher) {
      base.ensayo2 = JSON.parse(decrypt({ c: asig.ensayo2_cipher, i: asig.ensayo2_iv, t: asig.ensayo2_tag }) || 'null');
    }
    if (asig && asig.locked_at && asig.resultado_cipher) {
      base.resultado = JSON.parse(decrypt({ c: asig.resultado_cipher, i: asig.resultado_iv, t: asig.resultado_tag }) || 'null');
    }
    return base;
  }

  app.get('/sorteo/:token', (req, res) => {
    res.sendFile(path.join(ROOT, 'public', 'sorteo.html'));
  });

  app.get('/admin/sorteo', (req, res) => {
    res.sendFile(path.join(ROOT, 'public', 'admin-sorteo.html'));
  });

  app.get('/api/sorteo/:token', (req, res) => {
    const part = participantByToken(req.params.token);
    if (!part) return res.status(404).json({ ok: false, error: 'token_invalido', mensaje: 'Este enlace no es válido.' });
    res.json(publicState(part));
  });

  app.post('/api/sorteo/:token/girar', spinLimiter, requireCsrf, (req, res) => {
    const part = participantByToken(req.params.token);
    if (!part) return res.status(404).json({ ok: false, error: 'token_invalido', mensaje: 'Este enlace no es válido.' });

    const asig = assignmentFor(part);
    if (!asig) return res.status(409).json({ ok: false, error: 'sin_asignacion', mensaje: 'Tu sorteo aún no está configurado.' });
    if (asig.locked_at) {
      return res.status(409).json({
        ok: false,
        error: 'bloqueado',
        mensaje: 'Ya escogiste',
        resultado: JSON.parse(decrypt({ c: asig.resultado_cipher, i: asig.resultado_iv, t: asig.resultado_tag }) || 'null')
      });
    }
    if (asig.spins_used >= 3) {
      return res.status(409).json({ ok: false, error: 'bloqueado', mensaje: 'Ya escogiste' });
    }

    const nextSpin = asig.spins_used + 1;
    const destinoPayload = JSON.parse(decrypt({ c: asig.destino_cipher, i: asig.destino_iv, t: asig.destino_tag }) || 'null');
    // El segmento donde debe detenerse la rueda es la POSICIÓN del código destino en la rueda que ve esta persona.
    // La animación solo lo muestra: la asignación ya fue fijada en el servidor al sembrar el sorteo.
    const wheelIdx = wheelCodes(part.grupo).findIndex(c => c.codigo === destinoPayload.codigo) + 1;
    const segmento = wheelIdx > 0 ? wheelIdx : asig.segmento;

    if (nextSpin < 3) {
      const fake = FAKE_PERSONAS[crypto.randomInt(FAKE_PERSONAS.length)];
      const payload = {
        ensayo: true,
        aviso: 'ENSAYO · resultado simulado con datos ficticios (no tiene ningún efecto real)',
        codigo: destinoPayload.codigo,
        nombre: fake.nombre,
        celular: fake.celular
      };
      const packed = pack(payload);
      if (nextSpin === 1) {
        db.prepare('UPDATE sorteo_asignaciones SET spins_used=?, ensayo1_cipher=?, ensayo1_iv=?, ensayo1_tag=?, updated_at=? WHERE id=?')
          .run(nextSpin, packed.c, packed.i, packed.t, nowBogota(), asig.id);
      } else {
        db.prepare('UPDATE sorteo_asignaciones SET spins_used=?, ensayo2_cipher=?, ensayo2_iv=?, ensayo2_tag=?, updated_at=? WHERE id=?')
          .run(nextSpin, packed.c, packed.i, packed.t, nowBogota(), asig.id);
      }
      logEvent('sorteo_ensayo', req, { origen: part.codigo, giro: nextSpin });
      return res.json({ ok: true, giro: nextSpin, definitivo: false, segmento, resultado: payload, giros_restantes: 3 - nextSpin });
    }

    const payload = {
      ensayo: false,
      codigo: destinoPayload.codigo,
      nombre: destinoPayload.nombre_completo,
      celular: destinoPayload.celular,
      grupo: destinoPayload.grupo,
      mensaje: '¡Este es tu amigo secreto! 💕'
    };
    const packed = pack(payload);
    const ts = nowBogota();
    db.prepare(`UPDATE sorteo_asignaciones
                SET spins_used=3, locked_at=?, resultado_cipher=?, resultado_iv=?, resultado_tag=?, updated_at=?
                WHERE id=? AND locked_at IS NULL`)
      .run(ts, packed.c, packed.i, packed.t, ts, asig.id);

    const check = db.prepare('SELECT locked_at FROM sorteo_asignaciones WHERE id=?').get(asig.id);
    if (!check.locked_at) return res.status(409).json({ ok: false, error: 'bloqueado', mensaje: 'Ya escogiste' });

    logEvent('sorteo_definitivo', req, { origen: part.codigo });
    return res.json({ ok: true, giro: 3, definitivo: true, segmento, resultado: payload, giros_restantes: 0, mensaje: 'Ya escogiste' });
  });

  app.get('/api/admin/sorteo/tablero', requireAuth, (req, res) => {
    const rows = db.prepare(`
      SELECT p.id, p.grupo, p.numero, p.sexo, p.codigo, p.nombre_completo,
             COALESCE(a.spins_used, 0) AS spins_used,
             a.locked_at
      FROM sorteo_participantes p
      LEFT JOIN sorteo_asignaciones a
        ON a.origen_id = p.id AND a.sorteo = CASE WHEN p.grupo='A' THEN 'AB' ELSE 'BA' END
      ORDER BY p.grupo ASC, p.numero ASC
    `).all();

    const luces = rows.map(r => ({
      codigo: r.codigo,
      grupo: r.grupo,
      nombre: r.nombre_completo,
      encendida: Boolean(r.locked_at),
      giros_usados: r.spins_used,
      bloqueado: Boolean(r.locked_at)
    }));

    const total = luces.length;
    const completados = luces.filter(l => l.encendida).length;
    res.json({
      ok: true,
      luces,
      progreso: {
        total,
        completados,
        pendientes: total - completados,
        grupoA: { total: luces.filter(l => l.grupo === 'A').length, completados: luces.filter(l => l.grupo === 'A' && l.encendida).length },
        grupoB: { total: luces.filter(l => l.grupo === 'B').length, completados: luces.filter(l => l.grupo === 'B' && l.encendida).length },
        texto_compartible: `Amigo Secreto 2026 · van ${completados} de ${total} 💕`
      },
      mensaje_cierre: getConf('SORTEO_MENSAJE_CIERRE', ''),
      cierre_habilitado: completados === total && total > 0,
      sorteo_activo: getConf('SORTEO_ACTIVO', 'on')
    });
  });

  app.get('/api/admin/sorteo/cierre', requireAuth, (req, res) => {
    res.json({ ok: true, mensaje_cierre: getConf('SORTEO_MENSAJE_CIERRE', ''), sorteo_activo: getConf('SORTEO_ACTIVO', 'on') });
  });

  app.patch('/api/admin/sorteo/cierre', requireAuth, requireCsrf, (req, res) => {
    if (typeof req.body.mensaje_cierre === 'string') {
      setConf('SORTEO_MENSAJE_CIERRE', req.body.mensaje_cierre.slice(0, 600).trim());
    }
    if (typeof req.body.sorteo_activo === 'string') {
      setConf('SORTEO_ACTIVO', req.body.sorteo_activo === 'off' ? 'off' : 'on');
    }
    res.json({ ok: true, mensaje_cierre: getConf('SORTEO_MENSAJE_CIERRE', ''), sorteo_activo: getConf('SORTEO_ACTIVO', 'on') });
  });

  function buildLinks() {
    const base = (process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
    const rows = db.prepare('SELECT * FROM sorteo_participantes ORDER BY grupo ASC, numero ASC').all();
    return rows.map(r => {
      const token = decrypt({ c: r.token_cipher, i: r.token_iv, t: r.token_tag });
      return {
        grupo: r.grupo,
        numero: r.numero,
        codigo: r.codigo,
        nombre_completo: r.nombre_completo,
        celular: r.celular || '',
        enlace: token ? `${base}/sorteo/${token}` : ''
      };
    });
  }

  app.get('/api/admin/sorteo/enlaces.csv', requireAuth, (req, res) => {
    const rows = buildLinks();
    const header = ['grupo', 'codigo', 'nombre_completo', 'celular', 'enlace'];
    const esc = v => (/[",\n]/.test(String(v ?? '')) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ''));
    const csv = [header.join(',')].concat(rows.map(r => header.map(k => esc(r[k])).join(','))).join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="enlaces-sorteo-${nowBogota().slice(0, 10)}.csv"`);
    res.send('\uFEFF' + csv);
  });

  app.get('/api/admin/sorteo/enlaces.xlsx', requireAuth, async (req, res) => {
    const rows = buildLinks();
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Enlaces personales');
    ws.columns = [
      { header: 'grupo', key: 'grupo', width: 8 },
      { header: 'codigo', key: 'codigo', width: 10 },
      { header: 'nombre_completo', key: 'nombre_completo', width: 34 },
      { header: 'celular', key: 'celular', width: 14 },
      { header: 'enlace', key: 'enlace', width: 62 }
    ];
    rows.forEach(r => ws.addRow(r));
    ws.getRow(1).font = { bold: true };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="enlaces-sorteo-${nowBogota().slice(0, 10)}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  });

  app.get('/api/admin/sorteo/auditoria', requireAuth, (req, res) => {
    // Comprobación técnica sin revelar emparejamientos: solo conteos e integridad.
    const q = db.prepare(`SELECT sorteo, COUNT(*) AS n, COUNT(DISTINCT destino_bidx) AS unicos, SUM(CASE WHEN locked_at IS NOT NULL THEN 1 ELSE 0 END) AS revelados
                          FROM sorteo_asignaciones GROUP BY sorteo`).all();
    const plainCols = db.prepare("SELECT name FROM pragma_table_info('sorteo_asignaciones')").all().map(r => r.name);
    const sin_identificadores = !plainCols.includes('destino_id') && !plainCols.includes('destino_nombre');
    res.json({
      ok: true,
      key_id: KEY_ID,
      asignaciones: q.map(r => ({ sorteo: r.sorteo, total: r.n, destinos_unicos: r.unicos, biyeccion_ok: r.n === r.unicos, revelados: r.revelados })),
      columnas: plainCols,
      emparejamiento_en_texto_plano: sin_identificadores ? 'NO (cifrado AES-256-GCM + índice ciego HMAC)' : 'SÍ'
    });
  });

  return { KEY_ID, buildLinks };
};

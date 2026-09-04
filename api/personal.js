// api/personal.js
// GET    -> lista completa de personal (incluye inactivos; el frontend filtra)
// POST   -> alta de nueva persona { nombre, puesto, sucursal, role }
// PUT    -> edición { id, nombre, puesto, sucursal, fecha_alta, fecha_baja }
//           o cambio rápido de estado { id, activo }
// DELETE -> ?id=123 elimina definitivamente (y su historial de evaluaciones, vía ON DELETE CASCADE)

const { sql, ensureSchema } = require('../lib/db');

const SUCURSAL_CODES = {
  'Guadalajara': 'GDL', 'Monterrey': 'MTY', 'Ciudad de México': 'CDMX',
  'Puerto Vallarta': 'PV', 'Los Cabos': 'LC', 'Cancun': 'CUN', 'CEDIS': 'CEDIS', 'TISA': 'TISA'
};

function slugifyBase(nombre) {
  const norm = nombre.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  const parts = norm.split(/\s+/).map(s => s.replace(/[^a-z]/g, '')).filter(Boolean);
  if (parts.length === 0) return 'user';
  if (parts.length === 1) return parts[0];
  return `${parts[0]}.${parts[parts.length - 1]}`;
}

async function generateUsername(nombre) {
  const base = slugifyBase(nombre);
  let candidate = base;
  let n = 1;
  while (true) {
    const { rows } = await sql`SELECT 1 FROM personal WHERE LOWER(username) = LOWER(${candidate}) LIMIT 1;`;
    if (rows.length === 0) return candidate;
    n++;
    candidate = `${base}${n}`;
  }
}

// Fecha de hoy en zona horaria de México (UTC-6), formato YYYY-MM-DD.
function fechaHoyMexico() {
  const hoy = new Date();
  return new Date(hoy.getTime() - 6 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

module.exports = async (req, res) => {
  try {
    await ensureSchema();

    if (req.method === 'GET') {
      const { rows } = await sql`SELECT * FROM personal ORDER BY sucursal, nombre;`;
      res.status(200).json(rows);
      return;
    }

    if (req.method === 'POST') {
      const { nombre, puesto, sucursal, role } = req.body || {};
      if (!nombre || !puesto || !sucursal || !role) {
        res.status(400).json({ error: 'Faltan campos obligatorios.' });
        return;
      }
      const sucursalCode = SUCURSAL_CODES[sucursal] || sucursal.slice(0, 3).toUpperCase();
      // Fecha de alta = hoy en zona horaria de México (UTC-6)
      const fechaAlta = fechaHoyMexico();

      if (role === 'operativo') {
        const { rows } = await sql`
          INSERT INTO personal (nombre, puesto, sucursal, sucursal_code, role, username, password, activo, fecha_alta)
          VALUES (${nombre}, ${puesto}, ${sucursal}, ${sucursalCode}, 'operativo', NULL, NULL, true, ${fechaAlta})
          RETURNING *;
        `;
        res.status(201).json(rows[0]);
        return;
      }

      // supervisor
      const username = await generateUsername(nombre);
      const { rows } = await sql`
        INSERT INTO personal (nombre, puesto, sucursal, sucursal_code, role, username, password, activo, fecha_alta)
        VALUES (${nombre}, ${puesto}, ${sucursal}, ${sucursalCode}, ${role}, ${username}, 'gpa2026', true, ${fechaAlta})
        RETURNING *;
      `;
      res.status(201).json(rows[0]);
      return;
    }

    if (req.method === 'PUT') {
      const { id, nombre, puesto, sucursal, activo, fecha_alta, fecha_baja } = req.body || {};
      if (!id) {
        res.status(400).json({ error: 'Falta el id.' });
        return;
      }

      // Cambio rápido de estado (botones "Dar de baja" / "Reactivar" del catálogo).
      // No pisa fecha_alta/fecha_baja si ya vienen fijadas manualmente:
      // - Dar de baja: registra la fecha real de hoy SOLO si no había ya una
      //   fecha_baja (p.ej. capturada manualmente al editar). Esto es lo que
      //   hace que, a partir de ese día, la persona deje de generar días
      //   esperados en los KPI de su sucursal (en vez de desaparecer del
      //   historial por completo, como ocurría antes).
      // - Reactivar: limpia fecha_baja para que la persona vuelva a contar
      //   con normalidad desde ese momento.
      if (typeof activo === 'boolean' && nombre === undefined) {
        if (activo === false) {
          const fechaAutoBaja = fechaHoyMexico();
          const { rows } = await sql`
            UPDATE personal
            SET activo = false, fecha_baja = COALESCE(fecha_baja, ${fechaAutoBaja})
            WHERE id = ${id}
            RETURNING *;
          `;
          res.status(200).json(rows[0] || null);
        } else {
          const { rows } = await sql`
            UPDATE personal SET activo = true, fecha_baja = NULL WHERE id = ${id} RETURNING *;
          `;
          res.status(200).json(rows[0] || null);
        }
        return;
      }

      // Edición de datos (incluye corrección manual de fecha_alta / fecha_baja
      // desde el modal "Editar persona", para cuando el alta o la baja real
      // no coincide con el día en que se capturó en el sistema).
      const sucursalCode = SUCURSAL_CODES[sucursal] || (sucursal ? sucursal.slice(0, 3).toUpperCase() : null);
      const { rows } = await sql`
        UPDATE personal
        SET nombre = ${nombre},
            puesto = ${puesto},
            sucursal = ${sucursal},
            sucursal_code = ${sucursalCode},
            fecha_alta = ${fecha_alta || '2020-01-01'},
            fecha_baja = ${fecha_baja ? fecha_baja : null}
        WHERE id = ${id}
        RETURNING *;
      `;
      res.status(200).json(rows[0] || null);
      return;
    }

    if (req.method === 'DELETE') {
      const id = req.query.id;
      if (!id) {
        res.status(400).json({ error: 'Falta el id.' });
        return;
      }
      await sql`DELETE FROM personal WHERE id = ${id};`;
      res.status(200).json({ success: true });
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Error en /api/personal:', err);
    res.status(500).json({ error: 'Error del servidor.' });
  }
};

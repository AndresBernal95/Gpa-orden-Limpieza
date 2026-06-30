// api/personal.js
// GET    -> lista completa de personal (incluye inactivos; el frontend filtra)
// POST   -> alta de nueva persona { nombre, puesto, sucursal, role }
// PUT    -> edición { id, nombre, puesto, sucursal } o cambio de estado { id, activo }
// DELETE -> ?id=123 elimina definitivamente (y su historial de evaluaciones, vía ON DELETE CASCADE)

const { sql, ensureSchema } = require('../lib/db');

const SUCURSAL_CODES = {
  'Guadalajara': 'GDL', 'Monterrey': 'MTY', 'Ciudad de México': 'CDMX',
  'Puerto Vallarta': 'PV', 'Los Cabos': 'LC', 'Cancun': 'CUN', 'CEDIS': 'CEDIS'
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

      if (role === 'operativo') {
        const { rows } = await sql`
          INSERT INTO personal (nombre, puesto, sucursal, sucursal_code, role, username, password, activo)
          VALUES (${nombre}, ${puesto}, ${sucursal}, ${sucursalCode}, 'operativo', NULL, NULL, true)
          RETURNING *;
        `;
        res.status(201).json(rows[0]);
        return;
      }

      // supervisor (o, en teoría, admin si algún día se necesitara)
      const username = await generateUsername(nombre);
      const { rows } = await sql`
        INSERT INTO personal (nombre, puesto, sucursal, sucursal_code, role, username, password, activo)
        VALUES (${nombre}, ${puesto}, ${sucursal}, ${sucursalCode}, ${role}, ${username}, 'gpa2026', true)
        RETURNING *;
      `;
      res.status(201).json(rows[0]);
      return;
    }

    if (req.method === 'PUT') {
      const { id, nombre, puesto, sucursal, activo } = req.body || {};
      if (!id) {
        res.status(400).json({ error: 'Falta el id.' });
        return;
      }

      // Cambio de estado (dar de baja / reactivar)
      if (typeof activo === 'boolean' && nombre === undefined) {
        const { rows } = await sql`
          UPDATE personal SET activo = ${activo} WHERE id = ${id} RETURNING *;
        `;
        res.status(200).json(rows[0] || null);
        return;
      }

      // Edición de datos
      const sucursalCode = SUCURSAL_CODES[sucursal] || (sucursal ? sucursal.slice(0, 3).toUpperCase() : null);
      const { rows } = await sql`
        UPDATE personal
        SET nombre = ${nombre}, puesto = ${puesto}, sucursal = ${sucursal}, sucursal_code = ${sucursalCode}
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

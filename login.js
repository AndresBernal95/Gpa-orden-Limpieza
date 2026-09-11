// api/login.js
// POST { username, password } -> { success, user } o { success:false }
// Valida contra la tabla personal. Solo supervisores y admin pueden loguearse
// (igual que la regla original: role !== 'operativo').

const { sql, ensureSchema } = require('../lib/db');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    await ensureSchema();
    const { username, password } = req.body || {};

    if (!username || !password) {
      res.status(400).json({ success: false, message: 'Usuario y contraseña requeridos.' });
      return;
    }

    const { rows } = await sql`
      SELECT id, nombre, puesto, sucursal, sucursal_code, role, username, activo
      FROM personal
      WHERE LOWER(username) = LOWER(${username})
        AND password = ${password}
        AND role != 'operativo'
        AND activo = true
        AND archivado = false
      LIMIT 1;
    `;

    if (rows.length === 0) {
      res.status(200).json({ success: false, message: 'Usuario o contraseña incorrectos.' });
      return;
    }

    res.status(200).json({ success: true, user: rows[0] });
  } catch (err) {
    console.error('Error en /api/login:', err);
    res.status(500).json({ success: false, message: 'Error del servidor.' });
  }
};

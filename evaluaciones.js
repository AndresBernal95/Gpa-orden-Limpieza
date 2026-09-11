// api/evaluaciones.js
// GET  ?personId=&fecha=&desde=&hasta=&evaluadoPor=  -> lista filtrada de evaluaciones
// POST { personId, fecha, tipo, total, respuestas, comentario, evaluadoPor }
//      -> crea una evaluación. RECHAZA si ya existe una para esa persona+fecha
//         (misma regla de "una calificación por día, sin edición" de la versión local).

const { sql, ensureSchema } = require('../lib/db');

module.exports = async (req, res) => {
  try {
    await ensureSchema();

    if (req.method === 'GET') {
      const { personId, fecha, desde, hasta, evaluadoPor } = req.query;

      let condiciones = [];
      let valores = [];

      // Construcción manual y segura del filtro (parametrizado), ya que el número
      // de condiciones es variable según los query params recibidos.
      let query = 'SELECT * FROM evaluaciones WHERE 1=1';
      if (personId) { query += ` AND person_id = $${valores.length + 1}`; valores.push(personId); }
      if (evaluadoPor) { query += ` AND evaluado_por = $${valores.length + 1}`; valores.push(evaluadoPor); }
      if (fecha) { query += ` AND fecha = $${valores.length + 1}`; valores.push(fecha); }
      if (desde) { query += ` AND fecha >= $${valores.length + 1}`; valores.push(desde); }
      if (hasta) { query += ` AND fecha <= $${valores.length + 1}`; valores.push(hasta); }
      query += ' ORDER BY fecha DESC;';

      const { rows } = await sql.query(query, valores);
      res.status(200).json(rows);
      return;
    }

    if (req.method === 'POST') {
      const { personId, fecha, tipo, total, respuestas, comentario, evaluadoPor } = req.body || {};
      if (!personId || !fecha || !tipo || !evaluadoPor) {
        res.status(400).json({ error: 'Faltan campos obligatorios.' });
        return;
      }

      const id = `${personId}_${fecha}`;

      // Defensa en profundidad: si ya existe, se rechaza (no se permite editar)
      const existing = await sql`SELECT id FROM evaluaciones WHERE id = ${id};`;
      if (existing.rows.length > 0) {
        res.status(409).json({ error: 'Esta persona ya fue calificada ese día. No se puede modificar.' });
        return;
      }

      const respuestasJson = respuestas ? JSON.stringify(respuestas) : null;

      // Nombre del evaluador congelado dentro del propio registro. Se lee del
      // servidor (no se confía en lo que mande el navegador) y queda guardado
      // tal como estaba el día de la captura, de modo que el histórico nunca
      // depende de cambios posteriores en el catálogo de personal.
      const evaluador = await sql`SELECT nombre FROM personal WHERE id = ${evaluadoPor} LIMIT 1;`;
      const evaluadoPorNombre = evaluador.rows[0] ? evaluador.rows[0].nombre : null;

      const { rows } = await sql`
        INSERT INTO evaluaciones (id, person_id, fecha, tipo, total, respuestas, comentario, evaluado_por, evaluado_por_nombre)
        VALUES (${id}, ${personId}, ${fecha}, ${tipo}, ${total}, ${respuestasJson}, ${comentario || ''}, ${evaluadoPor}, ${evaluadoPorNombre})
        RETURNING *;
      `;
      res.status(201).json(rows[0]);
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Error en /api/evaluaciones:', err);
    res.status(500).json({ error: 'Error del servidor.' });
  }
};

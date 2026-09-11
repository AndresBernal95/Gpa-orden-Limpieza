// api/personal.js
// GET    -> lista completa de personal (incluye inactivos y archivados; el
//           frontend decide a quién mostrar). NUNCA devuelve contraseñas.
// POST   -> alta de nueva persona { nombre, puesto, sucursal, role }
// PUT    -> edición { id, nombre, puesto, sucursal, fecha_alta, fecha_baja }
//           cambio rápido de estado { id, activo }
//           baja definitiva / restauración { id, archivar: true|false }
// DELETE -> DESHABILITADO a propósito. En este sistema no se borra nada: el
//           histórico de calificaciones es el producto final de la app. Para
//           sacar a alguien de la operación se usa la baja definitiva
//           (archivar), que lo oculta de toda la app pero conserva intactos
//           todos sus registros en la base de datos y en la exportación.

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
      // IMPORTANTE: nunca se seleccionan las contraseñas. Antes este endpoint
      // hacía SELECT * y, como no requiere sesión, cualquier persona con la
      // URL podía leer el usuario y la contraseña de todos los supervisores.
      // El frontend no necesita la contraseña para nada: quien la valida es
      // /api/login, del lado del servidor.
      const { rows } = await sql`
        SELECT id, nombre, puesto, sucursal, sucursal_code, role, username,
               activo, archivado, fecha_alta, fecha_baja, created_at
        FROM personal
        ORDER BY sucursal, nombre;
      `;
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
          RETURNING id, nombre, puesto, sucursal, sucursal_code, role, username,
                    activo, archivado, fecha_alta, fecha_baja, created_at;
        `;
        res.status(201).json(rows[0]);
        return;
      }

      // supervisor
      const username = await generateUsername(nombre);
      const { rows } = await sql`
        INSERT INTO personal (nombre, puesto, sucursal, sucursal_code, role, username, password, activo, fecha_alta)
        VALUES (${nombre}, ${puesto}, ${sucursal}, ${sucursalCode}, ${role}, ${username}, 'gpa2026', true, ${fechaAlta})
        RETURNING id, nombre, puesto, sucursal, sucursal_code, role, username,
                  activo, archivado, fecha_alta, fecha_baja, created_at;
      `;
      res.status(201).json(rows[0]);
      return;
    }

    if (req.method === 'PUT') {
      const { id, nombre, puesto, sucursal, activo, fecha_alta, fecha_baja, archivar } = req.body || {};
      if (!id) {
        res.status(400).json({ error: 'Falta el id.' });
        return;
      }

      // ── Baja definitiva / restauración ───────────────────────────────────
      // Reemplaza al antiguo "Eliminar definitivamente". NO borra la fila:
      // la marca como archivada, la da de baja, le fija la fecha de baja y
      // anula la contraseña para que no pueda volver a iniciar sesión. La
      // persona desaparece de toda la app, pero sus registros —los que
      // recibió y los que capturó— se quedan completos en la base de datos y
      // siguen saliendo en la exportación a Excel.
      if (typeof archivar === 'boolean') {
        if (archivar === true) {
          const fechaAutoBaja = fechaHoyMexico();
          const { rows } = await sql`
            UPDATE personal
            SET archivado = true,
                activo = false,
                fecha_baja = COALESCE(fecha_baja, ${fechaAutoBaja}),
                password = NULL
            WHERE id = ${id} AND role <> 'admin'
            RETURNING id, nombre, puesto, sucursal, sucursal_code, role, username,
                      activo, archivado, fecha_alta, fecha_baja, created_at;
          `;
          if (rows.length === 0) {
            res.status(400).json({ error: 'No se encontró la persona o es la cuenta de Administrador (no se puede archivar).' });
            return;
          }
          res.status(200).json(rows[0]);
        } else {
          // Restaurar: vuelve a la operación con la contraseña estándar.
          const { rows } = await sql`
            UPDATE personal
            SET archivado = false,
                activo = true,
                fecha_baja = NULL,
                password = CASE WHEN role = 'operativo' THEN NULL ELSE 'gpa2026' END
            WHERE id = ${id}
            RETURNING id, nombre, puesto, sucursal, sucursal_code, role, username,
                      activo, archivado, fecha_alta, fecha_baja, created_at;
          `;
          res.status(200).json(rows[0] || null);
        }
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
            RETURNING id, nombre, puesto, sucursal, sucursal_code, role, username,
                      activo, archivado, fecha_alta, fecha_baja, created_at;
          `;
          res.status(200).json(rows[0] || null);
        } else {
          const { rows } = await sql`
            UPDATE personal
            SET activo = true, fecha_baja = NULL, archivado = false
            WHERE id = ${id}
            RETURNING id, nombre, puesto, sucursal, sucursal_code, role, username,
                      activo, archivado, fecha_alta, fecha_baja, created_at;
          `;
          res.status(200).json(rows[0] || null);
        }
        return;
      }

      // Edición de datos (incluye corrección manual de fecha_alta / fecha_baja
      // desde el modal "Editar persona", para cuando el alta o la baja real
      // no coincide con el día en que se capturó en el sistema).
      const sucursalCode = SUCURSAL_CODES[sucursal] || (sucursal ? sucursal.slice(0, 3).toUpperCase() : null);
      const nuevaFechaBaja = fecha_baja ? fecha_baja : null;
      // El estado se mantiene en sincronía con la fecha de baja. Antes se
      // podían contradecir: capturar una fecha de baja a mano dejaba a la
      // persona como "Activa", así que seguía apareciendo en la lista de
      // "Mi equipo de hoy" del supervisor aunque el reporte ya la tratara
      // como dada de baja. Ahora, con fecha de baja queda inactiva y al
      // borrar la fecha de baja vuelve a quedar activa (salvo que esté
      // archivada, que ésa solo vuelve con "Restaurar").
      const { rows } = await sql`
        UPDATE personal
        SET nombre = ${nombre},
            puesto = ${puesto},
            sucursal = ${sucursal},
            sucursal_code = ${sucursalCode},
            fecha_alta = ${fecha_alta || '2020-01-01'},
            fecha_baja = ${nuevaFechaBaja},
            activo = CASE WHEN archivado THEN false ELSE ${nuevaFechaBaja === null}::boolean END
        WHERE id = ${id}
        RETURNING id, nombre, puesto, sucursal, sucursal_code, role, username,
                  activo, archivado, fecha_alta, fecha_baja, created_at;
      `;
      res.status(200).json(rows[0] || null);
      return;
    }

    if (req.method === 'DELETE') {
      // Borrado deshabilitado por diseño. El histórico de calificaciones es
      // el producto de esta app: una vez capturado un registro, no se
      // elimina. Para sacar a alguien de la operación se usa la baja
      // definitiva (PUT { id, archivar: true }), que lo oculta de toda la
      // app pero conserva todos sus registros.
      res.status(405).json({
        error: 'En este sistema no se eliminan personas ni registros. Usa "Baja definitiva": la persona desaparece de la app y sus calificaciones se conservan en la base de datos y en la exportación.'
      });
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Error en /api/personal:', err);
    res.status(500).json({ error: 'Error del servidor.' });
  }
};

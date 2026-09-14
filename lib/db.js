// lib/db.js
// Conexión a la base de datos Postgres (Vercel + Neon) y siembra inicial
// del catálogo de personal, reproduciendo el PERSONAL_SEED original de la app.

const { sql } = require('@vercel/postgres');

const PERSONAL_SEED = require('./personal-seed.json');

let schemaReady = false;

async function ensureSchema() {
  if (schemaReady) return;

  await sql`
    CREATE TABLE IF NOT EXISTS personal (
      id SERIAL PRIMARY KEY,
      nombre TEXT NOT NULL,
      puesto TEXT NOT NULL,
      sucursal TEXT NOT NULL,
      sucursal_code TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('operativo','supervisor','admin')),
      username TEXT UNIQUE,
      password TEXT,
      activo BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `;

  // Migración: agregar fecha_alta si no existe todavía.
  // Las 73 personas del seed original reciben '2020-01-01' para nunca
  // generar pendientes retroactivos. Las altas nuevas recibirán la fecha
  // real del día en que el Admin las registró.
  await sql`
    ALTER TABLE personal
    ADD COLUMN IF NOT EXISTS fecha_alta DATE NOT NULL DEFAULT '2020-01-01';
  `;

  // Migración: agregar fecha_baja (nullable). Se llena automáticamente con
  // la fecha real del día en que el Admin da de baja a la persona, y se
  // limpia (NULL) si la persona es reactivada. Se usa para que, a partir de
  // esa fecha, la persona deje de generar días esperados en los KPI (en
  // lugar de desaparecer por completo del historial, como ocurría antes).
  await sql`
    ALTER TABLE personal
    ADD COLUMN IF NOT EXISTS fecha_baja DATE;
  `;

  // Migración: agregar archivado (baja definitiva). Una persona archivada
  // desaparece por completo de la app (catálogo, listas de evaluación,
  // selectores de reportes, KPI y panel de Supervisores) pero SU FILA NUNCA
  // SE BORRA: así, todas las evaluaciones que recibió y todas las que
  // registró siguen existiendo en la base y siguen saliendo en la
  // exportación a Excel. Es la acción correcta cuando alguien renuncia o es
  // reemplazado.
  await sql`
    ALTER TABLE personal
    ADD COLUMN IF NOT EXISTS archivado BOOLEAN NOT NULL DEFAULT false;
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS evaluaciones (
      id TEXT PRIMARY KEY,
      person_id INTEGER NOT NULL REFERENCES personal(id) ON DELETE RESTRICT,
      fecha DATE NOT NULL,
      tipo TEXT NOT NULL CHECK (tipo IN ('calificado','falta_justificada','falta_injustificada')),
      total NUMERIC(4,1),
      respuestas JSONB,
      comentario TEXT DEFAULT '',
      evaluado_por INTEGER NOT NULL REFERENCES personal(id) ON DELETE RESTRICT,
      evaluado_por_nombre TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `;

  // Migración: nombre del evaluador congelado dentro de la propia evaluación.
  // Segunda red de seguridad para el histórico: aunque algún día cambie el
  // catálogo de personal, cada registro conserva el nombre de quién lo
  // capturó, tal como estaba el día de la captura.
  await sql`
    ALTER TABLE evaluaciones
    ADD COLUMN IF NOT EXISTS evaluado_por_nombre TEXT;
  `;

  // Relleno único de los registros ya existentes (después de la primera
  // corrida actualiza 0 filas y no cuesta nada).
  await sql`
    UPDATE evaluaciones e
    SET evaluado_por_nombre = p.nombre
    FROM personal p
    WHERE e.evaluado_por = p.id
      AND e.evaluado_por_nombre IS NULL;
  `;

  // Blindaje del histórico: las llaves foráneas pasan a ON DELETE RESTRICT.
  // Antes, person_id tenía ON DELETE CASCADE, de modo que borrar a una
  // persona borraba en silencio todas las evaluaciones que había recibido.
  // Con RESTRICT, la base de datos simplemente NO PERMITE borrar a alguien
  // que ya tenga registros: el histórico deja de depender de que nadie se
  // equivoque en la pantalla de Usuarios.
  // Solo se recrea la restricción si todavía no está en RESTRICT, para no
  // revalidar la tabla en cada arranque en frío.
  // Va dentro de un try: es un blindaje adicional, no algo de lo que dependa
  // el funcionamiento diario. Si por alguna razón no se pudiera aplicar (por
  // ejemplo, si la tabla está ocupada en ese instante), la app sigue
  // trabajando con normalidad y se reintenta en el siguiente arranque.
  try {
  await sql`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'evaluaciones_person_id_fkey' AND confdeltype = 'r'
      ) THEN
        ALTER TABLE evaluaciones DROP CONSTRAINT IF EXISTS evaluaciones_person_id_fkey;
        ALTER TABLE evaluaciones
          ADD CONSTRAINT evaluaciones_person_id_fkey
          FOREIGN KEY (person_id) REFERENCES personal(id) ON DELETE RESTRICT;
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'evaluaciones_evaluado_por_fkey' AND confdeltype = 'r'
      ) THEN
        ALTER TABLE evaluaciones DROP CONSTRAINT IF EXISTS evaluaciones_evaluado_por_fkey;
        ALTER TABLE evaluaciones
          ADD CONSTRAINT evaluaciones_evaluado_por_fkey
          FOREIGN KEY (evaluado_por) REFERENCES personal(id) ON DELETE RESTRICT;
      END IF;
    END $$;
  `;
  } catch (err) {
    console.warn('No se pudo endurecer las llaves foráneas de evaluaciones (se reintentará):', err.message);
  }

  await sql`CREATE INDEX IF NOT EXISTS idx_evaluaciones_fecha ON evaluaciones(fecha);`;
  await sql`CREATE INDEX IF NOT EXISTS idx_evaluaciones_person ON evaluaciones(person_id);`;
  await sql`CREATE INDEX IF NOT EXISTS idx_evaluaciones_evaluador ON evaluaciones(evaluado_por);`;
  await sql`CREATE INDEX IF NOT EXISTS idx_personal_sucursal ON personal(sucursal);`;

  // Sembrar el catálogo original solo si la tabla está vacía (primer arranque)
  const { rows } = await sql`SELECT COUNT(*)::int AS count FROM personal;`;
  if (rows[0].count === 0) {
    for (const p of PERSONAL_SEED) {
      await sql`
        INSERT INTO personal (id, nombre, puesto, sucursal, sucursal_code, role, username, password, activo, fecha_alta)
        VALUES (${p.id}, ${p.nombre}, ${p.puesto}, ${p.sucursal}, ${p.sucursal_code}, ${p.role}, ${p.username || null}, ${p.password || null}, true, '2020-01-01')
        ON CONFLICT (id) DO NOTHING;
      `;
    }
    // Sincronizar la secuencia del SERIAL con el id más alto insertado manualmente
    await sql`SELECT setval(pg_get_serial_sequence('personal','id'), (SELECT MAX(id) FROM personal));`;
  }

  schemaReady = true;
}

// Versión tolerante de ensureSchema(). Las migraciones son ESCRITURAS, y
// cuando la base de datos está limitada a solo lectura (por ejemplo, al
// alcanzar el límite de almacenamiento del plan) fallan. Antes eso tumbaba
// también las consultas, porque ensureSchema() corre al principio de cada
// endpoint: la app quedaba completamente inaccesible aunque leer sí se
// pudiera. Ahora, si la migración falla, se registra y se sigue adelante:
// mientras el esquema ya esté aplicado, el Admin puede seguir consultando
// los reportes y, sobre todo, descargar el Excel con el histórico.
async function ensureSchemaSafe() {
  try {
    await ensureSchema();
    return true;
  } catch (err) {
    console.error('ensureSchema no se pudo completar; se continúa en modo consulta:', err.message);
    return false;
  }
}

// Traduce el error de la base de datos a algo que el usuario pueda accionar.
function mensajeErrorDb(err) {
  const m = String((err && err.message) || '').toLowerCase();
  if (m.includes('quota') || m.includes('disk') || m.includes('space') ||
      m.includes('read-only') || m.includes('read only') || m.includes('storage')) {
    return 'La base de datos alcanzó el límite de su plan y no está aceptando escrituras. Avisa al administrador del sistema: las calificaciones no se pueden guardar hasta que se libere.';
  }
  if (m.includes('connect') || m.includes('timeout') || m.includes('terminat') ||
      m.includes('econn') || m.includes('suspend') || m.includes('shutdown')) {
    return 'No hay conexión con la base de datos en este momento (puede estar suspendida por el límite del plan). Intenta de nuevo en unos minutos y avisa al administrador del sistema.';
  }
  return 'Error del servidor.';
}

module.exports = { sql, ensureSchema, ensureSchemaSafe, mensajeErrorDb };

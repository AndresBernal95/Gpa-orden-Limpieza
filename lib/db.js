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

  await sql`
    CREATE TABLE IF NOT EXISTS evaluaciones (
      id TEXT PRIMARY KEY,
      person_id INTEGER NOT NULL REFERENCES personal(id) ON DELETE CASCADE,
      fecha DATE NOT NULL,
      tipo TEXT NOT NULL CHECK (tipo IN ('calificado','falta_justificada','falta_injustificada')),
      total NUMERIC(4,1),
      respuestas JSONB,
      comentario TEXT DEFAULT '',
      evaluado_por INTEGER NOT NULL REFERENCES personal(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `;

  await sql`CREATE INDEX IF NOT EXISTS idx_evaluaciones_fecha ON evaluaciones(fecha);`;
  await sql`CREATE INDEX IF NOT EXISTS idx_evaluaciones_person ON evaluaciones(person_id);`;
  await sql`CREATE INDEX IF NOT EXISTS idx_evaluaciones_evaluador ON evaluaciones(evaluado_por);`;
  await sql`CREATE INDEX IF NOT EXISTS idx_personal_sucursal ON personal(sucursal);`;

  // Sembrar el catálogo original solo si la tabla está vacía (primer arranque)
  const { rows } = await sql`SELECT COUNT(*)::int AS count FROM personal;`;
  if (rows[0].count === 0) {
    for (const p of PERSONAL_SEED) {
      await sql`
        INSERT INTO personal (id, nombre, puesto, sucursal, sucursal_code, role, username, password, activo)
        VALUES (${p.id}, ${p.nombre}, ${p.puesto}, ${p.sucursal}, ${p.sucursal_code}, ${p.role}, ${p.username || null}, ${p.password || null}, true)
        ON CONFLICT (id) DO NOTHING;
      `;
    }
    // Sincronizar la secuencia del SERIAL con el id más alto insertado manualmente
    await sql`SELECT setval(pg_get_serial_sequence('personal','id'), (SELECT MAX(id) FROM personal));`;
  }

  schemaReady = true;
}

module.exports = { sql, ensureSchema };

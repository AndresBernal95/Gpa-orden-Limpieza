# GPA — Orden, Limpieza y Acomodo

Aplicación web para el checklist diario de Orden, Limpieza y Acomodo del personal
de almacén de GPA, con datos compartidos en tiempo real entre todas las sucursales
y un panel de Administrador centralizado.

## Estructura del proyecto

- `public/index.html` — la aplicación completa (frontend: login, checklist de
  supervisores, panel de Administrador, reportes y PDF).
- `api/login.js` — valida usuario/contraseña contra la base de datos.
- `api/personal.js` — alta, edición, baja y eliminación de personal.
- `api/evaluaciones.js` — registro y consulta de calificaciones diarias.
- `lib/db.js` — conexión a Postgres y creación automática de las tablas
  (se ejecuta sola la primera vez que el backend recibe una petición).
- `lib/personal-seed.json` — catálogo inicial de personal con el que se siembra
  la base de datos la primera vez (73 personas: operativos, supervisores y admin).

## Cómo se despliega

1. Subir este proyecto a un repositorio de GitHub.
2. En Vercel, importar el repositorio como nuevo proyecto.
3. En la pestaña Storage del proyecto en Vercel, conectar la base de datos
   Postgres (Neon) ya creada.
4. Desplegar. La primera petición creará automáticamente las tablas y sembrará
   el catálogo de personal inicial.

## Usuarios iniciales

Todo el personal supervisor (Jefes/Líderes) y el Administrador pueden iniciar
sesión con su `usuario` (formato nombre.apellido) y la contraseña genérica
`gpa2026` (admin: usuario `admin`, contraseña `admin2026`). El personal operativo
no inicia sesión: solo es evaluado por sus supervisores.

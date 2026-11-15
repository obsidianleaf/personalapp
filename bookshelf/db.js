// Хранилище: PostgreSQL, если задан DATABASE_URL (например, бесплатный Neon),
// иначе встроенная база PGlite в папке DATA_DIR (для локального запуска или сервера с диском).
const path = require('path');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users(
  id serial PRIMARY KEY,
  name text NOT NULL,
  name_key text NOT NULL UNIQUE,
  pass text,
  role text NOT NULL DEFAULT 'member',
  status text NOT NULL DEFAULT 'pending',
  participation text NOT NULL DEFAULT '[]',
  comment text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sessions(
  token text PRIMARY KEY,
  user_id int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS books(
  id serial PRIMARY KEY,
  owner_id int NOT NULL REFERENCES users(id),
  holder_id int REFERENCES users(id),
  author text NOT NULL,
  title text NOT NULL,
  terms text NOT NULL,
  condition text NOT NULL,
  cover_type text NOT NULL,
  genre text NOT NULL DEFAULT '',
  publisher text NOT NULL DEFAULT '',
  year text NOT NULL DEFAULT '',
  link text NOT NULL DEFAULT '',
  comment text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'available',
  reserved_for int REFERENCES users(id),
  reserved_planned text NOT NULL DEFAULT '',
  reserved_until text NOT NULL DEFAULT '',
  due_date text NOT NULL DEFAULT '',
  cover_v int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS covers(
  book_id int PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
  full_img bytea NOT NULL,
  thumb bytea NOT NULL
);
CREATE TABLE IF NOT EXISTS events(
  id serial PRIMARY KEY,
  book_id int,
  book_label text NOT NULL DEFAULT '',
  type text NOT NULL,
  actor_id int,
  from_id int,
  to_id int,
  date text NOT NULL DEFAULT '',
  due_date text NOT NULL DEFAULT '',
  swap_book_id int,
  comment text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS events_book_idx ON events(book_id);
`;

async function open() {
  let db;
  if (process.env.DATABASE_URL) {
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
    pool.on('error', e => console.error('Ошибка соединения с базой:', e.message));
    db = {
      kind: 'PostgreSQL',
      query: (sql, params) => pool.query(sql, params),
      exec: sql => pool.query(sql),
      async tx(fn) {
        const c = await pool.connect();
        try {
          await c.query('BEGIN');
          const out = await fn({ query: (s, p) => c.query(s, p) });
          await c.query('COMMIT');
          return out;
        } catch (e) {
          await c.query('ROLLBACK').catch(() => {});
          throw e;
        } finally { c.release(); }
      },
    };
  } else {
    const { PGlite } = await import('@electric-sql/pglite');
    const dir = process.env.DATA_DIR || path.join(__dirname, 'data');
    const lite = dir === 'memory' ? new PGlite() : new PGlite(dir);
    await lite.waitReady;
    db = {
      kind: dir === 'memory' ? 'PGlite (в памяти)' : `PGlite (${dir})`,
      query: (sql, params) => lite.query(sql, params),
      exec: sql => lite.exec(sql),
      tx: fn => lite.transaction(tx => fn({ query: (s, p) => tx.query(s, p) })),
    };
  }
  await db.exec(SCHEMA);
  return db;
}

module.exports = { open };

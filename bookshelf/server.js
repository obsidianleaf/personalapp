// Виртуальная книжная полка — сервер: раздаёт PWA и хранит участников, книги, обложки и историю.
// Запуск: ADMIN_NAME=Имя ADMIN_PASSWORD=пароль [DATABASE_URL=postgres://...] node server.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const C = require('./public/shared.js');
const { open } = require('./db.js');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png',
};
const MAX_FULL = 300 * 1024;  // обложка после сжатия на телефоне
const MAX_THUMB = 60 * 1024;  // миниатюра для каталога

let db;

class HttpError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const bad = msg => new HttpError(400, msg);
const forbidden = (msg = 'Недостаточно прав для этого действия.') => new HttpError(403, msg);

// ---------- утилиты ----------
const str = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
const text = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const nameKey = n => n.toLowerCase().replace(/ё/g, 'е');
const isDate = v => /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(v));
const optDate = (v, label) => {
  v = str(v, 10);
  if (v && !isDate(v)) throw bad(`Неверная дата: ${label}.`);
  return v;
};
const intId = v => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw bad('Неверный идентификатор.');
  return n;
};
const bookNo = id => String(id).padStart(3, '0');
const bookLabel = b => `№${bookNo(b.id)} · ${b.title} — ${b.author}`;

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return salt.toString('hex') + ':' + crypto.scryptSync(pw, salt, 32).toString('hex');
}
function checkPassword(pw, stored) {
  if (!stored) return false;
  const [salt, hash] = stored.split(':');
  const calc = crypto.scryptSync(pw, Buffer.from(salt, 'hex'), 32);
  const want = Buffer.from(hash, 'hex');
  return calc.length === want.length && crypto.timingSafeEqual(calc, want);
}
function newPassword() {
  const abc = 'abcdefghjkmnpqrstuvwxyz23456789';
  return Array.from(crypto.randomBytes(8), b => abc[b % abc.length]).join('');
}
const sha = s => crypto.createHash('sha256').update(s).digest('hex');

// защита от перебора паролей
const fails = new Map();
function loginGuard(key) {
  const f = fails.get(key);
  if (f && f.until > Date.now()) throw new HttpError(429, 'Слишком много попыток. Попробуйте через 15 минут.');
  if (f && f.until && f.until <= Date.now()) fails.delete(key);
}
function loginFailed(key) {
  const f = fails.get(key) || { n: 0, until: 0 };
  f.n += 1;
  if (f.n >= 10) { f.until = Date.now() + 15 * 60e3; f.n = 0; }
  fails.set(key, f);
}

function readBody(req, limit = 1e6) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'Слишком большой запрос.')); req.destroy(); } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
function sendJson(res, code, obj, headers = {}) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(obj));
}
function cookie(req, name) {
  const m = (req.headers.cookie || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return m ? m[1] : '';
}
function sessionCookie(req, token, maxAge) {
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  return `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`;
}

async function currentUser(req) {
  const token = cookie(req, 'sid');
  if (!token) return null;
  const { rows } = await db.query(
    `SELECT u.id, u.name, u.role, u.status FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = $1`, [sha(token)]);
  return rows[0] && rows[0].status === 'active' ? rows[0] : null;
}
async function activeUser(q, id, label) {
  const { rows } = await q.query(`SELECT id, name FROM users WHERE id = $1 AND status = 'active'`, [intId(id)]);
  if (!rows[0]) throw bad(`Участник не найден: ${label}.`);
  return rows[0];
}
async function lockBook(q, id) {
  const { rows } = await q.query(`SELECT * FROM books WHERE id = $1 FOR UPDATE`, [id]);
  if (!rows[0]) throw new HttpError(404, 'Книга не найдена.');
  return rows[0];
}
function logEvent(q, e) {
  return q.query(
    `INSERT INTO events(book_id, book_label, type, actor_id, from_id, to_id, date, due_date, swap_book_id, comment)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [e.book.id, bookLabel(e.book), e.type, e.actor, e.from || null, e.to || null, e.date || '', e.due || '', e.swap || null, e.comment || '']);
}

const BOOK_SELECT = `
  SELECT b.id, b.owner_id, b.holder_id, b.author, b.title, b.terms, b.condition, b.cover_type, b.genre, b.publisher,
         b.year, b.link, b.comment, b.status, b.reserved_for, b.reserved_planned, b.reserved_until, b.due_date,
         b.cover_v, b.created_at, o.name AS owner_name, h.name AS holder_name, r.name AS reserved_for_name
  FROM books b JOIN users o ON o.id = b.owner_id
  LEFT JOIN users h ON h.id = b.holder_id
  LEFT JOIN users r ON r.id = b.reserved_for`;

function bookFields(body) {
  const f = {
    author: str(body.author, 120), title: str(body.title, 200),
    terms: str(body.terms, 60), condition: str(body.condition, 40), cover_type: str(body.coverType, 40),
    genre: str(body.genre, 60), publisher: str(body.publisher, 100), year: str(body.year, 10),
    link: str(body.link, 500), comment: text(body.comment, 1000),
  };
  if (!f.author) throw bad('Укажите автора.');
  if (!f.title) throw bad('Укажите название книги.');
  if (!C.TERMS.includes(f.terms)) throw bad('Выберите условия передачи.');
  if (!C.CONDITIONS.includes(f.condition)) throw bad('Выберите состояние книги.');
  if (!C.COVER_TYPES.includes(f.cover_type)) throw bad('Выберите тип обложки.');
  return f;
}

function decodeJpeg(dataUrl, max, label) {
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) throw bad(`Не удалось прочитать ${label}.`);
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) throw bad(`Не удалось прочитать ${label}.`);
  if (buf.length > max) throw bad('Фотография слишком большая.');
  return buf;
}
async function saveCover(q, bookId, body) {
  const full = decodeJpeg(body.full, MAX_FULL, 'фотографию');
  const thumb = decodeJpeg(body.thumb, MAX_THUMB, 'миниатюру');
  await q.query(
    `INSERT INTO covers(book_id, full_img, thumb) VALUES($1,$2,$3)
     ON CONFLICT (book_id) DO UPDATE SET full_img = EXCLUDED.full_img, thumb = EXCLUDED.thumb`, [bookId, full, thumb]);
  await q.query(`UPDATE books SET cover_v = cover_v + 1 WHERE id = $1`, [bookId]);
}

// ---------- маршруты ----------
const routes = [];
function route(method, pattern, access, handler) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, access, handler });
}
const canManage = (user, book) => user.role === 'admin' || book.owner_id === user.id;

// --- регистрация и вход ---
route('POST', '/api/register', 'public', async ({ body }) => {
  const name = str(body.name, 40);
  if (name.length < 2) throw bad('Укажите имя, под которым вас знают в клубном чате.');
  if (body.consent !== true) throw bad('Нужно подтвердить участие.');
  const participation = (Array.isArray(body.participation) ? body.participation : []).filter(p => C.PARTICIPATION.includes(p));
  const { rows } = await db.query(`SELECT status FROM users WHERE name_key = $1`, [nameKey(name)]);
  if (rows[0]) {
    throw bad(rows[0].status === 'pending'
      ? 'Заявка с таким именем уже отправлена и ждёт подтверждения админа.'
      : 'Участник с таким именем уже зарегистрирован. Войдите или выберите другое имя.');
  }
  const pending = await db.query(`SELECT count(*)::int AS n FROM users WHERE status = 'pending'`);
  if (pending.rows[0].n >= 200) throw new HttpError(429, 'Слишком много заявок. Напишите админу.');
  await db.query(`INSERT INTO users(name, name_key, participation, comment) VALUES($1,$2,$3,$4)`,
    [name, nameKey(name), JSON.stringify(participation), text(body.comment, 1000)]);
  return { ok: true };
});

route('POST', '/api/login', 'public', async ({ req, body }) => {
  const name = str(body.name, 40);
  const password = String(body.password || '');
  const key = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '') + '|' + nameKey(name);
  loginGuard(key);
  const { rows } = await db.query(`SELECT * FROM users WHERE name_key = $1`, [nameKey(name)]);
  const u = rows[0];
  if (u && u.status === 'pending') throw new HttpError(403, 'Заявка ещё не подтверждена. Пароль пришлёт админ.');
  if (!u || u.status !== 'active' || !checkPassword(password, u.pass)) {
    loginFailed(key);
    throw new HttpError(401, 'Неверное имя или пароль.');
  }
  fails.delete(key);
  const token = crypto.randomBytes(32).toString('hex');
  await db.query(`INSERT INTO sessions(token, user_id) VALUES($1,$2)`, [sha(token), u.id]);
  return { __headers: { 'Set-Cookie': sessionCookie(req, token, 365 * 86400) }, me: { id: u.id, name: u.name, role: u.role } };
});

route('POST', '/api/logout', 'public', async ({ req }) => {
  const token = cookie(req, 'sid');
  if (token) await db.query(`DELETE FROM sessions WHERE token = $1`, [sha(token)]);
  return { __headers: { 'Set-Cookie': sessionCookie(req, '', 0) }, ok: true };
});

route('GET', '/api/me', 'public', async ({ user }) => ({ me: user ? { id: user.id, name: user.name, role: user.role } : null }));

route('POST', '/api/me/password', 'member', async ({ req, user, body }) => {
  const next = String(body.next || '');
  if (next.length < 6 || next.length > 100) throw bad('Новый пароль — не короче 6 символов.');
  const { rows } = await db.query(`SELECT pass FROM users WHERE id = $1`, [user.id]);
  if (!checkPassword(String(body.current || ''), rows[0].pass)) throw bad('Текущий пароль указан неверно.');
  await db.query(`UPDATE users SET pass = $1 WHERE id = $2`, [hashPassword(next), user.id]);
  await db.query(`DELETE FROM sessions WHERE user_id = $1 AND token <> $2`, [user.id, sha(cookie(req, 'sid'))]);
  return { ok: true };
});

// --- каталог ---
route('GET', '/api/state', 'member', async () => {
  const [books, members] = await Promise.all([
    db.query(BOOK_SELECT + ` ORDER BY b.id DESC`),
    db.query(`SELECT id, name FROM users WHERE status = 'active' ORDER BY name`),
  ]);
  return { books: books.rows, members: members.rows };
});

route('GET', '/api/events', 'member', async ({ query }) => {
  const bookId = query.get('bookId');
  const sql = `
    SELECT e.id, e.book_id, e.book_label, e.type, e.date, e.due_date, e.swap_book_id, e.comment, e.created_at,
           a.name AS actor_name, f.name AS from_name, t.name AS to_name
    FROM events e LEFT JOIN users a ON a.id = e.actor_id LEFT JOIN users f ON f.id = e.from_id LEFT JOIN users t ON t.id = e.to_id`;
  const { rows } = bookId
    ? await db.query(sql + ` WHERE e.book_id = $1 ORDER BY e.id DESC LIMIT 100`, [intId(bookId)])
    : await db.query(sql + ` ORDER BY e.id DESC LIMIT 300`);
  return { events: rows };
});

route('POST', '/api/books', 'member', async ({ user, body }) => {
  const f = bookFields(body);
  let ownerId = user.id;
  if (user.role === 'admin' && body.ownerId) ownerId = (await activeUser(db, body.ownerId, 'владелец')).id;
  return db.tx(async q => {
    const { rows } = await q.query(
      `INSERT INTO books(owner_id, holder_id, author, title, terms, condition, cover_type, genre, publisher, year, link, comment)
       VALUES($1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [ownerId, f.author, f.title, f.terms, f.condition, f.cover_type, f.genre, f.publisher, f.year, f.link, f.comment]);
    const book = rows[0];
    if (body.cover) await saveCover(q, book.id, body.cover);
    await logEvent(q, { book, type: 'added', actor: user.id, from: ownerId });
    return { id: book.id };
  });
});

route('PUT', '/api/books/:id', 'member', async ({ user, body, params }) => {
  const f = bookFields(body);
  return db.tx(async q => {
    const book = await lockBook(q, intId(params.id));
    if (!canManage(user, book)) throw forbidden('Изменять сведения может только владелец книги.');
    await q.query(
      `UPDATE books SET author=$2, title=$3, terms=$4, condition=$5, cover_type=$6, genre=$7, publisher=$8, year=$9, link=$10, comment=$11 WHERE id=$1`,
      [book.id, f.author, f.title, f.terms, f.condition, f.cover_type, f.genre, f.publisher, f.year, f.link, f.comment]);
    return { ok: true };
  });
});

route('DELETE', '/api/books/:id', 'member', async ({ user, params }) => db.tx(async q => {
  const book = await lockBook(q, intId(params.id));
  if (!canManage(user, book)) throw forbidden('Убрать книгу из каталога может только владелец.');
  if (book.status === 'reserved' || book.status === 'lent') throw bad('Сначала отмените бронь или оформите возврат книги.');
  await logEvent(q, { book, type: 'deleted', actor: user.id });
  await q.query(`DELETE FROM books WHERE id = $1`, [book.id]);
  return { ok: true };
}));

route('PUT', '/api/books/:id/cover', 'member', async ({ user, body, params }) => db.tx(async q => {
  const book = await lockBook(q, intId(params.id));
  if (!canManage(user, book)) throw forbidden('Добавить фото может только владелец книги.');
  await saveCover(q, book.id, body);
  return { ok: true };
}));

route('DELETE', '/api/books/:id/cover', 'member', async ({ user, params }) => db.tx(async q => {
  const book = await lockBook(q, intId(params.id));
  if (!canManage(user, book)) throw forbidden('Удалить фото может только владелец книги.');
  await q.query(`DELETE FROM covers WHERE book_id = $1`, [book.id]);
  await q.query(`UPDATE books SET cover_v = 0 WHERE id = $1`, [book.id]);
  return { ok: true };
}));

// --- бронирование, передача, возврат, отмена ---
route('POST', '/api/books/:id/reserve', 'member', async ({ user, body, params }) => db.tx(async q => {
  const book = await lockBook(q, intId(params.id));
  if (!canManage(user, book)) throw forbidden('Бронирование оформляет владелец книги. Договоритесь с ним в чате клуба.');
  if (book.status !== 'available') throw bad('Забронировать можно только свободную книгу.');
  const to = await activeUser(q, body.forUserId, 'для кого бронируется книга');
  if (to.id === book.owner_id) throw bad('Нельзя забронировать книгу для её владельца.');
  const planned = optDate(body.plannedDate, 'планируемая дата передачи');
  const until = optDate(body.until, 'бронь до');
  await q.query(`UPDATE books SET status='reserved', reserved_for=$2, reserved_planned=$3, reserved_until=$4 WHERE id=$1`,
    [book.id, to.id, planned, until]);
  await logEvent(q, { book, type: 'reserved', actor: user.id, from: book.owner_id, to: to.id, date: planned, due: until, comment: text(body.comment, 1000) });
  return { ok: true };
}));

route('POST', '/api/books/:id/cancel', 'member', async ({ user, body, params }) => db.tx(async q => {
  const book = await lockBook(q, intId(params.id));
  if (book.status !== 'reserved') throw bad('Отменить можно только действующее бронирование.');
  if (!canManage(user, book) && book.reserved_for !== user.id) throw forbidden('Отменить бронь может владелец книги или тот, для кого она забронирована.');
  await q.query(`UPDATE books SET status='available', reserved_for=NULL, reserved_planned='', reserved_until='' WHERE id=$1`, [book.id]);
  await logEvent(q, { book, type: 'cancelled', actor: user.id, from: book.owner_id, to: book.reserved_for, comment: text(body.reason, 1000) });
  return { ok: true };
}));

route('POST', '/api/books/:id/transfer', 'member', async ({ user, body, params }) => db.tx(async q => {
  const book = await lockBook(q, intId(params.id));
  const type = str(body.type, 20);
  if (!C.TRANSFER_TYPES[type]) throw bad('Выберите тип операции.');
  const date = str(body.date, 10);
  if (!isDate(date)) throw bad('Укажите дату передачи или возврата.');
  const comment = text(body.comment, 1000);
  const clear = `reserved_for=NULL, reserved_planned='', reserved_until=''`;

  if (type === 'return') {
    if (book.status !== 'lent') throw bad('Вернуть можно только книгу, которую дали почитать.');
    if (!canManage(user, book) && book.holder_id !== user.id) throw forbidden('Возврат оформляет владелец книги или тот, кто её возвращает.');
    await q.query(`UPDATE books SET status='available', holder_id=owner_id, due_date='', ${clear} WHERE id=$1`, [book.id]);
    await logEvent(q, { book, type, actor: user.id, from: book.holder_id, to: book.owner_id, date, comment });
    return { ok: true };
  }

  if (!canManage(user, book)) throw forbidden('Передачу оформляет владелец книги.');
  if (book.status !== 'available' && book.status !== 'reserved') throw bad('Эту книгу сейчас нельзя передать: она уже на руках или передана.');
  const to = await activeUser(q, body.toUserId, 'кому передана книга');
  if (to.id === book.owner_id) throw bad('Получатель совпадает с владельцем книги.');

  if (type === 'lend') {
    const due = optDate(body.dueDate, 'вернуть до');
    await q.query(`UPDATE books SET status='lent', holder_id=$2, due_date=$3, ${clear} WHERE id=$1`, [book.id, to.id, due]);
    await logEvent(q, { book, type, actor: user.id, from: book.owner_id, to: to.id, date, due, comment });
    return { ok: true };
  }

  // «Отдал(а) навсегда» и «Обменял(а)»: книга переходит новому владельцу и уходит с полки
  let swap = null;
  if (type === 'exchange' && body.swapBookId) {
    swap = await lockBook(q, intId(body.swapBookId));
    if (swap.id === book.id || swap.owner_id !== to.id) throw bad('Книга взамен должна принадлежать получателю.');
    if (swap.status !== 'available' && swap.status !== 'reserved') throw bad('Книга взамен сейчас на руках или уже передана.');
  }
  const give = `UPDATE books SET status='gone', owner_id=$2, holder_id=$2, due_date='', ${clear} WHERE id=$1`;
  await q.query(give, [book.id, to.id]);
  await logEvent(q, { book, type, actor: user.id, from: book.owner_id, to: to.id, date, swap: swap && swap.id, comment });
  if (swap) {
    await q.query(give, [swap.id, book.owner_id]);
    await logEvent(q, { book: swap, type, actor: user.id, from: to.id, to: book.owner_id, date, swap: book.id, comment });
  }
  return { ok: true };
}));

// новый владелец может снова выставить полученную книгу на полку
route('POST', '/api/books/:id/relist', 'member', async ({ user, params }) => db.tx(async q => {
  const book = await lockBook(q, intId(params.id));
  if (!canManage(user, book)) throw forbidden();
  if (book.status !== 'gone') throw bad('Книга уже на полке.');
  await q.query(`UPDATE books SET status='available' WHERE id=$1`, [book.id]);
  await logEvent(q, { book, type: 'relisted', actor: user.id, from: book.owner_id });
  return { ok: true };
}));

// --- админ ---
route('GET', '/api/admin/users', 'admin', async () => {
  const { rows } = await db.query(
    `SELECT id, name, role, status, participation, comment, created_at FROM users ORDER BY (status = 'pending') DESC, name`);
  return { users: rows.map(u => ({ ...u, participation: JSON.parse(u.participation || '[]') })) };
});

route('POST', '/api/admin/users', 'admin', async ({ body }) => {
  const name = str(body.name, 40);
  if (name.length < 2) throw bad('Укажите имя участника.');
  const exists = await db.query(`SELECT 1 FROM users WHERE name_key = $1`, [nameKey(name)]);
  if (exists.rows[0]) throw bad('Участник или заявка с таким именем уже есть.');
  const password = newPassword();
  await db.query(`INSERT INTO users(name, name_key, pass, status) VALUES($1,$2,$3,'active')`, [name, nameKey(name), hashPassword(password)]);
  return { name, password };
});

route('POST', '/api/admin/users/:id/:action', 'admin', async ({ user, params }) => {
  const id = intId(params.id);
  const { rows } = await db.query(`SELECT * FROM users WHERE id = $1`, [id]);
  const u = rows[0];
  if (!u) throw new HttpError(404, 'Участник не найден.');
  switch (params.action) {
    case 'approve':   // подтвердить заявку и выдать пароль
    case 'reset': {   // выдать новый пароль
      if (params.action === 'approve' && u.status !== 'pending') throw bad('Заявка уже обработана.');
      if (params.action === 'reset' && u.status === 'pending') throw bad('Сначала подтвердите заявку.');
      const password = newPassword();
      await db.query(`UPDATE users SET pass = $1, status = 'active' WHERE id = $2`, [hashPassword(password), id]);
      await db.query(`DELETE FROM sessions WHERE user_id = $1`, [id]);
      return { name: u.name, password };
    }
    case 'reject':
      if (u.status !== 'pending') throw bad('Отклонить можно только неподтверждённую заявку.');
      await db.query(`DELETE FROM users WHERE id = $1`, [id]);
      return { ok: true };
    case 'block':
      if (id === user.id) throw bad('Нельзя заблокировать самого себя.');
      await db.query(`UPDATE users SET status = 'blocked' WHERE id = $1`, [id]);
      await db.query(`DELETE FROM sessions WHERE user_id = $1`, [id]);
      return { ok: true };
    case 'admin':
    case 'member':
      if (id === user.id) throw bad('Свою роль изменить нельзя.');
      if (u.status !== 'active') throw bad('Участник не активен.');
      await db.query(`UPDATE users SET role = $1 WHERE id = $2`, [params.action, id]);
      return { ok: true };
    default:
      throw new HttpError(404, 'Неизвестное действие.');
  }
});

// ---------- обработка запросов ----------
async function serveCover(req, res, url, user) {
  if (!user) { res.writeHead(401); return res.end(); }
  const m = /^\/api\/covers\/(\d+)\/(full|thumb)$/.exec(url.pathname);
  if (!m) { res.writeHead(404); return res.end(); }
  const col = m[2] === 'full' ? 'full_img' : 'thumb';
  const { rows } = await db.query(`SELECT ${col} AS img FROM covers WHERE book_id = $1`, [Number(m[1])]);
  if (!rows[0]) { res.writeHead(404); return res.end(); }
  // адрес содержит версию обложки (?v=), поэтому можно кэшировать надолго
  res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=31536000, immutable' });
  res.end(Buffer.from(rows[0].img));
}

function serveStatic(res, url) {
  const file = path.normalize(path.join(PUBLIC, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname)));
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
    });
    res.end(buf);
  });
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  if (!url.pathname.startsWith('/api/')) return serveStatic(res, url);
  if (req.method === 'GET' && url.pathname.startsWith('/api/covers/')) return serveCover(req, res, url, await currentUser(req));

  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = r.re.exec(url.pathname);
    if (!m) continue;
    const params = Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1]]));
    const user = await currentUser(req);
    if (r.access !== 'public' && !user) throw new HttpError(401, 'Войдите в приложение.');
    if (r.access === 'admin' && user.role !== 'admin') throw forbidden();
    let body = {};
    if (req.method !== 'GET') {
      // только JSON: это же защищает от подделки запросов с чужих сайтов
      if (!/^application\/json/.test(req.headers['content-type'] || '')) throw new HttpError(415, 'Ожидается JSON.');
      try { body = JSON.parse((await readBody(req)) || '{}'); } catch (e) {
        if (e instanceof HttpError) throw e;
        throw bad('Некорректный запрос.');
      }
      if (!body || typeof body !== 'object') throw bad('Некорректный запрос.');
    }
    const out = await r.handler({ req, res, params, body, user, query: url.searchParams });
    const { __headers, ...payload } = out || {};
    return sendJson(res, 200, payload, __headers);
  }
  throw new HttpError(404, 'Не найдено.');
}

async function ensureAdmin() {
  const { rows } = await db.query(`SELECT 1 FROM users WHERE role = 'admin' AND status = 'active' LIMIT 1`);
  if (rows[0]) return;
  const name = str(process.env.ADMIN_NAME, 40) || 'Админ';
  const given = process.env.ADMIN_PASSWORD;
  const password = given || newPassword();
  await db.query(
    `INSERT INTO users(name, name_key, pass, role, status) VALUES($1,$2,$3,'admin','active')
     ON CONFLICT (name_key) DO UPDATE SET pass = EXCLUDED.pass, role = 'admin', status = 'active'`,
    [name, nameKey(name), hashPassword(password)]);
  console.log(`Создан админ «${name}».` + (given ? '' : ` Временный пароль: ${password} (смените его в приложении)`));
}

async function main() {
  db = await open();
  await ensureAdmin();
  http.createServer((req, res) => {
    handle(req, res).catch(e => {
      if (res.headersSent) return res.end();
      if (e instanceof HttpError) return sendJson(res, e.code, { error: e.message });
      console.error(e);
      sendJson(res, 500, { error: 'Что-то пошло не так. Попробуйте ещё раз.' });
    });
  }).listen(PORT, () => console.log(`Виртуальная книжная полка: http://localhost:${PORT}  База: ${db.kind}`));
}
main().catch(e => { console.error(e); process.exit(1); });

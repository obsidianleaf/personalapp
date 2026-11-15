/* Виртуальная книжная полка — клиентская часть (без сборки и библиотек). */
const C = self.SHELF;
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const no = id => String(id).padStart(3, '0');
const today = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
const fmtDate = d => (d ? d.split('-').reverse().join('.') : '');
const fmtStamp = iso => new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

const state = {
  me: null, books: [], members: [], users: [], events: null,
  tab: 'catalog', authTab: 'login',
  q: '', fStatus: 'shelf', fTerms: '', fGenre: '', fOwner: '',
};

// ---------- сервер ----------
async function api(method, url, body) {
  let res;
  try {
    res = await fetch(url, {
      method, credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch { throw new Error('Нет связи с сервером. Проверьте интернет и попробуйте ещё раз.'); }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && state.me) { state.me = null; closeModal(); render(); }
  if (!res.ok) throw new Error(data.error || 'Что-то пошло не так. Попробуйте ещё раз.');
  return data;
}

async function refresh() {
  const { me } = await api('GET', '/api/me');
  state.me = me;
  if (me) {
    const [s, a] = await Promise.all([
      api('GET', '/api/state'),
      me.role === 'admin' ? api('GET', '/api/admin/users') : { users: [] },
    ]);
    state.books = s.books; state.members = s.members; state.users = a.users;
    if (state.tab === 'history') state.events = (await api('GET', '/api/events')).events;
  }
  render();
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 2600);
}

// ---------- окно поверх экрана ----------
function openModal(title, html) {
  const m = $('#modal');
  m.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <div class="sheet-head"><h2>${esc(title)}</h2><button class="close" data-close aria-label="Закрыть">×</button></div>${html}</div>`;
  m.hidden = false;
  document.body.style.overflow = 'hidden';
  return $('.sheet', m);
}
function closeModal() {
  $('#modal').hidden = true; $('#modal').innerHTML = '';
  document.body.style.overflow = '';
}
$('#modal').addEventListener('click', e => { if (e.target.id === 'modal' || e.target.closest('[data-close]')) closeModal(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#modal').hidden) closeModal(); });

// отправка формы с блокировкой кнопки и показом ошибки
function onSubmit(form, handler) {
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const btn = $('button[type=submit]', form);
    const err = $('.form-error', form);
    if (err) err.hidden = true;
    btn.disabled = true;
    try { await handler(Object.fromEntries(new FormData(form))); }
    catch (ex) { if (err) { err.textContent = ex.message; err.hidden = false; err.scrollIntoView({ block: 'nearest' }); } else toast(ex.message); }
    finally { btn.disabled = false; }
  });
}

// ---------- кусочки разметки ----------
const field = (label, control, { hint = '', req = false } = {}) => `
  <label class="field"><span class="label">${esc(label)}${req ? ' <span class="req" aria-hidden="true">*</span>' : ''}</span>
  ${hint ? `<span class="hint">${esc(hint)}</span>` : ''}${control}</label>`;
const options = (list, selected, placeholder) =>
  (placeholder != null ? `<option value="">${esc(placeholder)}</option>` : '') +
  list.map(o => { const [v, t] = Array.isArray(o) ? o : [o, o]; return `<option value="${esc(v)}"${String(v) === String(selected) ? ' selected' : ''}>${esc(t)}</option>`; }).join('');
const memberOptions = (selected, exceptId, placeholder = 'Выберите участника') =>
  options(state.members.filter(m => m.id !== exceptId).map(m => [m.id, m.name]), selected, placeholder);

function statusOf(b) {
  const t = today();
  if (b.status === 'available') return { cls: 'ok', short: 'Свободна', long: `Книга свободна и находится у владельца (${b.owner_name}).` };
  if (b.status === 'reserved') {
    const expired = b.reserved_until && b.reserved_until < t;
    return {
      cls: expired ? 'bad' : 'warn',
      short: `Бронь: ${b.reserved_for_name}` + (b.reserved_until ? ` до ${fmtDate(b.reserved_until)}` : ''),
      long: `Забронирована для участника ${b.reserved_for_name}.` +
        (b.reserved_planned ? ` Планируемая дата передачи: ${fmtDate(b.reserved_planned)}.` : '') +
        (b.reserved_until ? ` Бронь до ${fmtDate(b.reserved_until)}${expired ? ' — срок брони истёк' : ''}.` : ''),
    };
  }
  if (b.status === 'lent') {
    const overdue = b.due_date && b.due_date < t;
    return {
      cls: overdue ? 'bad' : 'info',
      short: `Читает ${b.holder_name}` + (b.due_date ? ` · до ${fmtDate(b.due_date)}` : ''),
      long: `Книгу читает ${b.holder_name}.` + (b.due_date ? ` Вернуть до ${fmtDate(b.due_date)}${overdue ? ' — срок возврата прошёл' : ''}.` : ''),
    };
  }
  return { cls: 'off', short: 'Передана навсегда', long: `Книга передана навсегда. Новый владелец: ${b.owner_name}.` };
}

const coverUrl = (b, size) => `/api/covers/${b.id}/${size}?v=${b.cover_v}`;
const thumbHtml = (b, cls = 'thumb') => b.cover_v
  ? `<img class="${cls}" src="${coverUrl(b, 'thumb')}" alt="" loading="lazy">`
  : `<span class="${cls}" aria-hidden="true">${esc((b.title.match(/[\p{L}\p{N}]/u) || ['?'])[0].toUpperCase())}</span>`;

function bookCard(b) {
  const s = statusOf(b);
  return `<button class="book" data-book="${b.id}">
    ${thumbHtml(b)}
    <span class="book-body">
      <span class="book-title">${esc(b.title)}</span>
      <span class="book-meta">${esc(b.author)}</span>
      <span class="book-meta">№${no(b.id)} · ${esc(b.owner_name)} · ${esc(b.terms)}</span>
      <span class="badge ${s.cls}">${esc(s.short)}</span>
    </span></button>`;
}
const bookList = (books, empty) => books.length ? `<div class="book-list">${books.map(bookCard).join('')}</div>` : `<div class="empty">${empty}</div>`;

const HOW_IT_WORKS = `<ol class="steps">
  <li>Зарегистрируйтесь: укажите своё имя из чата клуба. Пароль пришлёт админ.</li>
  <li>Откройте каталог и выберите интересующую книгу.</li>
  <li>Договоритесь с владельцем в группе клуба об условиях и дате встречи.</li>
  <li>Оформите действие в приложении — каталог обновится сам. Бронь, передачу и возврат оформляет владелец книги, а не тот, кто хочет её получить.</li>
</ol>`;
const RULES = `<ul class="rules">
  <li>Участие добровольное. Необязательно делиться своими книгами, чтобы читать чужие.</li>
  <li>Если вы получили книгу на время, бережно относитесь к ней и соблюдайте сроки возврата.</li>
</ul>`;

// ---------- вход и регистрация ----------
function renderAuth() {
  const login = state.authTab === 'login';
  $('#app').innerHTML = `<main class="page">
    <div class="auth-hero"><img src="icon.svg" alt=""><h1>Виртуальная книжная полка</h1>
      <p class="muted">Книжный клуб: дарим, меняем и даём почитать бумажные книги</p></div>
    <div class="seg">
      <button data-auth="login" aria-pressed="${login}">Вход</button>
      <button data-auth="register" aria-pressed="${!login}">Регистрация</button>
    </div>
    ${login ? `<form id="login-form" class="card">
      <div class="form-error" hidden></div>
      ${field('Имя в чате книжного клуба', `<input type="text" name="name" autocomplete="username" required>`)}
      ${field('Пароль', `<input type="password" name="password" autocomplete="current-password" required>`, { hint: 'Пароль присылает админ после подтверждения заявки.' })}
      <button type="submit" class="btn primary block">Войти</button>
    </form>` : `<form id="register-form" class="card">
      <p class="small muted">Регистрация участников виртуальной книжной полки книжного клуба. Предлагать книгу при регистрации необязательно. Участие подтверждается модератором.</p>
      <div class="form-error" hidden></div>
      ${field('Имя в чате книжного клуба', `<input type="text" name="name" maxlength="40" required>`, { req: true, hint: 'Укажите имя, под которым вас знают в клубном чате.' })}
      <fieldset class="field" style="border:0;padding:0;margin:0 0 14px"><legend class="label">Как планируете участвовать?</legend>
        ${C.PARTICIPATION.map(p => `<label class="check"><input type="checkbox" name="participation" value="${esc(p)}"><span>${esc(p)}</span></label>`).join('')}
      </fieldset>
      <div class="field"><span class="label">Подтверждение участия <span class="req" aria-hidden="true">*</span></span>
        <label class="check"><input type="checkbox" name="consent" required><span>Хочу участвовать и согласен(на), что моё имя из чата будет отображаться в каталоге и истории передач, доступных участникам клуба.</span></label></div>
      ${field('Комментарий', `<textarea name="comment" maxlength="1000"></textarea>`, { hint: 'Необязательно. Можно оставить пожелания или вопросы.' })}
      <button type="submit" class="btn primary block">Отправить заявку</button>
    </form>`}
    <div class="card"><h3>Как это работает?</h3>${HOW_IT_WORKS}</div>
    <div class="card"><h3>Правила виртуальной полки</h3>${RULES}</div>
  </main>`;

  $$('[data-auth]').forEach(b => b.addEventListener('click', () => { state.authTab = b.dataset.auth; renderAuth(); }));
  if (login) {
    onSubmit($('#login-form'), async f => { await api('POST', '/api/login', f); await refresh(); });
  } else {
    const form = $('#register-form');
    onSubmit(form, async f => {
      await api('POST', '/api/register', {
        name: f.name, comment: f.comment, consent: $('[name=consent]', form).checked,
        participation: $$('[name=participation]:checked', form).map(i => i.value),
      });
      form.outerHTML = `<div class="card"><h3>Заявка отправлена</h3><p style="margin-top:8px">Спасибо, ${esc(f.name.trim())}! Админ подтвердит участие и пришлёт пароль в личные сообщения. После этого войдите на вкладке «Вход».</p></div>`;
    });
  }
}

// ---------- основной экран ----------
const ICONS = {
  catalog: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4v15M9.5 4v15M14 6l3.5 12.5M3 20h18"/></svg>',
  mine: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 5a2 2 0 0 1 2-2h11v15H7a2 2 0 0 0-2 2z"/><path d="M5 20a2 2 0 0 0 2 2h11v-4"/></svg>',
  history: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
  more: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="3.5"/><path d="M5 20c.8-3.5 3.6-5.5 7-5.5s6.2 2 7 5.5"/></svg>',
};
const TABS = [['catalog', 'Каталог'], ['mine', 'Мои книги'], ['history', 'История'], ['more', 'Профиль']];

function render() {
  if (!state.me) return renderAuth();
  const pending = state.users.filter(u => u.status === 'pending').length;
  const view = { catalog: viewCatalog, mine: viewMine, history: viewHistory, more: viewMore }[state.tab]();
  $('#app').innerHTML = `<main class="page">${view}</main>
    ${state.tab === 'catalog' || state.tab === 'mine' ? '<button class="fab" data-act="add-book">+ Добавить книгу</button>' : ''}
    <nav class="tabs" aria-label="Разделы">${TABS.map(([id, label]) => `
      <button data-tab="${id}" ${state.tab === id ? 'aria-current="page"' : ''}>${ICONS[id]}<span>${label}</span>
      ${id === 'more' && pending ? `<span class="dot" aria-label="Новых заявок: ${pending}">${pending}</span>` : ''}</button>`).join('')}</nav>`;
  if (state.tab === 'catalog') bindCatalog();
}

// --- каталог ---
const STATUS_FILTERS = [['shelf', 'На полке'], ['available', 'Свободные'], ['reserved', 'Забронированы'], ['lent', 'На руках'], ['gone', 'Переданы навсегда']];

function filteredBooks() {
  const q = state.q.trim().toLowerCase();
  return state.books.filter(b =>
    (state.fStatus === 'shelf' ? b.status !== 'gone' : b.status === state.fStatus) &&
    (!state.fTerms || b.terms.includes(state.fTerms)) &&
    (!state.fGenre || b.genre === state.fGenre) &&
    (!state.fOwner || String(b.owner_id) === state.fOwner) &&
    (!q || [b.title, b.author, b.genre, b.publisher, b.owner_name, no(b.id)].some(v => v.toLowerCase().includes(q))));
}
function catalogList() {
  const list = filteredBooks();
  const any = state.books.some(b => b.status !== 'gone');
  return `<p class="small muted" style="margin:0 0 8px">Книг: ${list.length}</p>` +
    bookList(list, any ? 'Ничего не найдено. Попробуйте изменить поиск или фильтры.' : 'На полке пока нет книг. Добавьте первую!');
}
function viewCatalog() {
  const genres = [...new Set(state.books.map(b => b.genre).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru'));
  const owners = [...new Map(state.books.map(b => [b.owner_id, b.owner_name])).entries()].sort((a, b) => a[1].localeCompare(b[1], 'ru'));
  return `<div class="page-head"><h1>Каталог</h1></div>
    <input class="search" type="search" id="q" placeholder="Название, автор, владелец или № книги" value="${esc(state.q)}" aria-label="Поиск по каталогу">
    <div class="chips" role="group" aria-label="Статус">${STATUS_FILTERS.map(([v, t]) => `<button class="chip" data-status="${v}" aria-pressed="${state.fStatus === v}">${t}</button>`).join('')}</div>
    <div class="filters">
      <select id="f-terms" aria-label="Условия передачи">${options(['Отдам навсегда', 'Обменяю', 'Дам почитать', 'Договоримся'], state.fTerms, 'Любые условия')}</select>
      <select id="f-genre" aria-label="Жанр">${options(genres, state.fGenre, 'Все жанры')}</select>
      <select id="f-owner" class="wide" aria-label="Владелец">${options(owners, state.fOwner, 'Все владельцы')}</select>
    </div>
    <div id="catalog-list">${catalogList()}</div>`;
}
function bindCatalog() {
  const redraw = () => { $('#catalog-list').innerHTML = catalogList(); };
  $('#q').addEventListener('input', e => { state.q = e.target.value; redraw(); });
  $('#f-terms').addEventListener('change', e => { state.fTerms = e.target.value; redraw(); });
  $('#f-genre').addEventListener('change', e => { state.fGenre = e.target.value; redraw(); });
  $('#f-owner').addEventListener('change', e => { state.fOwner = e.target.value; redraw(); });
}

// --- мои книги ---
function viewMine() {
  const me = state.me.id;
  const groups = [
    ['Мои книги на полке', state.books.filter(b => b.owner_id === me && b.status !== 'gone'), 'Вы пока не добавили ни одной книги.'],
    ['Сейчас читаю', state.books.filter(b => b.status === 'lent' && b.holder_id === me), ''],
    ['Забронировано для меня', state.books.filter(b => b.status === 'reserved' && b.reserved_for === me), ''],
    ['Получены навсегда', state.books.filter(b => b.owner_id === me && b.status === 'gone'), ''],
  ];
  return `<div class="page-head"><h1>Мои книги</h1></div>
    <p class="note">Здесь ваш кабинет: добавляйте книги, бронируйте их для участников клуба, оформляйте передачу и возврат. Нажмите на книгу, чтобы выбрать действие.</p>` +
    groups.filter(([, list, empty]) => list.length || empty).map(([title, list, empty]) =>
      `<h2 class="section-title">${title} <span class="count">${list.length}</span></h2>${bookList(list, empty)}`).join('');
}

// --- история ---
function eventText(e) {
  const from = esc(e.from_name || '—'), to = esc(e.to_name || '—'), actor = esc(e.actor_name || '—');
  const swap = e.swap_book_id ? ` (взамен — книга №${no(e.swap_book_id)})` : '';
  switch (e.type) {
    case 'added': return `${from}: книга добавлена в каталог`;
    case 'reserved': return `${from} → ${to}: бронь` + (e.date ? `, встреча ${fmtDate(e.date)}` : '') + (e.due_date ? `, бронь до ${fmtDate(e.due_date)}` : '');
    case 'cancelled': return `${actor}: бронь для участника ${to} отменена`;
    case 'lend': return `${from} → ${to}: дал(а) почитать` + (e.due_date ? `, вернуть до ${fmtDate(e.due_date)}` : '');
    case 'give': return `${from} → ${to}: отдал(а) навсегда`;
    case 'exchange': return `${from} → ${to}: обменял(а)${swap}`;
    case 'return': return `${from} → ${to}: книгу вернули`;
    case 'relisted': return `${actor}: книга снова на полке`;
    case 'deleted': return `${actor}: книга убрана из каталога`;
    default: return e.type;
  }
}
const timeline = (events, withBook) => events.length ? `<ul class="timeline">${events.map(e => `<li>
  <div class="when">${e.date && e.type !== 'reserved' ? fmtDate(e.date) + ' · запись от ' : ''}${fmtStamp(e.created_at)}</div>
  <div class="what">${eventText(e)}</div>
  ${withBook ? `<div class="book-ref">${esc(e.book_label)}</div>` : ''}
  ${e.comment ? `<div class="cmt">«${esc(e.comment)}»</div>` : ''}</li>`).join('')}</ul>` : '<div class="empty">Записей пока нет.</div>';

function viewHistory() {
  return `<div class="page-head"><h1>История</h1></div>
    <p class="small muted">Все бронирования, передачи и возвраты книг клуба.</p>
    ${state.events ? timeline(state.events, true) : '<div class="empty">Загрузка…</div>'}`;
}

// --- профиль и админ ---
function viewMore() {
  const admin = state.me.role === 'admin';
  const pending = state.users.filter(u => u.status === 'pending');
  const others = state.users.filter(u => u.status !== 'pending');
  return `<div class="page-head"><h1>Профиль</h1></div>
    <div class="card"><h3>${esc(state.me.name)}</h3><p class="muted small" style="margin:4px 0 12px">${admin ? 'Админ клуба' : 'Участник клуба'}</p>
      <div class="btn-row"><button class="btn" data-act="password">Сменить пароль</button><button class="btn" data-act="logout">Выйти</button></div></div>
    ${admin ? `<div class="card"><h3>Заявки на участие ${pending.length ? `<span class="badge bad">${pending.length}</span>` : ''}</h3>
      ${pending.length ? pending.map(u => `<div class="user-row"><div class="who"><b>${esc(u.name)}</b>
        ${u.participation.length ? `<div class="small muted">${u.participation.map(esc).join(' · ')}</div>` : ''}
        ${u.comment ? `<div class="small">«${esc(u.comment)}»</div>` : ''}</div>
        <div class="btn-row"><button class="btn sm primary" data-user="${u.id}" data-do="approve">Подтвердить</button>
        <button class="btn sm danger" data-user="${u.id}" data-do="reject">Отклонить</button></div></div>`).join('')
        : '<p class="muted small" style="margin:8px 0 0">Новых заявок нет.</p>'}</div>
    <div class="card"><h3>Участники <span class="muted small">${others.length}</span></h3>
      ${others.map(u => `<div class="user-row"><div class="who"><b>${esc(u.name)}</b>
        ${u.role === 'admin' ? ' <span class="badge info">админ</span>' : ''}${u.status === 'blocked' ? ' <span class="badge off">заблокирован(а)</span>' : ''}</div>
        <button class="btn sm" data-user="${u.id}" data-do="menu">Управление</button></div>`).join('')}
      <button class="btn block" style="margin-top:10px" data-act="add-user">+ Добавить участника</button></div>` : ''}
    <div class="card"><h3>Как это работает?</h3>${HOW_IT_WORKS}</div>
    <div class="card"><h3>Правила виртуальной полки</h3>${RULES}</div>`;
}

// ---------- карточка книги ----------
async function openBook(id) {
  const b = state.books.find(x => x.id === id);
  if (!b) return;
  const s = statusOf(b);
  const me = state.me, mine = b.owner_id === me.id || me.role === 'admin';
  const link = /^https?:\/\//i.test(b.link) ? `<a href="${esc(b.link)}" target="_blank" rel="noopener noreferrer">${esc(b.link)}</a>` : esc(b.link);
  const prop = (k, v) => v ? `<dt>${k}</dt><dd>${v}</dd>` : '';

  const actions = [];
  if (mine && b.status === 'available') actions.push(['reserve', 'Забронировать', 'primary']);
  if (mine && (b.status === 'available' || b.status === 'reserved')) actions.push(['transfer', 'Передать книгу', b.status === 'reserved' ? 'primary' : '']);
  if (b.status === 'lent' && (mine || b.holder_id === me.id)) actions.push(['transfer', 'Оформить возврат', 'primary']);
  if (b.status === 'reserved' && (mine || b.reserved_for === me.id)) actions.push(['cancel', 'Отменить бронь', '']);
  if (mine && b.status === 'gone') actions.push(['relist', 'Вернуть на полку', 'primary']);
  if (mine) actions.push(['edit', 'Изменить сведения', ''], ['cover', b.cover_v ? 'Заменить фото' : 'Добавить фото обложки', '']);
  if (mine && (b.status === 'available' || b.status === 'gone')) actions.push(['delete', 'Убрать из каталога', 'danger']);

  const sheet = openModal(`Книга №${no(b.id)}`, `
    <div class="detail-top">
      ${b.cover_v ? `<button class="cover-big" data-go="zoom" aria-label="Открыть обложку крупно"><img class="cover-big" style="border:0" src="${coverUrl(b, 'thumb')}" alt="Обложка"></button>` : thumbHtml(b, 'cover-big')}
      <div class="info"><h2>${esc(b.title)}</h2><div class="author">${esc(b.author)}</div>
        <div class="small muted">Владелец: ${esc(b.owner_name)}</div><div class="small">${esc(b.terms)}</div></div>
    </div>
    <div class="status-box ${s.cls}">${esc(s.long)}</div>
    <dl class="props">
      ${prop('Состояние', esc(b.condition))}${prop('Обложка', esc(b.cover_type))}${prop('Жанр', esc(b.genre))}
      ${prop('Издательство', esc(b.publisher))}${prop('Год издания', esc(b.year))}${prop('Ссылка / ISBN', link)}
      ${prop('Комментарий', esc(b.comment))}
    </dl>
    ${actions.length ? `<div class="btn-row" style="margin-bottom:8px">${actions.map(([go, t, cls]) => `<button class="btn ${cls}" data-go="${go}">${t}</button>`).join('')}</div>`
      : (b.status === 'available' ? '<p class="note">Хотите эту книгу? Напишите владельцу в чате клуба — бронь оформит он.</p>' : '')}
    <h3 class="section-title">История книги</h3><div id="book-events"><div class="empty">Загрузка…</div></div>`);

  sheet.addEventListener('click', e => {
    const go = e.target.closest('[data-go]')?.dataset.go;
    if (!go) return;
    ({
      reserve: () => formReserve(b), transfer: () => formTransfer(b), cancel: () => formCancel(b),
      edit: () => formBook(b), cover: () => formCover(b),
      zoom: () => openModal(b.title, `<img class="cover-zoom" src="${coverUrl(b, 'full')}" alt="Обложка книги">`),
      relist: () => act(() => api('POST', `/api/books/${b.id}/relist`, {}), 'Книга снова на полке'),
      delete: () => confirm(`Убрать книгу «${b.title}» из каталога?`) && act(() => api('DELETE', `/api/books/${b.id}`, {}), 'Книга убрана из каталога'),
    })[go]();
  });
  api('GET', `/api/events?bookId=${b.id}`).then(r => { const el = $('#book-events'); if (el) el.innerHTML = timeline(r.events, false); }).catch(() => {});
}

// выполнить действие, закрыть окно и обновить данные
async function act(fn, done) {
  try { await fn(); closeModal(); toast(done); await refresh(); }
  catch (e) { toast(e.message); }
}
const done = async msg => { closeModal(); toast(msg); await refresh(); };

// ---------- сжатие фото обложки ----------
async function compressCover(file) {
  let img;
  try { img = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch {
    img = await new Promise((ok, fail) => {
      const el = new Image();
      el.onload = () => ok(el); el.onerror = () => fail(new Error('Не удалось открыть фотографию. Попробуйте другой файл.'));
      el.src = URL.createObjectURL(file);
    });
  }
  const draw = (maxSide, quality) => {
    const k = Math.min(1, maxSide / Math.max(img.width, img.height));
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(img.width * k)); cv.height = Math.max(1, Math.round(img.height * k));
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.drawImage(img, 0, 0, cv.width, cv.height);
    return cv.toDataURL('image/jpeg', quality);
  };
  // обложка до 900 px и ~200 КБ, миниатюра до 320 px: тысяча книг займёт около 150 МБ
  let q = 0.8, full = draw(900, q);
  while (full.length > 270000 && q > 0.45) { q -= 0.1; full = draw(900, q); }
  if (full.length > 390000) full = draw(600, 0.6);
  return { full, thumb: draw(320, 0.7) };
}

function coverPicker(current) {
  return `<div class="field"><span class="label">Фотография обложки</span>
    <span class="hint">Необязательно. Фото автоматически сжимается; можно добавить и позже.</span>
    <div class="cover-pick"><span id="cover-preview">${current || '<span class="thumb" aria-hidden="true">📖</span>'}</span>
      <label class="btn">Выбрать фото<input type="file" id="cover-file" accept="image/*" hidden></label></div></div>`;
}
function bindCoverPicker(sheet) {
  const box = { value: null };
  $('#cover-file', sheet).addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      box.value = await compressCover(file);
      $('#cover-preview', sheet).innerHTML = `<img class="thumb" src="${box.value.thumb}" alt="Выбранная обложка">`;
    } catch (ex) { toast(ex.message); }
  });
  return box;
}

// ---------- формы ----------
function formBook(b) {
  const edit = !!b;
  b = b || {};
  const customGenre = b.genre && !C.GENRES.includes(b.genre);
  const sheet = openModal(edit ? 'Изменить сведения' : 'Добавить книгу', `<form>
    ${edit ? '' : `<p class="note">Одна анкета — одна книга. После отправки книга сразу появится в общем каталоге. До передачи книга остаётся у владельца.</p>`}
    <div class="form-error" hidden></div>
    ${!edit && state.me.role === 'admin' ? field('Владелец книги', `<select name="ownerId">${memberOptions(state.me.id, null, null)}</select>`, { req: true }) : ''}
    ${field('Автор', `<input type="text" name="author" maxlength="120" required value="${esc(b.author)}">`, { req: true, hint: 'Фамилия Имя (например, Толстой Лев)' })}
    ${field('Название книги', `<input type="text" name="title" maxlength="200" required value="${esc(b.title)}">`, { req: true, hint: 'Без кавычек (например, Война и мир)' })}
    ${field('Условия передачи', `<select name="terms" required>${options(C.TERMS, b.terms, 'Выберите')}</select>`, { req: true })}
    ${field('Состояние книги', `<select name="condition" required>${options(C.CONDITIONS, b.condition, 'Выберите')}</select>`, { req: true })}
    ${field('Обложка', `<select name="coverType" required>${options(C.COVER_TYPES, b.cover_type, 'Выберите')}</select>`, { req: true })}
    ${field('Жанр', `<select name="genreSel">${options([...C.GENRES, ['__other', 'Другое…']], customGenre ? '__other' : b.genre, 'Не указан')}</select>`)}
    <div id="genre-other" ${customGenre ? '' : 'hidden'}>${field('Свой вариант жанра', `<input type="text" name="genreOther" maxlength="60" value="${customGenre ? esc(b.genre) : ''}">`)}</div>
    ${field('Издательство', `<input type="text" name="publisher" maxlength="100" value="${esc(b.publisher)}">`)}
    ${field('Год издания', `<input type="text" name="year" maxlength="10" inputmode="numeric" value="${esc(b.year)}">`)}
    ${field('Ссылка на LiveLib', `<input type="text" name="link" maxlength="500" value="${esc(b.link)}">`, { hint: 'Или на другой сайт (например, издательства или Литреса), ISBN, чтобы можно было посмотреть внешний вид конкретного издания книги' })}
    ${field('Комментарий владельца', `<textarea name="comment" maxlength="1000">${esc(b.comment)}</textarea>`)}
    ${edit ? '' : coverPicker()}
    <button type="submit" class="btn primary block">${edit ? 'Сохранить' : 'Добавить в каталог'}</button></form>`);
  $('[name=genreSel]', sheet).addEventListener('change', e => { $('#genre-other', sheet).hidden = e.target.value !== '__other'; });
  const cover = edit ? null : bindCoverPicker(sheet);
  onSubmit($('form', sheet), async f => {
    const body = { ...f, genre: f.genreSel === '__other' ? f.genreOther : f.genreSel };
    if (edit) { await api('PUT', `/api/books/${b.id}`, body); return done('Сведения сохранены'); }
    if (cover.value) body.cover = cover.value;
    const r = await api('POST', '/api/books', body);
    await done(`Книга добавлена: №${no(r.id)}`);
  });
}

function formCover(b) {
  const sheet = openModal('Фотография книги', `<form>
    <div class="form-error" hidden></div>
    ${coverPicker(b.cover_v ? thumbHtml(b) : '')}
    <div class="btn-row"><button type="submit" class="btn primary">Сохранить фото</button>
    ${b.cover_v ? '<button type="button" class="btn danger" id="cover-remove">Удалить фото</button>' : ''}</div></form>`);
  const cover = bindCoverPicker(sheet);
  onSubmit($('form', sheet), async () => {
    if (!cover.value) throw new Error('Сначала выберите фотографию.');
    await api('PUT', `/api/books/${b.id}/cover`, cover.value);
    await done('Фото обложки сохранено');
  });
  $('#cover-remove', sheet)?.addEventListener('click', () => act(() => api('DELETE', `/api/books/${b.id}/cover`, {}), 'Фото удалено'));
}

const bookLine = b => `<p class="note"><b>№${no(b.id)}</b> · ${esc(b.title)} — ${esc(b.author)}<br><span class="muted">Владелец: ${esc(b.owner_name)}</span></p>`;

function formReserve(b) {
  const sheet = openModal('Бронирование книги', `<form>${bookLine(b)}
    <div class="form-error" hidden></div>
    ${field('Для кого бронируется книга', `<select name="forUserId" required>${memberOptions('', b.owner_id)}</select>`, { req: true })}
    ${field('Планируемая дата передачи', `<input type="date" name="plannedDate">`, { hint: 'Когда участники рассчитывают встретиться' })}
    ${field('Бронь до (дата окончания брони)', `<input type="date" name="until">`, { hint: 'До какой даты владелец согласен держать книгу за получателем' })}
    ${field('Комментарий', `<textarea name="comment" maxlength="1000"></textarea>`)}
    <button type="submit" class="btn primary block">Забронировать</button></form>`);
  onSubmit($('form', sheet), async f => { await api('POST', `/api/books/${b.id}/reserve`, f); await done('Книга забронирована'); });
}

function formCancel(b) {
  const sheet = openModal('Отмена бронирования', `<form>${bookLine(b)}
    <p>Бронь для участника <b>${esc(b.reserved_for_name)}</b> будет снята, книга снова станет свободной.</p>
    <div class="form-error" hidden></div>
    ${field('Причина отмены', `<textarea name="reason" maxlength="1000"></textarea>`, { hint: 'Например, встреча не состоялась, получатель передумал, договорились о другой книге.' })}
    <button type="submit" class="btn primary block">Отменить бронь</button></form>`);
  onSubmit($('form', sheet), async f => { await api('POST', `/api/books/${b.id}/cancel`, f); await done('Бронь отменена'); });
}

function formTransfer(b) {
  const isReturn = b.status === 'lent';
  const types = isReturn ? ['return'] : ['lend', 'give', 'exchange'];
  const guess = isReturn ? 'return' : b.terms.startsWith('Дам почитать') ? 'lend' : b.terms.startsWith('Обменяю') ? 'exchange' : b.terms.startsWith('Отдам') ? 'give' : '';
  const sheet = openModal('Передача или возврат книги', `<form>${bookLine(b)}
    <div class="form-error" hidden></div>
    <fieldset class="field" style="border:0;padding:0;margin:0 0 14px"><legend class="label">Тип операции <span class="req" aria-hidden="true">*</span></legend>
      <div class="radio-list">${types.map(t => `<label class="check"><input type="radio" name="type" value="${t}" required ${t === guess ? 'checked' : ''}><span>${C.TRANSFER_TYPES[t]}</span></label>`).join('')}</div></fieldset>
    ${isReturn ? `<dl class="props"><dt>От кого</dt><dd>${esc(b.holder_name)} (возвращает книгу)</dd><dt>Кому</dt><dd>${esc(b.owner_name)} (владелец)</dd></dl>`
      : `<dl class="props"><dt>От кого</dt><dd>${esc(b.owner_name)}</dd></dl>
        ${field('Кому передана книга', `<select name="toUserId" required>${memberOptions(b.reserved_for || '', b.owner_id)}</select>`, { req: true })}`}
    ${field('Дата передачи или возврата', `<input type="date" name="date" required value="${today()}">`, { req: true })}
    <div data-for="lend" hidden>${field('Вернуть до', `<input type="date" name="dueDate">`, { hint: 'Заполняется, если книгу дали почитать на определённый срок.' })}</div>
    <div data-for="exchange" hidden>${field('Книга взамен', `<select name="swapBookId"></select>`, { hint: 'Заполняется только при обмене, если встречная книга уже есть в нашем каталоге.' })}</div>
    ${field('Комментарий к передаче', `<textarea name="comment" maxlength="1000"></textarea>`)}
    <button type="submit" class="btn primary block">${isReturn ? 'Оформить возврат' : 'Оформить передачу'}</button></form>`);
  const form = $('form', sheet);
  const sync = () => {
    const type = $('[name=type]:checked', form)?.value;
    $$('[data-for]', form).forEach(el => { el.hidden = el.dataset.for !== type; });
    const to = Number($('[name=toUserId]', form)?.value);
    const theirs = state.books.filter(x => x.owner_id === to && x.id !== b.id && (x.status === 'available' || x.status === 'reserved'));
    $('[name=swapBookId]', form).innerHTML = options(theirs.map(x => [x.id, `№${no(x.id)} · ${x.title}`]), '',
      !to ? 'Сначала выберите получателя' : theirs.length ? 'Не указывать' : 'У получателя нет книг в каталоге');
  };
  form.addEventListener('change', e => { if (e.target.name === 'type' || e.target.name === 'toUserId') sync(); });
  sync();
  onSubmit(form, async f => {
    if (f.type !== 'lend') delete f.dueDate;
    if (f.type !== 'exchange') delete f.swapBookId;
    await api('POST', `/api/books/${b.id}/transfer`, f);
    await done(isReturn ? 'Возврат оформлен' : 'Передача оформлена');
  });
}

function formPassword() {
  const sheet = openModal('Сменить пароль', `<form>
    <div class="form-error" hidden></div>
    ${field('Текущий пароль', `<input type="password" name="current" autocomplete="current-password" required>`)}
    ${field('Новый пароль', `<input type="password" name="next" autocomplete="new-password" minlength="6" required>`, { hint: 'Не короче 6 символов.' })}
    <button type="submit" class="btn primary block">Сохранить</button></form>`);
  onSubmit($('form', sheet), async f => { await api('POST', '/api/me/password', f); closeModal(); toast('Пароль изменён'); });
}

// ---------- админ: участники ----------
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const ta = Object.assign(document.createElement('textarea'), { value: text });
    document.body.append(ta); ta.select(); document.execCommand('copy'); ta.remove();
  }
  toast('Скопировано');
}
function showPassword({ name, password }) {
  const msg = `Виртуальная книжная полка\n${location.origin}\nИмя: ${name}\nПароль: ${password}\nПароль можно сменить в разделе «Профиль».`;
  const sheet = openModal('Пароль участника', `
    <p>Отправьте пароль участнику <b>${esc(name)}</b> в личные сообщения. Пароль показывается только один раз.</p>
    <div class="password-box">${esc(password)}</div>
    <button class="btn primary block" id="copy-msg">Скопировать сообщение для участника</button>`);
  $('#copy-msg', sheet).addEventListener('click', () => copyText(msg));
}
async function userAction(id, action) {
  const u = state.users.find(x => x.id === id);
  try {
    if (action === 'menu') {
      const sheet = openModal(u.name, `<div class="btn-row" style="flex-direction:column">
        <button class="btn" data-do="reset">${u.status === 'blocked' ? 'Разблокировать и выдать новый пароль' : 'Выдать новый пароль'}</button>
        ${u.id !== state.me.id && u.status === 'active' ? `<button class="btn" data-do="${u.role === 'admin' ? 'member' : 'admin'}">${u.role === 'admin' ? 'Снять права админа' : 'Сделать админом'}</button>
        <button class="btn danger" data-do="block">Заблокировать</button>` : ''}</div>`);
      sheet.addEventListener('click', e => { const d = e.target.closest('[data-do]')?.dataset.do; if (d) userAction(id, d); });
      return;
    }
    if (action === 'reject' && !confirm(`Отклонить заявку участника «${u.name}»?`)) return;
    if (action === 'block' && !confirm(`Заблокировать участника «${u.name}»? Он не сможет войти в приложение.`)) return;
    if (action === 'reset' && !confirm(`Выдать участнику «${u.name}» новый пароль? Старый перестанет работать.`)) return;
    const r = await api('POST', `/api/admin/users/${id}/${action}`, {});
    closeModal();
    await refresh();
    if (r.password) showPassword(r); else toast('Готово');
  } catch (e) { toast(e.message); }
}
function formAddUser() {
  const sheet = openModal('Добавить участника', `<form>
    <p class="note">Участник будет добавлен сразу, без заявки. Приложение создаст для него пароль.</p>
    <div class="form-error" hidden></div>
    ${field('Имя в чате книжного клуба', `<input type="text" name="name" maxlength="40" required>`, { req: true })}
    <button type="submit" class="btn primary block">Добавить</button></form>`);
  onSubmit($('form', sheet), async f => { const r = await api('POST', '/api/admin/users', f); await refresh(); showPassword(r); });
}

// ---------- общие обработчики ----------
$('#app').addEventListener('click', async e => {
  const el = e.target.closest('[data-tab],[data-book],[data-act],[data-status],[data-user]');
  if (!el) return;
  if (el.dataset.tab) {
    state.tab = el.dataset.tab;
    render(); window.scrollTo(0, 0);
    if (state.tab === 'history') {
      try { state.events = (await api('GET', '/api/events')).events; if (state.tab === 'history') render(); } catch (ex) { toast(ex.message); }
    }
  } else if (el.dataset.book) openBook(Number(el.dataset.book));
  else if (el.dataset.status) { state.fStatus = el.dataset.status; render(); }
  else if (el.dataset.user) userAction(Number(el.dataset.user), el.dataset.do);
  else if (el.dataset.act === 'add-book') formBook();
  else if (el.dataset.act === 'password') formPassword();
  else if (el.dataset.act === 'add-user') formAddUser();
  else if (el.dataset.act === 'logout') { await api('POST', '/api/logout', {}).catch(() => {}); state.me = null; state.tab = 'catalog'; render(); }
});

// обновлять каталог при возвращении в приложение
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.me && $('#modal').hidden) refresh().catch(() => {});
});

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
refresh().catch(e => {
  $('#app').innerHTML = `<main class="page"><div class="empty">${esc(e.message)}<br><br><button class="btn" id="retry">Повторить</button></div></main>`;
  $('#retry').addEventListener('click', () => location.reload());
});

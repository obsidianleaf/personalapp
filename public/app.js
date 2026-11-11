// Мой дневник: PWA. Данные хранятся только на устройстве (IndexedDB).
// Разбор голоса/фото делает ИИ через /api/parse (ключ лежит на сервере).

const $app = document.getElementById('app');
const today = () => new Date().toLocaleDateString('sv');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- Настройки ----------
const DEFAULT_SECTIONS = [
  { id: 'work', name: 'Работа', icon: '💼', color: 'var(--work)' },
  { id: 'health', name: 'Здоровье', icon: '❤️', color: 'var(--health)' },
  { id: 'finance', name: 'Финансы', icon: '💰', color: 'var(--finance)' },
  { id: 'hobby', name: 'Хобби', icon: '🎨', color: 'var(--hobby)' },
];
const CATS = ['еда', 'транспорт', 'жильё', 'связь', 'подписки', 'здоровье', 'развлечения', 'прочее'];
const TYPES = {
  expense: 'Расход', income: 'Доход', task: 'Задача', note: 'Заметка', measurement: 'Замер',
  medication: 'Лекарство', workout: 'Тренировка', visit: 'Визит к врачу', idea: 'Идея', other: 'Другое',
};
const SYMBOL = { KZT: '₸', RUB: '₽', USD: '$', EUR: '€' };

function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem('diary.settings') || '{}');
    return { names: {}, currency: 'KZT', budget: 0, token: '', pinHash: '', salt: '', ...s };
  } catch { return { names: {}, currency: 'KZT', budget: 0, token: '', pinHash: '', salt: '' }; }
}
let settings = loadSettings();
const saveSettings = () => localStorage.setItem('diary.settings', JSON.stringify(settings));
const sections = () => DEFAULT_SECTIONS.map(s => ({ ...s, name: settings.names[s.id] || s.name }));
const sec = id => sections().find(s => s.id === id) || sections()[0];
const money = (n, cur) => `${Number(n || 0).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ${SYMBOL[cur || settings.currency] || cur || ''}`.trim();

// ---------- IndexedDB ----------
const dbp = new Promise((res, rej) => {
  const r = indexedDB.open('diary', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('entries', { keyPath: 'id', autoIncrement: true });
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});
async function tx(mode, fn) {
  const db = await dbp;
  return new Promise((res, rej) => {
    const t = db.transaction('entries', mode); const st = t.objectStore('entries');
    const req = fn(st); t.oncomplete = () => res(req && req.result); t.onerror = () => rej(t.error);
  });
}
const dbAll = () => tx('readonly', s => s.getAll());
const dbPut = e => tx('readwrite', s => s.put(e));
const dbDel = id => tx('readwrite', s => s.delete(id));

let entries = [];
const urlCache = new Map();
const imgUrl = e => { if (!e.image) return ''; if (!urlCache.has(e.id)) urlCache.set(e.id, URL.createObjectURL(e.image)); return urlCache.get(e.id); };
async function reload() { entries = (await dbAll()).sort((a, b) => (b.date + (b.time || '')).localeCompare(a.date + (a.time || '')) || b.id - a.id); }

// ---------- Состояние ----------
const state = { view: 'home', section: null, month: today().slice(0, 7), filter: 'all', q: '', sheet: null, locked: !!settings.pinHash, pin: '', toast: '' };

function toast(msg) {
  state.toast = msg; render();
  setTimeout(() => { if (state.toast === msg) { state.toast = ''; render(); } }, 2500);
}

// ---------- ИИ-разбор ----------
async function parseAI(payload) {
  const headers = { 'content-type': 'application/json' };
  if (settings.token) headers['x-app-token'] = settings.token;
  const r = await fetch('/api/parse', {
    method: 'POST', headers,
    body: JSON.stringify({ ...payload, today: today(), sections: sections().map(s => ({ id: s.id, name: s.name })) }),
  });
  if (!r.ok) throw new Error('ai ' + r.status);
  const data = await r.json();
  return data;
}

// Запасной разбор текста без ИИ (если нет сети или ключа).
function localParse(text, hint) {
  const t = text.toLowerCase();
  const m = t.match(/(\d[\d\s]*(?:[.,]\d+)?)\s*(₸|тг|тенге|₽|руб\w*|\$|долл\w*|usd|€|евро)?/);
  const amount = m ? parseFloat(m[1].replace(/\s/g, '').replace(',', '.')) : null;
  let currency = settings.currency;
  if (m && m[2]) currency = /₽|руб/.test(m[2]) ? 'RUB' : /\$|долл|usd/.test(m[2]) ? 'USD' : /€|евро/.test(m[2]) ? 'EUR' : 'KZT';
  let section = hint || 'work', type = 'note', category = null;
  if (/потрат|купил|оплат|заплат|счёт|счет|квитанц/.test(t)) { section = 'finance'; type = 'expense'; category = guessCat(t); }
  else if (/получил|зарплат|доход|перевели/.test(t)) { section = 'finance'; type = 'income'; }
  else if (/давлени|сон|спал|вес |пульс|таблетк|лекарств|врач|тренировк|самочувств/.test(t)) {
    section = 'health'; type = /таблетк|лекарств/.test(t) ? 'medication' : /врач/.test(t) ? 'visit' : /тренировк/.test(t) ? 'workout' : 'measurement';
  } else if (/созвон|встреч|задач|дедлайн|проект|клиент|заказчик/.test(t)) { section = 'work'; type = 'task'; }
  else if (/книг|фильм|игр|рисова|гитар|хобби/.test(t)) { section = 'hobby'; }
  let date = today();
  if (/завтра/.test(t)) { const d = new Date(); d.setDate(d.getDate() + 1); date = d.toLocaleDateString('sv'); }
  return { entries: [{ section, type, title: text.slice(0, 60), amount: type === 'expense' || type === 'income' ? amount : null, currency, category, date, time: null, note: text, confidence: 0.3 }], question: null, local: true };
}
function guessCat(t) {
  if (/продукт|еда|кафе|ресторан|магазин|обед/.test(t)) return 'еда';
  if (/такси|бензин|метро|автобус|проезд/.test(t)) return 'транспорт';
  if (/аренд|квартир|коммунал|свет|вода/.test(t)) return 'жильё';
  if (/связь|интернет|телефон|мобильн/.test(t)) return 'связь';
  if (/подписк|netflix|spotify/.test(t)) return 'подписки';
  if (/аптек|врач|лекарств/.test(t)) return 'здоровье';
  return 'прочее';
}

// ---------- Ввод ----------
async function handleInput({ text, imageBlob }) {
  const hint = state.view === 'section' ? state.section : null;
  state.sheet = { type: 'busy' }; render();
  let payload = { text }, result;
  if (imageBlob) { const b64 = await blobToB64(imageBlob); payload = { text, image: b64, mediaType: imageBlob.type || 'image/jpeg' }; }
  try { result = await parseAI(payload); }
  catch {
    if (imageBlob) {
      // без сети фото не разобрать: кладём в очередь
      await dbPut({ section: hint || 'finance', type: 'expense', title: 'Квитанция (ждёт разбора)', date: today(), pending: true, image: imageBlob, rawText: text || '', createdAt: Date.now() });
      await reload(); state.sheet = null; toast('Нет связи с ИИ. Фото сохранено в очередь'); return;
    }
    result = localParse(text, hint);
  }
  const drafts = (result.entries || []).map(e => ({ section: 'work', type: 'note', date: today(), currency: settings.currency, ...e, image: imageBlob || null }));
  if (!drafts.length) drafts.push(localParse(text || '', hint).entries[0]);
  state.sheet = { type: 'confirm', drafts, question: result.question, local: result.local };
  render();
}

async function blobToB64(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer()); let s = '';
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return btoa(s);
}
// Сжимаем фото до 1600px, чтобы не раздувать базу и быстрее слать.
function compressImage(file) {
  return new Promise(resolve => {
    const img = new Image(); const u = URL.createObjectURL(file);
    img.onload = () => {
      const k = Math.min(1, 1600 / Math.max(img.width, img.height));
      const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      c.toBlob(b => { URL.revokeObjectURL(u); resolve(b || file); }, 'image/jpeg', 0.82);
    };
    img.onerror = () => { URL.revokeObjectURL(u); resolve(file); };
    img.src = u;
  });
}

// Голос
let rec = null;
function toggleVoice() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { state.sheet = { type: 'text', note: 'Распознавание речи недоступно в этом браузере. Нажмите микрофон на клавиатуре.' }; return render(); }
  if (rec) { rec.stop(); return; }
  rec = new SR(); rec.lang = 'ru-RU'; rec.interimResults = false; rec.maxAlternatives = 1;
  let got = '';
  rec.onresult = e => { got = Array.from(e.results).map(r => r[0].transcript).join(' '); };
  rec.onerror = e => { rec = null; render(); toast(e.error === 'not-allowed' ? 'Нет доступа к микрофону' : 'Не расслышал, попробуйте ещё'); };
  rec.onend = () => { rec = null; render(); if (got.trim()) handleInput({ text: got.trim() }); };
  rec.start(); render();
}

// Повторный разбор очереди, когда появилась сеть
async function processPending() {
  const pend = entries.filter(e => e.pending);
  for (const e of pend) {
    try {
      const b64 = e.image ? await blobToB64(e.image) : undefined;
      const res = await parseAI({ text: e.rawText || undefined, image: b64, mediaType: e.image && e.image.type });
      const first = (res.entries || [])[0]; if (!first) continue;
      await dbPut({ ...e, ...first, pending: false, needsReview: true });
    } catch { return; }
  }
  if (pend.length) { await reload(); render(); toast('Очередь разобрана, проверьте записи'); }
}

// ---------- Сохранение ----------
function isDuplicate(d) {
  return d.amount != null && entries.some(e => !e.pending && e.amount === d.amount && e.date === d.date && (e.section === d.section));
}
async function saveDrafts() {
  const cards = [...document.querySelectorAll('[data-draft]')];
  const out = cards.map((c, i) => {
    const g = n => c.querySelector(`[name=${n}]`).value.trim();
    const amount = g('amount') === '' ? null : parseFloat(g('amount').replace(',', '.'));
    return { section: g('section'), type: g('type'), title: g('title') || 'Без названия', amount: isNaN(amount) ? null : amount, currency: g('currency') || settings.currency, category: g('category') || null, date: g('date') || today(), time: state.sheet.drafts[i].time || null, note: g('note'), image: state.sheet.drafts[i].image || null, createdAt: Date.now() };
  });
  for (const e of out) await dbPut(e);
  await reload(); state.sheet = null; toast(`Сохранено: ${out.length}`);
}

// ---------- Экспорт ----------
function exportCSV() {
  const rows = [['Дата', 'Тип', 'Название', 'Сумма', 'Валюта', 'Категория', 'Заметка']];
  entries.filter(e => e.section === 'finance').forEach(e => rows.push([e.date, TYPES[e.type] || e.type, e.title, e.amount ?? '', e.currency || '', e.category || '', e.note || '']));
  const csv = '﻿' + rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(';')).join('\n');
  download(new Blob([csv], { type: 'text/csv' }), `finance-${today()}.csv`);
}
async function exportBackup() {
  const items = await Promise.all(entries.map(async e => ({ ...e, image: e.image ? { type: e.image.type, b64: await blobToB64(e.image) } : null })));
  download(new Blob([JSON.stringify({ settings: { ...settings, pinHash: '', salt: '', token: '' }, items })], { type: 'application/json' }), `diary-backup-${today()}.json`);
}
async function importBackup(file) {
  const data = JSON.parse(await file.text());
  for (const it of data.items || []) {
    delete it.id;
    if (it.image) { const bin = atob(it.image.b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); it.image = new Blob([u], { type: it.image.type }); }
    await dbPut(it);
  }
  await reload(); toast('Импорт завершён');
}
function download(blob, name) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); }

// ---------- PIN ----------
async function hashPin(pin, salt) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(salt + pin));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}
async function pinPress(k) {
  if (k === '⌫') state.pin = state.pin.slice(0, -1); else if (state.pin.length < 4) state.pin += k;
  if (state.pin.length === 4) {
    if (state.locked) {
      if (await hashPin(state.pin, settings.salt) === settings.pinHash) { state.locked = false; state.pin = ''; }
      else { state.pin = ''; render(); toast('Неверный PIN'); return; }
    } else if (state.sheet && state.sheet.type === 'setpin') {
      settings.salt = crypto.randomUUID(); settings.pinHash = await hashPin(state.pin, settings.salt); saveSettings();
      state.pin = ''; state.sheet = null; toast('PIN установлен');
    }
  }
  render();
}

// ---------- Вспомогательные расчёты ----------
const monthEntries = () => entries.filter(e => e.section === 'finance' && !e.pending && (e.date || '').startsWith(state.month));
const sum = (arr, type) => arr.filter(e => e.type === type).reduce((a, e) => a + (e.amount || 0), 0);
function shiftMonth(d) { const [y, m] = state.month.split('-').map(Number); const dt = new Date(y, m - 1 + d, 1); state.month = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`; }
const monthName = () => new Date(state.month + '-01').toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' });

// ---------- Рендер ----------
function entryHTML(e) {
  const isFin = e.amount != null;
  const cls = e.type === 'income' ? 'inc' : 'exp';
  return `<div class="entry" data-act="edit" data-id="${e.id}">
    ${e.image ? `<img src="${imgUrl(e)}" alt="">` : ''}
    <div class="grow" style="flex:1;min-width:0"><div class="t">${esc(e.title)}</div>
    <div class="m">${esc(e.date)}${e.time ? ' ' + esc(e.time) : ''} · ${esc(TYPES[e.type] || e.type)}${e.category ? ' · ' + esc(e.category) : ''}
    ${e.pending ? ' <span class="badge">в очереди</span>' : ''}${e.needsReview ? ' <span class="badge">проверить</span>' : ''}</div></div>
    ${isFin ? `<div class="amt ${cls}">${e.type === 'income' ? '+' : '−'}${money(e.amount, e.currency)}</div>` : ''}</div>`;
}

function homeHTML() {
  const me = monthEntries(); const exp = sum(me, 'expense');
  const pending = entries.filter(e => e.pending || e.needsReview).length;
  const tiles = sections().map(s => {
    const n = entries.filter(e => e.section === s.id).length;
    const sub = s.id === 'finance' ? `Расход за месяц: ${money(exp)}` : `Записей: ${n}`;
    return `<button class="tile" style="--c:${s.color}" data-act="open" data-id="${s.id}"><b>${s.icon} ${esc(s.name)}</b><span>${sub}</span></button>`;
  }).join('');
  const recent = entries.slice(0, 8).map(entryHTML).join('') || '<p class="muted center">Пока пусто. Нажмите микрофон и скажите, что произошло.</p>';
  return `<div class="top"><h1>Мой дневник</h1><button class="icon-btn" data-act="settings">⚙️</button></div>
    ${pending ? `<div class="warn">Записей, требующих внимания: ${pending}</div>` : ''}
    <div class="grid">${tiles}</div><h2>Последнее</h2>${recent}`;
}

function sectionHTML() {
  const s = sec(state.section);
  let list = entries.filter(e => e.section === s.id);
  let extra = '';
  if (s.id === 'finance') {
    list = monthEntries().concat(entries.filter(e => e.section === 'finance' && e.pending));
    const me = monthEntries(); const exp = sum(me, 'expense'), inc = sum(me, 'income');
    const cats = {}; me.filter(e => e.type === 'expense').forEach(e => { const c = e.category || 'прочее'; cats[c] = (cats[c] || 0) + (e.amount || 0); });
    const max = Math.max(1, ...Object.values(cats));
    const left = settings.budget ? settings.budget - exp : null;
    extra = `<div class="row" style="align-items:center;justify-content:space-between"><button class="icon-btn" data-act="prev">◀</button><b style="text-transform:capitalize">${monthName()}</b><button class="icon-btn" data-act="next">▶</button></div>
      <div class="card"><div class="row"><div class="grow"><span class="muted">Расходы</span><div class="amt exp">${money(exp)}</div></div><div class="grow"><span class="muted">Доходы</span><div class="amt inc">${money(inc)}</div></div>
      <div class="grow"><span class="muted">${left == null ? 'Бюджет' : 'Остаток'}</span><div class="amt">${left == null ? '—' : money(left)}</div></div></div></div>
      ${Object.entries(cats).sort((a, b) => b[1] - a[1]).map(([c, v]) => `<div class="card"><div class="row" style="justify-content:space-between"><span>${esc(c)}</span><b>${money(v)}</b></div><div class="bar"><i style="width:${v / max * 100}%"></i></div></div>`).join('')}
      <div class="btns"><button class="btn" data-act="csv">Экспорт CSV</button></div>`;
  }
  const q = state.q.toLowerCase();
  if (q) list = list.filter(e => (e.title + ' ' + (e.note || '') + ' ' + (e.category || '')).toLowerCase().includes(q));
  const types = [...new Set(entries.filter(e => e.section === s.id).map(e => e.type))];
  const chips = types.length > 1 ? `<div class="chips"><button class="chip ${state.filter === 'all' ? 'on' : ''}" data-act="filter" data-id="all">Все</button>${types.map(t => `<button class="chip ${state.filter === t ? 'on' : ''}" data-act="filter" data-id="${t}">${TYPES[t] || t}</button>`).join('')}</div>` : '';
  if (state.filter !== 'all') list = list.filter(e => e.type === state.filter);
  return `<div class="top"><button class="icon-btn" data-act="home">←</button><h1>${s.icon} ${esc(s.name)}</h1></div>
    ${extra}<input id="q" placeholder="Поиск" value="${esc(state.q)}" style="margin:10px 0">${chips}
    ${list.map(entryHTML).join('') || '<p class="muted center">Записей нет</p>'}`;
}

function settingsHTML() {
  return `<div class="top"><button class="icon-btn" data-act="home">←</button><h1>Настройки</h1></div>
    <div class="card"><b>Названия разделов</b>${sections().map(s => `<label>${s.icon}</label><input data-name="${s.id}" value="${esc(s.name)}">`).join('')}</div>
    <div class="card"><label>Валюта по умолчанию</label><select id="cur">${Object.keys(SYMBOL).map(c => `<option ${c === settings.currency ? 'selected' : ''}>${c}</option>`).join('')}</select>
    <label>Месячный бюджет</label><input id="budget" type="number" inputmode="decimal" value="${settings.budget || ''}">
    <label>Токен доступа к серверу (если задан APP_TOKEN)</label><input id="token" type="password" value="${esc(settings.token)}"></div>
    <div class="card"><b>Безопасность</b><div class="btns"><button class="btn" data-act="setpin">${settings.pinHash ? 'Сменить PIN' : 'Установить PIN'}</button>${settings.pinHash ? '<button class="btn" data-act="rmpin">Убрать PIN</button>' : ''}</div></div>
    <div class="card"><b>Резервная копия</b><div class="btns"><button class="btn" data-act="backup">Экспорт</button><button class="btn" data-act="import">Импорт</button></div></div>
    <div class="btns"><button class="btn primary" data-act="savesettings">Сохранить</button></div>`;
}

function sheetHTML() {
  const sh = state.sheet; if (!sh) return '';
  if (sh.type === 'busy') return `<div class="sheet-bg"><div class="sheet center"><p>🤖 Разбираю…</p></div></div>`;
  if (sh.type === 'text') return `<div class="sheet-bg"><div class="sheet"><b>Что произошло?</b>${sh.note ? `<p class="muted">${esc(sh.note)}</p>` : ''}
    <textarea id="txt" rows="3" placeholder="Например: потратил 4500 на продукты" autofocus></textarea>
    <div class="btns"><button class="btn" data-act="close">Отмена</button><button class="btn primary" data-act="sendtext">Добавить</button></div></div></div>`;
  if (sh.type === 'setpin') return `<div class="sheet-bg"><div class="sheet center"><b>Придумайте PIN из 4 цифр</b>${pinPad()}<div class="btns"><button class="btn" data-act="close">Отмена</button></div></div></div>`;
  if (sh.type === 'confirm') {
    const cards = sh.drafts.map((d, i) => `<div class="card" data-draft="${i}">
      ${d.image ? `<img src="${URL.createObjectURL(d.image)}" style="width:100%;max-height:160px;object-fit:contain;border-radius:8px">` : ''}
      ${isDuplicate(d) ? '<div class="warn">⚠️ Похоже на дубль: такая сумма за эту дату уже есть</div>' : ''}
      ${d.confidence != null && d.confidence < 0.6 ? '<div class="warn">Не уверен в разборе, проверьте поля</div>' : ''}
      <div class="row"><div class="grow"><label>Раздел</label><select name="section">${sections().map(s => `<option value="${s.id}" ${s.id === d.section ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></div>
      <div class="grow"><label>Тип</label><select name="type">${Object.entries(TYPES).map(([k, v]) => `<option value="${k}" ${k === d.type ? 'selected' : ''}>${v}</option>`).join('')}</select></div></div>
      <label>Название</label><input name="title" value="${esc(d.title)}">
      <div class="row"><div class="grow"><label>Сумма</label><input name="amount" inputmode="decimal" value="${d.amount ?? ''}"></div>
      <div class="grow"><label>Валюта</label><input name="currency" value="${esc(d.currency || settings.currency)}"></div></div>
      <div class="row"><div class="grow"><label>Категория</label><input name="category" list="cats" value="${esc(d.category || '')}"></div>
      <div class="grow"><label>Дата</label><input name="date" type="date" value="${esc(d.date)}"></div></div>
      <label>Заметка</label><textarea name="note" rows="2">${esc(d.note || '')}</textarea></div>`).join('');
    return `<div class="sheet-bg"><div class="sheet"><b>Проверьте и сохраните</b>
      ${sh.local ? '<p class="muted">ИИ недоступен, разобрано упрощённо.</p>' : ''}${sh.question ? `<div class="warn">❓ ${esc(sh.question)}</div>` : ''}
      <datalist id="cats">${CATS.map(c => `<option value="${c}">`).join('')}</datalist>${cards}
      <div class="btns"><button class="btn" data-act="close">Отмена</button><button class="btn primary" data-act="savedrafts">Сохранить</button></div></div></div>`;
  }
  if (sh.type === 'edit') {
    const e = sh.entry;
    return `<div class="sheet-bg"><div class="sheet">${e.image ? `<img src="${imgUrl(e)}" style="width:100%;max-height:260px;object-fit:contain;border-radius:8px">` : ''}
      <div data-draft="0"><div class="row"><div class="grow"><label>Раздел</label><select name="section">${sections().map(s => `<option value="${s.id}" ${s.id === e.section ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></div>
      <div class="grow"><label>Тип</label><select name="type">${Object.entries(TYPES).map(([k, v]) => `<option value="${k}" ${k === e.type ? 'selected' : ''}>${v}</option>`).join('')}</select></div></div>
      <label>Название</label><input name="title" value="${esc(e.title)}">
      <div class="row"><div class="grow"><label>Сумма</label><input name="amount" inputmode="decimal" value="${e.amount ?? ''}"></div><div class="grow"><label>Валюта</label><input name="currency" value="${esc(e.currency || '')}"></div></div>
      <div class="row"><div class="grow"><label>Категория</label><input name="category" list="cats" value="${esc(e.category || '')}"></div><div class="grow"><label>Дата</label><input name="date" type="date" value="${esc(e.date)}"></div></div>
      <label>Заметка</label><textarea name="note" rows="2">${esc(e.note || '')}</textarea></div>
      <datalist id="cats">${CATS.map(c => `<option value="${c}">`).join('')}</datalist>
      <div class="btns"><button class="btn danger" data-act="delete">Удалить</button><button class="btn" data-act="close">Закрыть</button><button class="btn primary" data-act="saveedit">Сохранить</button></div></div></div>`;
  }
  return '';
}

function pinPad() {
  const dots = `<div class="dots">${[0, 1, 2, 3].map(i => `<i class="${i < state.pin.length ? 'f' : ''}"></i>`).join('')}</div>`;
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'].map(k => k ? `<button data-act="pin" data-id="${k}">${k}</button>` : '<span></span>').join('');
  return `${dots}<div class="pin">${keys}</div>`;
}

function render() {
  const keepQ = document.activeElement && document.activeElement.id === 'q';
  if (state.locked) { $app.innerHTML = `<div class="lock"><h1>🔒 Мой дневник</h1>${pinPad()}</div>${state.toast ? `<div class="toast">${esc(state.toast)}</div>` : ''}`; return; }
  const body = state.view === 'section' ? sectionHTML() : state.view === 'settings' ? settingsHTML() : homeHTML();
  const dock = state.view === 'settings' ? '' : `<div class="dock">
    <button class="fab" data-act="photo" aria-label="Фото">📷</button>
    <button class="fab mic ${rec ? 'rec' : ''}" data-act="voice" aria-label="Голос">${rec ? '⏹' : '🎤'}</button>
    <button class="fab" data-act="text" aria-label="Текст">⌨️</button></div>`;
  $app.innerHTML = body + dock + sheetHTML() + (state.toast ? `<div class="toast">${esc(state.toast)}</div>` : '');
  if (keepQ) { const q = document.getElementById('q'); q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
}

// ---------- События ----------
const fileInput = Object.assign(document.createElement('input'), { type: 'file', accept: 'image/*', multiple: true });
const importInput = Object.assign(document.createElement('input'), { type: 'file', accept: 'application/json' });
fileInput.onchange = async () => {
  const files = [...fileInput.files]; fileInput.value = '';
  for (const f of files) await handleInput({ imageBlob: await compressImage(f) });
};
importInput.onchange = () => importInput.files[0] && importBackup(importInput.files[0]).catch(() => toast('Не удалось прочитать файл'));

$app.addEventListener('input', e => { if (e.target.id === 'q') { state.q = e.target.value; render(); } });
$app.addEventListener('click', async e => {
  const el = e.target.closest('[data-act]'); if (!el) return;
  const act = el.dataset.act, id = el.dataset.id;
  switch (act) {
    case 'open': state.view = 'section'; state.section = id; state.filter = 'all'; state.q = ''; break;
    case 'home': state.view = 'home'; break;
    case 'settings': state.view = 'settings'; break;
    case 'prev': shiftMonth(-1); break;
    case 'next': shiftMonth(1); break;
    case 'filter': state.filter = id; break;
    case 'csv': exportCSV(); return;
    case 'backup': exportBackup(); return;
    case 'import': importInput.click(); return;
    case 'photo': fileInput.click(); return;
    case 'voice': toggleVoice(); return;
    case 'text': state.sheet = { type: 'text' }; break;
    case 'sendtext': { const t = document.getElementById('txt').value.trim(); if (!t) return; handleInput({ text: t }); return; }
    case 'close': state.sheet = null; state.pin = ''; break;
    case 'savedrafts': await saveDrafts(); return;
    case 'edit': { const en = entries.find(x => x.id === +id); if (en) state.sheet = { type: 'edit', entry: en }; break; }
    case 'saveedit': {
      const c = document.querySelector('[data-draft]'); const g = n => c.querySelector(`[name=${n}]`).value.trim();
      const amount = g('amount') === '' ? null : parseFloat(g('amount').replace(',', '.'));
      await dbPut({ ...state.sheet.entry, section: g('section'), type: g('type'), title: g('title') || 'Без названия', amount: isNaN(amount) ? null : amount, currency: g('currency') || null, category: g('category') || null, date: g('date') || today(), note: g('note'), needsReview: false });
      await reload(); state.sheet = null; break;
    }
    case 'delete': if (confirm('Удалить запись?')) { await dbDel(state.sheet.entry.id); urlCache.delete(state.sheet.entry.id); await reload(); state.sheet = null; } break;
    case 'setpin': state.pin = ''; state.sheet = { type: 'setpin' }; break;
    case 'rmpin': settings.pinHash = ''; settings.salt = ''; saveSettings(); toast('PIN убран'); return;
    case 'pin': await pinPress(id); return;
    case 'savesettings':
      document.querySelectorAll('[data-name]').forEach(i => { const v = i.value.trim(); if (v) settings.names[i.dataset.name] = v; });
      settings.currency = document.getElementById('cur').value; settings.budget = parseFloat(document.getElementById('budget').value) || 0;
      settings.token = document.getElementById('token').value.trim(); saveSettings(); state.view = 'home'; toast('Сохранено'); return;
  }
  render();
});

// Автоблокировка при уходе из приложения больше чем на минуту
let hiddenAt = 0;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) hiddenAt = Date.now();
  else if (settings.pinHash && hiddenAt && Date.now() - hiddenAt > 60000) { state.locked = true; state.pin = ''; render(); }
});
window.addEventListener('online', processPending);

// ---------- Старт ----------
(async function init() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  await reload(); render();
  // Фото из «Поделиться» (share target)
  if (new URLSearchParams(location.search).get('shared')) {
    history.replaceState(null, '', '/');
    const c = await caches.open('shared'); const r = await c.match('/shared-image');
    if (r) { const blob = await r.blob(); await c.delete('/shared-image'); if (!state.locked) handleInput({ imageBlob: await compressImage(blob) }); }
  }
  if (navigator.onLine) processPending();
})();

// Мини-сервер без зависимостей: раздаёт PWA и проксирует запросы к Claude API,
// чтобы ключ Anthropic не лежал на телефоне.
// Запуск: ANTHROPIC_API_KEY=sk-... APP_TOKEN=секрет node server.js
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY || '';
const APP_TOKEN = process.env.APP_TOKEN || ''; // если задан, приложение должно прислать его в заголовке
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5-5';
const PUBLIC = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png',
};

function systemPrompt(today, sections) {
  return `Ты разбираешь записи для личного дневника-приложения. Сегодня ${today}.
Разделы: ${sections.map(s => `${s.id} («${s.name}»)`).join(', ')}.
Пользователь присылает фразу (голос/текст) или фото (квитанция, чек, скриншот оплаты).
Верни ТОЛЬКО JSON без пояснений и без markdown:
{"entries":[{"section":"work|health|finance|hobby","type":"expense|income|task|note|measurement|medication|workout|visit|idea|other",
"title":"короткий заголовок","amount":число или null,"currency":"KZT|RUB|USD|EUR|... или null",
"category":"для финансов: еда|транспорт|жильё|связь|подписки|здоровье|развлечения|прочее; иначе null",
"date":"YYYY-MM-DD","time":"HH:MM или null","note":"детали (для замеров: значения; для чеков: получатель, номер, позиции)",
"confidence":0..1}],"question":null или "уточняющий вопрос, если данных не хватает"}
Правила: если одна фраза относится к двум разделам (например, покупка для хобби) — верни две записи.
Относительные даты («завтра», «в пятницу») переводи в YYYY-MM-DD. Сумму бери из текста/чека как есть, без выдумок.
Если не уверен — поставь низкий confidence и задай question.`;
}

function readBody(req, limit = 15e6) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

async function handleParse(req, res) {
  if (APP_TOKEN && req.headers['x-app-token'] !== APP_TOKEN) return json(res, 401, { error: 'unauthorized' });
  if (!API_KEY) return json(res, 503, { error: 'no_api_key' });
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad_request' }); }
  const { text, image, mediaType, today, sections } = body;
  if (!text && !image) return json(res, 400, { error: 'empty' });

  const content = [];
  if (image) content.push({ type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: image } });
  content.push({ type: 'text', text: text || 'Разбери эту квитанцию/скриншот.' });

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: MODEL, max_tokens: 1500,
        system: systemPrompt(today || new Date().toISOString().slice(0, 10), sections || []),
        messages: [{ role: 'user', content }],
      }),
    });
    const data = await r.json();
    if (!r.ok) return json(res, 502, { error: 'upstream', detail: data.error && data.error.message });
    const out = (data.content || []).map(b => b.text || '').join('');
    const m = out.match(/\{[\s\S]*\}/);
    if (!m) return json(res, 502, { error: 'bad_model_output' });
    return json(res, 200, JSON.parse(m[0]));
  } catch (e) {
    return json(res, 502, { error: 'upstream', detail: String(e.message || e) });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'POST' && url.pathname === '/api/parse') return handleParse(req, res);
  if (url.pathname === '/api/status') return json(res, 200, { ai: !!API_KEY, tokenRequired: !!APP_TOKEN });
  let file = path.normalize(path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
});
server.listen(PORT, () => console.log(`Приложение: http://localhost:${PORT}  ИИ: ${API_KEY ? 'включён' : 'выключен (нет ANTHROPIC_API_KEY)'}`));

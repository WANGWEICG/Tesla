import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, createHash, createCipheriv, createDecipheriv, timingSafeEqual, generateKeyPairSync } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeOrders, changes } from './model.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const sha = s => createHash('sha256').update(s).digest('hex');
const random = () => randomBytes(32).toString('hex');
const API_BASES = new Set(['https://fleet-api.prd.na.vn.cloud.tesla.com', 'https://fleet-api.prd.eu.vn.cloud.tesla.com']);
export function createApp(env = process.env, fetcher = fetch) {
  const origin = new URL(env.PUBLIC_URL || 'http://localhost:3000').origin;
  if (!origin.startsWith('https:') && !['localhost', '127.0.0.1'].includes(new URL(origin).hostname)) throw new Error('正式環境 PUBLIC_URL 必須使用 HTTPS');
  if (!env.APP_PASSWORD || env.APP_PASSWORD.length < 16) throw new Error('請設定至少 16 字元的 APP_PASSWORD');
  if (!/^[a-f0-9]{64}$/i.test(env.DATA_KEY || '')) throw new Error('DATA_KEY 必須是 64 位十六進位字串');
  const key = Buffer.from(env.DATA_KEY, 'hex');
  const base = env.TESLA_API_BASE || 'https://fleet-api.prd.na.vn.cloud.tesla.com';
  if (!API_BASES.has(base)) throw new Error('不支援的 Tesla API 區域');
  const configured = Boolean(env.TESLA_CLIENT_ID && env.TESLA_CLIENT_SECRET);
  const mins = Number(env.POLL_MINUTES || 30);
  if (!Number.isFinite(mins) || mins < 5 || mins > 1440) throw new Error('POLL_MINUTES 必須介於 5 至 1440');
  const dataDir = resolve(env.DATA_DIR || './data');
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(resolve(dataDir, 'tracker.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS oauth (state TEXT PRIMARY KEY, session TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, json TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS history (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id TEXT NOT NULL, at TEXT NOT NULL, json TEXT NOT NULL);`);
  const get = k => { const r = db.prepare('SELECT v FROM kv WHERE k=?').get(k); return r ? JSON.parse(r.v) : null; };
  const set = (k, v) => db.prepare('INSERT OR REPLACE INTO kv VALUES (?,?)').run(k, JSON.stringify(v));
  function seal(value) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
    const body = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
  }
  function unseal(value) {
    const b = Buffer.from(value, 'base64'), cipher = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
    cipher.setAuthTag(b.subarray(12, 28));
    return JSON.parse(Buffer.concat([cipher.update(b.subarray(28)), cipher.final()]).toString());
  }
  if (!get('publicKey')) {
    const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1', publicKeyEncoding: { type:'spki', format:'pem' }, privateKeyEncoding: { type:'pkcs8', format:'pem' } });
    set('publicKey', pair.publicKey); set('privateKey', seal(pair.privateKey));
  }
  let busy = null, nextAllowed = 0;
  async function request(url, options = {}) {
    const response = await fetcher(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(20000) });
    if (!response.ok) {
      if (response.status === 429) {
        const seconds = Number(response.headers.get('retry-after'));
        nextAllowed = Date.now() + Math.max(mins * 60000, Number.isFinite(seconds) ? seconds * 1000 : 0);
      }
      // Do not log Tesla response bodies, auth codes or tokens.
      const error = new Error(`Tesla 服務回應 ${response.status}`); error.status = response.status; throw error;
    }
    return response.json();
  }
  async function token(form) {
    const result = await request('https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form)
    });
    if (!result.access_token || !result.refresh_token || !Number.isFinite(Number(result.expires_in))) throw new Error('Tesla 授權回應不完整');
    const saved = { access_token: result.access_token, refresh_token: result.refresh_token, expires: Date.now() + Number(result.expires_in) * 1000 };
    set('tokens', seal(saved)); // Persist rotated refresh token before any later API call.
    return saved;
  }
  async function sync(force = false) {
    if (busy) return busy;
    if (!get('tokens')) throw new Error('請先連接 Tesla 帳號');
    if (Date.now() < nextAllowed || (!force && Date.now() < (get('lastAttempt') || 0) + mins * 60000)) return;
    busy = (async () => {
      set('lastAttempt', Date.now());
      try {
        let creds = unseal(get('tokens'));
        if (creds.expires < Date.now() + 60000) creds = await token({ grant_type: 'refresh_token', client_id: env.TESLA_CLIENT_ID, refresh_token: creds.refresh_token });
        const payload = await request(base + '/api/1/users/orders', { headers: { Authorization: 'Bearer ' + creds.access_token } });
        const orders = normalizeOrders(payload), at = new Date().toISOString();
        db.exec('BEGIN IMMEDIATE');
        try {
          db.prepare('UPDATE orders SET active=0').run();
          for (const order of orders) {
            const old = db.prepare('SELECT json FROM orders WHERE id=?').get(order.id);
            const diff = changes(old && JSON.parse(old.json), order);
            db.prepare('INSERT OR REPLACE INTO orders VALUES (?,?,1)').run(order.id, JSON.stringify(order));
            if (diff.length) db.prepare('INSERT INTO history(order_id,at,json) VALUES (?,?,?)').run(order.id, at, JSON.stringify(diff));
          }
          set('lastSuccess', at); set('error', null); db.exec('COMMIT');
        } catch (e) { db.exec('ROLLBACK'); throw e; }
      } catch (e) {
        if (e.status === 401) { db.prepare("DELETE FROM kv WHERE k='tokens'").run(); set('error', 'Tesla 授權已失效，請重新連接。'); }
        else set('error', e.status === 403 ? 'Tesla 拒絕存取，請確認應用註冊及授權範圍。' : e.status === 429 ? 'Tesla 限制請求頻率，已延後重試。' : e.status === 402 ? 'Tesla API 需要設定帳務，請至開發者後台確認。' : '同步未完成，保留上次資料；請稍後重試。');
        throw e;
      }
    })().finally(() => { busy = null; });
    return busy;
  }
  function state() {
    return { configured, connected: Boolean(get('tokens')), lastSuccess: get('lastSuccess'), error: get('error'), pollMinutes: mins,
      orders: db.prepare('SELECT json,active FROM orders ORDER BY id').all().map(r => ({ ...JSON.parse(r.json), active: Boolean(r.active) })),
      history: db.prepare('SELECT * FROM history ORDER BY id DESC LIMIT 300').all().map(r => ({ id: r.id, orderId: r.order_id, at: r.at, changes: JSON.parse(r.json) })) };
  }
  const attempts = new Map(); // bounded per-address login throttling
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    const json = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
    const redirect = url => { res.writeHead(302, { Location: url }); res.end(); };
    const cookie = value => res.setHeader('Set-Cookie', `delivery_session=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${value ? 86400 * 7 : 0}${origin.startsWith('https:') ? '; Secure' : ''}`);
    try {
      const url = new URL(req.url, origin), path = url.pathname;
      const cookieValue = /(?:^|;\s*)delivery_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
      const session = cookieValue && db.prepare('SELECT * FROM sessions WHERE hash=? AND expires>?').get(sha(cookieValue), Date.now());
      if (req.method === 'POST' && req.headers.origin !== origin) return json(403, { error: '來源驗證失敗，請在服務網址操作。' });
      async function body() {
        let raw = '';
        for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > 16384) throw new Error('資料過大'); }
        return JSON.parse(raw || '{}');
      }
      if (path === '/api/login' && req.method === 'POST') {
        const ip = req.socket.remoteAddress, now = Date.now();
        for (const [k,v] of attempts) if (v.until < now) attempts.delete(k);
        if (attempts.size >= 10000 || (attempts.get(ip)?.count || 0) >= 10) return json(429, { error: '嘗試次數過多，請 15 分鐘後再試。' });
        const input = String((await body()).password || '');
        if (!timingSafeEqual(Buffer.from(sha(input)), Buffer.from(sha(env.APP_PASSWORD)))) {
          const old = attempts.get(ip); attempts.set(ip, { count: (old?.count || 0) + 1, until: old?.until || now + 900000 });
          return json(401, { error: '私人存取密碼錯誤。' });
        }
        attempts.delete(ip);
        db.prepare('DELETE FROM sessions WHERE expires<?').run(now);
        const value = random(); db.prepare('INSERT INTO sessions VALUES (?,?)').run(sha(value), now + 86400 * 7000); cookie(value); return json(200, { ok: true });
      }
      if (path.startsWith('/api/') || path.startsWith('/auth/')) {
        if (!session) return json(401, { error: '請先輸入私人存取密碼。' });
        if (path === '/api/state' && req.method === 'GET') return json(200, state());
        if (path === '/api/sync' && req.method === 'POST') {
          // Manual refresh is limited to one upstream call per minute.
          if (Date.now() < (get('lastAttempt') || 0) + 60000 || Date.now() < nextAllowed) return json(429, { error: '請稍後再同步，避免頻繁呼叫 Tesla。' });
          await sync(true); return json(200, state());
        }
        if (path === '/api/disconnect' && req.method === 'POST') {
          // Drain in-flight refresh before removing tokens so it cannot reconnect itself.
          if (busy) await busy.catch(() => {});
          db.prepare("DELETE FROM kv WHERE k='tokens'").run(); db.prepare('DELETE FROM oauth').run(); return json(200, { ok: true });
        }
        if (path === '/api/logout' && req.method === 'POST') {
          db.prepare('DELETE FROM sessions WHERE hash=?').run(session.hash); cookie(''); return json(200, { ok: true });
        }
        if (path === '/auth/tesla' && req.method === 'GET') {
          if (!configured) return json(503, { error: '後端尚未設定 Tesla Client ID 與 Secret。' });
          db.prepare('DELETE FROM oauth WHERE expires<? OR session=?').run(Date.now(), session.hash);
          const state = random(); db.prepare('INSERT INTO oauth VALUES (?,?,?)').run(sha(state), session.hash, Date.now() + 600000);
          const auth = new URL('https://auth.tesla.com/oauth2/v3/authorize');
          auth.search = new URLSearchParams({ response_type: 'code', client_id: env.TESLA_CLIENT_ID, redirect_uri: origin + '/auth/callback', scope: 'openid offline_access user_data', state, locale: 'zh-TW' });
          return redirect(auth.href);
        }
        if (path === '/auth/callback' && req.method === 'GET') {
          const s = url.searchParams.get('state') || '';
          const pending = db.prepare('SELECT * FROM oauth WHERE state=? AND session=? AND expires>?').get(sha(s), session.hash, Date.now());
          if (!pending) return json(400, { error: '授權已過期或驗證失敗，請重新連接。' });
          db.prepare('DELETE FROM oauth WHERE state=?').run(sha(s));
          if (url.searchParams.has('error') || !url.searchParams.get('code')) return redirect('/?auth=cancelled');
          // Serialize account connection with any refresh using the old account.
          if (busy) await busy.catch(() => {});
          await token({ grant_type: 'authorization_code', client_id: env.TESLA_CLIENT_ID, client_secret: env.TESLA_CLIENT_SECRET,
            audience: base, redirect_uri: origin + '/auth/callback', code: url.searchParams.get('code') });
          await sync(true).catch(() => {}); return redirect('/');
        }
        return json(404, { error: '找不到此功能。' });
      }
      if (req.method !== 'GET') return json(405, { error: '不支援此方法。' });
      if (path === '/.well-known/appspecific/com.tesla.3p.public-key.pem') {
        res.writeHead(200, { 'Content-Type':'application/x-pem-file' }); return res.end(get('publicKey'));
      }
      const files = { '/': ['index.html', 'text/html'], '/index.html': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/model.mjs': ['../model.mjs', 'text/javascript'], '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'], '/icon.svg': ['icon.svg','image/svg+xml'] };
      const file = files[path]; if (!file) return json(404, { error: '找不到頁面。' });
      res.writeHead(200, { 'Content-Type': file[1] + '; charset=utf-8' }); res.end(readFileSync(resolve(ROOT, 'public', file[0])));
    } catch (e) { if (!res.headersSent) json(500, { error: '操作未完成，請檢查連線或服務設定後重試。' }); else res.end(); }
  });
  const timer = setInterval(() => sync().catch(() => {}), 60000); timer.unref();
  // Startup sync respects the persisted polling interval.
  sync().catch(() => {});
  return { server, sync, state, close: async () => { clearInterval(timer); await busy?.catch(() => {}); await new Promise(r => server.listening ? server.close(r) : r()); db.close(); } };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = createApp(); app.server.listen(Number(process.env.PORT || 3000), '0.0.0.0', () => console.log('Delivery tracker ready'));
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => app.close().then(() => process.exit(0)));
}

// ASDLE Cloud Server v4 — Cloudflare Worker + D1 (+ R2 اختياري للوسائط)
// ---------------------------------------------------------------------------
// • حسابات وتوكنات، رسائل نصية وصور ورسائل صوتية، بروفايل (اسم/نبذة/صورة/كلمة سر).
// • الصور والفويس بتترفع كملف خام (POST /media) وبتتنزّل بـ GET /media/<id> — مش جوّه الرسالة.
//   التخزين: R2 لو مربوط باسم MEDIA، وإلا في D1 (قطع base64) من غير أي إعداد إضافي.
// • صندوق بلاغات للمطور فقط (/dev/*)، وحذف الحسابات.
// • رقم المطور: متغيّر DEVELOPER_PHONE في wrangler.toml.
// ---------------------------------------------------------------------------

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'content-type,x-token,x-admin',
  'cache-control': 'no-store',
};
const LIM = {
  image: 4 * 1024 * 1024,   // أقصى حجم صورة على السيرفر
  audio: 6 * 1024 * 1024,   // أقصى حجم رسالة صوتية
  avatar: 130000,           // أقصى طول base64 لصورة البروفايل
  legacyImg: 300000,        // الصور القديمة المضمّنة داخل الرسالة
  text: 4000,
  chunk: 600 * 1024,        // حجم القطعة في تخزين D1 (قبل base64)
  sendPerMin: 90,
  mediaDays: 14,            // الوسائط بتتمسح بعد كده
  msgDays: 30,
};
const IMG_MIME = ['image/jpeg', 'image/png', 'image/webp'];
const AUD_MIME = ['audio/mp4', 'audio/aac', 'audio/mpeg', 'audio/ogg', 'audio/webm', 'audio/3gpp', 'audio/x-m4a', 'audio/m4a'];

const json = (d, s = 200, h = {}) => new Response(JSON.stringify(d), { status: s, headers: { ...CORS, 'content-type': 'application/json; charset=utf-8', ...h } });
const fail = (error, s = 400, extra = {}) => json({ error, ...extra }, s);
const clean = v => String(v ?? '').trim();
const phone = v => clean(v).replace(/[^0-9+]/g, '').slice(0, 20);
const digits = v => String(v ?? '').replace(/\D/g, '');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const hex = u8 => Array.from(u8, b => b.toString(16).padStart(2, '0')).join('');
const token = () => hex(crypto.getRandomValues(new Uint8Array(32)));
const randId = () => token().slice(0, 24);
const norm = s => clean(s).normalize('NFKC').toLowerCase().replace(/[\u064B-\u065F\u0670\u0640]/g, '').replace(/[إأآ]/g, 'ا').replace(/ى/g, 'ي');
const badWords = ['كس امك', 'كسمك', 'شرموط', 'متناك', 'خول', 'عرص', 'قحبة', 'ابن القحبة', 'fuck', 'bitch', 'shit'];
const moderated = s => { const x = norm(s).replace(/[._*\-]/g, ''); return badWords.some(w => x.includes(norm(w))); };
const sameDev = (a, b) => { const x = digits(a).slice(-10), y = digits(b).slice(-10); return x.length >= 9 && x === y; };
const devPhone = env => phone(env.DEVELOPER_PHONE);
const isDev = (env, u) => !!u && sameDev(u.phone, devPhone(env));
const inList = n => Array(n).fill('?').join(',');
const label = k => (k === 'image' ? '📷 صورة' : k === 'audio' ? '🎤 رسالة صوتية' : '');

async function hashPass(pass, salt) {
  const e = new TextEncoder();
  const k = await crypto.subtle.importKey('raw', e.encode(pass), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: e.encode(salt), iterations: 100000, hash: 'SHA-256' }, k, 256);
  return hex(new Uint8Array(bits));
}
const readJson = async r => { try { return await r.json(); } catch { return {}; } };

// ------------------------------- المخطط -------------------------------------
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
    pass_hash TEXT NOT NULL, pass_salt TEXT NOT NULL, token TEXT UNIQUE,
    role TEXT NOT NULL DEFAULT 'user', points INTEGER NOT NULL DEFAULT 0, banned INTEGER NOT NULL DEFAULT 0,
    vip INTEGER NOT NULL DEFAULT 0, vip_plan TEXT NOT NULL DEFAULT '', prime_until INTEGER NOT NULL DEFAULT 0,
    prime_used INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT NOT NULL UNIQUE, sender_id INTEGER NOT NULL,
    recipient_id INTEGER NOT NULL, body TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'text',
    payload TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, delivered INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY(sender_id) REFERENCES users(id), FOREIGN KEY(recipient_id) REFERENCES users(id))`,
  `CREATE INDEX IF NOT EXISTS idx_messages_recipient ON messages(recipient_id,delivered,id)`,
  `CREATE TABLE IF NOT EXISTS groups_chat (group_id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', owner_id INTEGER NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS group_members (
    group_id TEXT NOT NULL, user_id INTEGER NOT NULL, role TEXT NOT NULL DEFAULT 'member', joined_at INTEGER NOT NULL,
    PRIMARY KEY(group_id,user_id), FOREIGN KEY(group_id) REFERENCES groups_chat(group_id), FOREIGN KEY(user_id) REFERENCES users(id))`,
  `CREATE TABLE IF NOT EXISTS group_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT NOT NULL UNIQUE, group_id TEXT NOT NULL, sender_id INTEGER NOT NULL,
    body TEXT NOT NULL, created_at INTEGER NOT NULL, FOREIGN KEY(group_id) REFERENCES groups_chat(group_id), FOREIGN KEY(sender_id) REFERENCES users(id))`,
  `CREATE INDEX IF NOT EXISTS idx_group_messages ON group_messages(group_id,id)`,
  `CREATE TABLE IF NOT EXISTS admin_sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS reports (id TEXT PRIMARY KEY, reporter_id INTEGER NOT NULL, target_phone TEXT NOT NULL, reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'new', created_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_reports_target ON reports(target_phone,status)`,
  `CREATE TABLE IF NOT EXISTS prime_requests (
    id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, phone TEXT NOT NULL, name TEXT NOT NULL, plan TEXT NOT NULL,
    price INTEGER NOT NULL, first INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'new', created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS withdrawals (id TEXT PRIMARY KEY, phone TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'new', created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS avatars (user_id INTEGER PRIMARY KEY, data TEXT NOT NULL, v INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS media (
    id TEXT PRIMARY KEY, owner_id INTEGER NOT NULL, to_id INTEGER NOT NULL DEFAULT 0, kind TEXT NOT NULL, mime TEXT NOT NULL,
    size INTEGER NOT NULL, dur INTEGER NOT NULL DEFAULT 0, store TEXT NOT NULL DEFAULT 'd1', chunks INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_media_created ON media(created_at)`,
  `CREATE TABLE IF NOT EXISTS media_chunks (media_id TEXT NOT NULL, n INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(media_id,n))`,
];
// أعمدة اتضافت بعد النسخ القديمة: بنجرّبها لوحدها (لو موجودة الخطأ بيتجاهل).
const MIGRATIONS = [`ALTER TABLE users ADD COLUMN bio TEXT NOT NULL DEFAULT ''`];

let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady) return;
  await env.DB.batch(SCHEMA.map(q => env.DB.prepare(q)));
  for (const m of MIGRATIONS) { try { await env.DB.prepare(m).run(); } catch { /* موجود بالفعل */ } }
  await promoteDev(env);
  schemaReady = true;
}
async function promoteDev(env) {
  const d = devPhone(env); if (!d) return;
  await env.DB.prepare("UPDATE users SET vip=1,role='developer',vip_plan='dev' WHERE substr(phone,-10)=?").bind(digits(d).slice(-10)).run();
}

// ------------------------------- مساعدات ------------------------------------
async function getUser(r, env) {
  const t = r.headers.get('x-token') || '';
  if (!t) return null;
  return env.DB.prepare('SELECT u.*,COALESCE((SELECT v FROM avatars a WHERE a.user_id=u.id),0) AS av FROM users u WHERE u.token=?').bind(t).first();
}
async function getAdmin(r, env) {
  const t = r.headers.get('x-admin') || '';
  if (!t) return null;
  return env.DB.prepare('SELECT u.* FROM admin_sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires_at>? AND u.banned=0').bind(t, Date.now()).first();
}
const userOut = (env, u) => ({ phone: u.phone, name: u.name, points: u.points || 0, vip: !!(u.vip || u.prime_until > Date.now()), vipPlan: u.vip_plan || '', dev: isDev(env, u) });

// محاولات الدخول الغلط (حماية بسيطة داخل نفس الـ isolate)
const fails = new Map();
function tooMany(key) { const f = fails.get(key); return !!f && f.n >= 8 && Date.now() - f.t < 10 * 60 * 1000; }
function markFail(key) { const f = fails.get(key); fails.set(key, { n: f && Date.now() - f.t < 10 * 60 * 1000 ? f.n + 1 : 1, t: Date.now() }); }

// ------------------------------- الوسائط ------------------------------------
const b64 = u8 => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = s => { const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };

function sniff(u8) { // نتأكد إن الملف فعلاً صورة (مش أي حاجة بامتداد صورة)
  if (u8.length > 3 && u8[0] === 0xff && u8[1] === 0xd8) return 'image/jpeg';
  if (u8.length > 8 && u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e && u8[3] === 0x47) return 'image/png';
  if (u8.length > 12 && u8[0] === 0x52 && u8[1] === 0x49 && u8[2] === 0x46 && u8[3] === 0x46 && u8[8] === 0x57 && u8[9] === 0x45 && u8[10] === 0x42 && u8[11] === 0x50) return 'image/webp';
  return '';
}
async function mediaUpload(r, env, me, url) {
  const kind = clean(url.searchParams.get('kind'));
  if (!['image', 'audio'].includes(kind)) return fail('نوع الملف غير مدعوم', 400);
  const mime = clean(r.headers.get('content-type')).split(';')[0].toLowerCase();
  if (!(kind === 'image' ? IMG_MIME : AUD_MIME).includes(mime)) return fail('صيغة الملف غير مدعومة', 415);
  const declared = Number(r.headers.get('content-length') || 0);
  const max = LIM[kind];
  if (declared > max) return fail('الملف كبير', 413, { max });
  const buf = new Uint8Array(await r.arrayBuffer());
  if (!buf.length) return fail('الملف فاضي', 400);
  if (buf.length > max) return fail('الملف كبير', 413, { max });
  if (kind === 'image' && sniff(buf) !== mime) return fail('الملف مش صورة صالحة', 415);
  const id = randId(), now = Date.now(), dur = Math.max(0, Math.min(Number(url.searchParams.get('dur')) || 0, 30 * 60 * 1000));
  if (env.MEDIA) {
    await env.MEDIA.put('m/' + id, buf, { httpMetadata: { contentType: mime } });
    await env.DB.prepare("INSERT INTO media(id,owner_id,kind,mime,size,dur,store,chunks,created_at) VALUES(?,?,?,?,?,?,'r2',0,?)").bind(id, me.id, kind, mime, buf.length, dur, now).run();
  } else {
    const n = Math.ceil(buf.length / LIM.chunk), st = [];
    for (let i = 0; i < n; i++) st.push(env.DB.prepare('INSERT INTO media_chunks(media_id,n,data) VALUES(?,?,?)').bind(id, i, b64(buf.subarray(i * LIM.chunk, (i + 1) * LIM.chunk))));
    st.push(env.DB.prepare("INSERT INTO media(id,owner_id,kind,mime,size,dur,store,chunks,created_at) VALUES(?,?,?,?,?,?,'d1',?,?)").bind(id, me.id, kind, mime, buf.length, dur, n, now));
    await env.DB.batch(st);
  }
  return json({ ok: true, mid: id, size: buf.length, mime, dur });
}
async function mediaGet(env, me, id) {
  const m = await env.DB.prepare('SELECT * FROM media WHERE id=?').bind(id).first();
  if (!m) return fail('الملف غير موجود (ممكن يكون اتمسح)', 404);
  if (m.owner_id !== me.id && m.to_id !== me.id && !isDev(env, me)) return fail('غير مسموح', 403);
  const h = { ...CORS, 'content-type': m.mime, 'cache-control': 'private, max-age=31536000, immutable', 'content-length': String(m.size) };
  if (m.store === 'r2' && env.MEDIA) {
    const o = await env.MEDIA.get('m/' + id);
    if (!o) return fail('الملف غير موجود', 404);
    return new Response(o.body, { headers: h });
  }
  const q = await env.DB.prepare('SELECT data FROM media_chunks WHERE media_id=? ORDER BY n').bind(id).all();
  const parts = (q.results || []).map(x => unb64(x.data));
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0)); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return new Response(out, { headers: h });
}
async function dropMedia(env, ids) { // يمسح وسائط (D1 + R2)
  if (!ids.length) return;
  for (let i = 0; i < ids.length; i += 40) {
    const part = ids.slice(i, i + 40);
    if (env.MEDIA) { try { await env.MEDIA.delete(part.map(x => 'm/' + x)); } catch { /* تجاهل */ } }
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM media_chunks WHERE media_id IN (${inList(part.length)})`).bind(...part),
      env.DB.prepare(`DELETE FROM media WHERE id IN (${inList(part.length)})`).bind(...part),
    ]);
  }
}

// ------------------------------- حذف حساب -----------------------------------
async function deleteAccount(env, target) {
  const t = await env.DB.prepare('SELECT id,phone FROM users WHERE phone=?').bind(target).first();
  if (!t) return false;
  const mids = ((await env.DB.prepare('SELECT id FROM media WHERE owner_id=? OR to_id=?').bind(t.id, t.id).all()).results || []).map(x => x.id);
  await dropMedia(env, mids);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM messages WHERE sender_id=? OR recipient_id=?').bind(t.id, t.id),
    env.DB.prepare('DELETE FROM group_messages WHERE sender_id=?').bind(t.id),
    env.DB.prepare('DELETE FROM group_members WHERE user_id=?').bind(t.id),
    env.DB.prepare('DELETE FROM admin_sessions WHERE user_id=?').bind(t.id),
    env.DB.prepare('DELETE FROM reports WHERE reporter_id=? OR target_phone=?').bind(t.id, t.phone),
    env.DB.prepare('DELETE FROM prime_requests WHERE user_id=?').bind(t.id),
    env.DB.prepare('DELETE FROM withdrawals WHERE phone=?').bind(t.phone),
    env.DB.prepare('DELETE FROM avatars WHERE user_id=?').bind(t.id),
    env.DB.prepare('DELETE FROM users WHERE id=?').bind(t.id),
  ]);
  return true;
}

// ------------------------------- الاستقبال اللحظي (SSE) ---------------------
function events(req, env, me, ctx) {
  const enc = new TextEncoder();
  const { readable, writable } = new TransformStream();
  const w = writable.getWriter();
  let closed = false;
  const stop = () => { if (!closed) { closed = true; try { w.close(); } catch { /* تجاهل */ } } };
  try { req.signal.addEventListener('abort', stop); } catch { /* تجاهل */ }
  ctx.waitUntil((async () => {
    try {
      await w.write(enc.encode(': ok\n\n'));
      for (let n = 0; n < 24 && !closed; n++) {
        if (n % 8 === 0) await env.DB.prepare('UPDATE users SET last_seen=? WHERE id=?').bind(Date.now(), me.id).run();
        // أول دورة: كل اللي لسه ما اتأكدش وصوله (delivered<2). بعد كده: الجديد بس.
        const q = await env.DB.prepare(`SELECT id,payload,kind FROM messages WHERE recipient_id=? AND delivered<${n === 0 ? 2 : 1} ORDER BY id LIMIT 50`).bind(me.id).all();
        const rows = q.results || [];
        for (const row of rows) await w.write(enc.encode(`id: ${row.id}\ndata: ${row.payload}\n\n`));
        if (rows.length) {
          const ids = rows.map(x => x.id);
          await env.DB.prepare(`UPDATE messages SET delivered=CASE WHEN kind='signal' THEN 2 ELSE 1 END WHERE id IN (${inList(ids.length)}) AND delivered=0`).bind(...ids).run();
        } else await w.write(enc.encode(': k\n\n'));
        await sleep(700);
      }
    } catch { /* العميل قفل */ } finally { stop(); }
  })());
  return new Response(readable, { headers: { ...CORS, 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store, no-transform', 'x-accel-buffering': 'no' } });
}

// ------------------------------- التوجيه ------------------------------------
async function route(r, env, ctx) {
  if (r.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (!env.DB) return fail('D1 binding DB missing: اربط قاعدة D1 باسم DB', 500);
  const u = new URL(r.url), p = u.pathname.replace(/\/+$/, '') || '/';
  const POST = r.method === 'POST';

  if (p === '/' || p === '/ping') {
    let db = false, error;
    try { await ensureSchema(env); await env.DB.prepare('SELECT 1 FROM users LIMIT 1').first(); db = true; } catch (x) { error = String((x && x.message) || x); }
    return json({ ok: true, service: 'ASDLE Cloud', version: 4, db, error, media: env.MEDIA ? 'r2' : 'd1', devConfigured: !!devPhone(env), now: new Date().toISOString() });
  }
  await ensureSchema(env);
  const b = POST && p !== '/media' ? await readJson(r) : {};

  // ---- حساب جديد / دخول
  if (p === '/register' && POST) {
    const ph = phone(b.phone), name = clean(b.name), pass = String(b.pass || '');
    if (ph.length < 8 || name.length < 2 || name.length > 40 || pass.length < 6) return fail('بيانات التسجيل غير صحيحة', 400);
    if (moderated(name)) return fail('الاسم يحتوي على ألفاظ غير لائقة', 422);
    if (await env.DB.prepare('SELECT id FROM users WHERE phone=?').bind(ph).first()) return fail('الرقم مسجل بالفعل', 409);
    const salt = token().slice(0, 32), hash = await hashPass(pass, salt), tk = token(), now = Date.now();
    try { await env.DB.prepare('INSERT INTO users(phone,name,pass_hash,pass_salt,token,created_at,last_seen) VALUES(?,?,?,?,?,?,?)').bind(ph, name, hash, salt, tk, now, now).run(); }
    catch { return fail('تعذر إنشاء الحساب', 500); }
    await promoteDev(env);
    const x = await env.DB.prepare('SELECT * FROM users WHERE phone=?').bind(ph).first();
    return json({ token: tk, ...userOut(env, x) });
  }
  if (p === '/login' && POST) {
    const ph = phone(b.phone), pass = String(b.pass || ''), key = 'l:' + ph;
    if (tooMany(key)) return fail('محاولات كثيرة غلط، جرّب بعد شوية', 429);
    const x = await env.DB.prepare('SELECT * FROM users WHERE phone=?').bind(ph).first();
    if (!x || x.banned || (await hashPass(pass, x.pass_salt)) !== x.pass_hash) { markFail(key); return fail('رقم الهاتف أو كلمة المرور غير صحيحة', 401); }
    fails.delete(key);
    const tk = token();
    await env.DB.prepare('UPDATE users SET token=?,last_seen=? WHERE id=?').bind(tk, Date.now(), x.id).run();
    await promoteDev(env);
    const y = await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(x.id).first();
    return json({ token: tk, ...userOut(env, y) });
  }

  const me = await getUser(r, env);

  // ---- لوحة الإدارة القديمة (جلسة مؤقتة بعد تأكيد رقم المطور)
  if (p === '/admin/login' && POST) {
    const dev = devPhone(env);
    if (!dev) return fail('DEVELOPER_PHONE غير مضبوط على السيرفر', 403);
    if (!me) return fail('جلسة حسابك غير صالحة على السيرفر: سجّل خروج ثم دخول من جديد', 403);
    if (me.banned) return fail('الحساب محظور', 403);
    if (!isDev(env, me)) return fail('حسابك ليس حساب المطور', 403);
    const tk = token();
    await env.DB.prepare('INSERT INTO admin_sessions(token,user_id,expires_at) VALUES(?,?,?)').bind(tk, me.id, Date.now() + 8 * 3600 * 1000).run();
    return json({ token: tk });
  }
  if (p.startsWith('/admin/')) {
    const a = await getAdmin(r, env);
    if (!a) return fail('يلزم تسجيل دخول المطور', 403);
    return adminRoutes(p, POST, b, env, a);
  }

  if (!me || me.banned) return fail('يلزم تسجيل الدخول', 401);

  // ---- صندوق البلاغات للمطور فقط
  if (p.startsWith('/dev/')) {
    if (!isDev(env, me)) return fail('للمطور فقط', 403);
    return devRoutes(p, POST, b, u, env, me);
  }

  // ---- الحساب والبروفايل
  if (p === '/me') {
    const x = await env.DB.prepare('SELECT bio,prime_until,prime_used FROM users WHERE id=?').bind(me.id).first();
    return json({ ...userOut(env, me), bio: x?.bio || '', av: me.av || 0, primeUntil: x?.prime_until || 0, devConfigured: !!devPhone(env) });
  }
  if (p === '/profile') {
    const t = await env.DB.prepare('SELECT u.phone,u.name,u.bio,u.vip,u.vip_plan,u.prime_until,u.created_at,COALESCE((SELECT v FROM avatars a WHERE a.user_id=u.id),0) AS av FROM users u WHERE u.phone=? AND u.banned=0').bind(phone(u.searchParams.get('phone'))).first();
    if (!t) return fail('الحساب غير موجود', 404);
    return json({ phone: t.phone, name: t.name, bio: t.bio || '', vip: !!(t.vip || t.prime_until > Date.now()), vipPlan: t.vip_plan || '', dev: isDev(env, t), av: t.av, since: t.created_at });
  }
  if (p === '/exists') {
    const x = await env.DB.prepare('SELECT phone,name,vip,vip_plan,prime_until FROM users WHERE phone=? AND banned=0').bind(phone(u.searchParams.get('phone'))).first();
    return json({ exists: !!x, name: x?.name || '', vip: !!(x && (x.vip || x.prime_until > Date.now())), vipPlan: x?.vip_plan || '', dev: !!x && isDev(env, x) });
  }
  if (p === '/match' && POST) {
    const list = (Array.isArray(b.phones) ? b.phones : []).slice(0, 300).map(phone).filter(Boolean), found = {};
    for (let i = 0; i < list.length; i += 90) {
      const part = list.slice(i, i + 90);
      const q = await env.DB.prepare(`SELECT phone,name FROM users WHERE banned=0 AND phone IN (${inList(part.length)})`).bind(...part).all();
      for (const x of q.results || []) found[x.phone] = x.name;
    }
    return json({ found });
  }
  if (p === '/account/update' && POST) {
    const sets = [], vals = [], out = { ok: true };
    if (b.name !== undefined) {
      const name = clean(b.name);
      if (name.length < 2 || name.length > 40) return fail('الاسم لازم يكون من 2 إلى 40 حرفاً', 400);
      if (moderated(name)) return fail('الاسم يحتوي على ألفاظ غير لائقة', 422);
      sets.push('name=?'); vals.push(name); out.name = name;
    }
    if (b.bio !== undefined) {
      const bio = clean(b.bio).slice(0, 140);
      if (moderated(bio)) return fail('النبذة تحتوي على ألفاظ غير لائقة', 422);
      sets.push('bio=?'); vals.push(bio); out.bio = bio;
    }
    if (!sets.length) return fail('مفيش حاجة تتغيّر', 400);
    await env.DB.prepare(`UPDATE users SET ${sets.join(',')} WHERE id=?`).bind(...vals, me.id).run();
    return json(out);
  }
  if (p === '/account/password' && POST) {
    const old = String(b.old || ''), np = String(b.pass || '');
    if (np.length < 6) return fail('كلمة السر الجديدة لازم تكون 6 أحرف على الأقل', 400);
    if (tooMany('p:' + me.id)) return fail('محاولات كثيرة غلط، جرّب بعد شوية', 429);
    if ((await hashPass(old, me.pass_salt)) !== me.pass_hash) { markFail('p:' + me.id); return fail('كلمة السر الحالية غير صحيحة', 403); }
    const salt = token().slice(0, 32), hash = await hashPass(np, salt);
    await env.DB.prepare('UPDATE users SET pass_hash=?,pass_salt=? WHERE id=?').bind(hash, salt, me.id).run();
    return json({ ok: true });
  }
  if (p === '/account/logout' && POST) {
    await env.DB.prepare('UPDATE users SET token=NULL WHERE id=?').bind(me.id).run();
    return json({ ok: true });
  }

  // ---- صورة البروفايل (ظاهرة لكل المستخدمين)
  if (p === '/profile/avatar' && POST) {
    const img = typeof b.img === 'string' ? b.img.replace(/\s/g, '') : '', v = Date.now();
    if (!img) {
      await env.DB.prepare("INSERT INTO avatars(user_id,data,v) VALUES(?,'',?) ON CONFLICT(user_id) DO UPDATE SET data='',v=excluded.v").bind(me.id, v).run();
      return json({ ok: true, v, removed: true });
    }
    if (img.length > LIM.avatar || !/^[A-Za-z0-9+/=]+$/.test(img)) return fail('الصورة كبيرة أو غير صالحة', 413);
    await env.DB.prepare('INSERT INTO avatars(user_id,data,v) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET data=excluded.data,v=excluded.v').bind(me.id, img, v).run();
    return json({ ok: true, v });
  }
  if (p === '/avatar') {
    const t = await env.DB.prepare('SELECT a.data,a.v FROM avatars a JOIN users u ON u.id=a.user_id WHERE u.phone=? AND u.banned=0').bind(phone(u.searchParams.get('phone'))).first();
    if (!t) return json({ v: 0, img: '' });
    if (String(t.v) === clean(u.searchParams.get('v'))) return json({ v: t.v, same: true });
    return json({ v: t.v, img: t.data });
  }
  if (p === '/avatars/versions' && POST) {
    const list = (Array.isArray(b.phones) ? b.phones : []).slice(0, 300).map(phone).filter(Boolean), out = {};
    for (let i = 0; i < list.length; i += 90) {
      const part = list.slice(i, i + 90);
      const q = await env.DB.prepare(`SELECT u.phone,COALESCE(a.v,0) AS v FROM users u LEFT JOIN avatars a ON a.user_id=u.id WHERE u.banned=0 AND u.phone IN (${inList(part.length)})`).bind(...part).all();
      for (const x of q.results || []) out[x.phone] = x.v;
    }
    return json({ v: out });
  }

  // ---- الوسائط
  if (p === '/media' && POST) return mediaUpload(r, env, me, u);
  if (p.startsWith('/media/')) return mediaGet(env, me, p.slice(7));

  // ---- الرسائل
  if (p === '/send' && POST) return send(b, env, me);
  if (p === '/events') return events(r, env, me, ctx);
  if (p === '/ack' && POST) {
    const ids = (Array.isArray(b.ids) ? b.ids : []).map(Number).filter(Number.isInteger).slice(0, 100);
    if (ids.length) await env.DB.prepare(`UPDATE messages SET delivered=2 WHERE recipient_id=? AND id IN (${inList(ids.length)})`).bind(me.id, ...ids).run();
    return json({ ok: true });
  }
  if (p === '/sig' && POST) {
    const to = phone(b.to);
    if (!to || !['sig', 'pq', 'pr', 'del'].includes(clean(b.t))) return fail('بيانات الإشارة غير صالحة', 400);
    const target = await env.DB.prepare('SELECT id FROM users WHERE phone=?').bind(to).first();
    if (!target) return fail('المستخدم غير موجود', 404);
    const mid = 'sig-' + randId();
    const msg = { ...b, from: me.phone, name: me.name, to, vip: !!me.vip, vipPlan: me.vip_plan || '', av: me.av || 0, id: b.id || mid };
    await env.DB.prepare("INSERT INTO messages(message_id,sender_id,recipient_id,body,kind,payload,created_at) VALUES(?,?,?,?,?,?,?)").bind(mid, me.id, target.id, '', 'signal', JSON.stringify(msg), Date.now()).run();
    return json({ ok: true, delivered: false });
  }

  // ---- البلاغات (من المستخدم)
  if (p === '/report' && POST) {
    const target = phone(b.phone), reason = clean(b.reason).slice(0, 500);
    const t = target && target !== me.phone ? await env.DB.prepare('SELECT id,phone FROM users WHERE phone=?').bind(target).first() : null;
    if (!t) return fail('الحساب غير صالح', 400);
    if (await env.DB.prepare('SELECT id FROM reports WHERE reporter_id=? AND target_phone=? AND created_at>?').bind(me.id, target, Date.now() - 24 * 3600 * 1000).first()) return fail('سبق وأبلغت عن هذا الحساب النهاردة', 429);
    const id = randId(), now = Date.now();
    await env.DB.prepare("INSERT INTO reports(id,reporter_id,target_phone,reason,status,created_at) VALUES(?,?,?,?,'new',?)").bind(id, me.id, target, reason, now).run();
    // إشعار فوري للمطور فقط
    const d = devPhone(env);
    if (d) {
      const dv = await env.DB.prepare('SELECT id FROM users WHERE substr(phone,-10)=?').bind(digits(d).slice(-10)).first();
      if (dv) {
        const mid = 'rpt-' + id;
        await env.DB.prepare("INSERT OR IGNORE INTO messages(message_id,sender_id,recipient_id,body,kind,payload,created_at) VALUES(?,?,?,?,?,?,?)")
          .bind(mid, me.id, dv.id, '', 'signal', JSON.stringify({ t: 'rpt', id: mid, from: 'system', phone: target, reason, ts: now }), now).run();
      }
    }
    return json({ ok: true, id });
  }

  // ---- Prime
  if (p === '/prime/info') {
    const x = await env.DB.prepare('SELECT points,prime_until,prime_used,vip_plan FROM users WHERE id=?').bind(me.id).first();
    const last = await env.DB.prepare('SELECT status FROM prime_requests WHERE user_id=? ORDER BY created_at DESC LIMIT 1').bind(me.id).first(), first = !x.prime_used;
    return json({ points: x.points, cost: 100, until: x.prime_until, active: x.prime_until > Date.now(), vipPlan: x.vip_plan || '', first, month: 100, year: 900, monthNow: first ? 50 : 100, yearNow: first ? 450 : 900, lastRequest: last?.status || '' });
  }
  if (p === '/prime/redeem' && POST) {
    const x = await env.DB.prepare('SELECT points FROM users WHERE id=?').bind(me.id).first();
    if (x.points < 100) return fail('تحتاج 100 نقطة', 400);
    await env.DB.prepare("UPDATE users SET points=points-100,prime_until=MAX(prime_until,?)+2592000000,prime_used=1,vip=1,vip_plan='month' WHERE id=?").bind(Date.now(), me.id).run();
    return json({ ok: true });
  }
  if (p === '/prime/request' && POST) {
    const plan = clean(b.plan);
    if (!['month', 'year'].includes(plan)) return fail('خطة غير صالحة', 400);
    if (await env.DB.prepare("SELECT id FROM prime_requests WHERE user_id=? AND status='new'").bind(me.id).first()) return fail('لديك طلب قيد الانتظار', 409);
    const x = await env.DB.prepare('SELECT prime_used FROM users WHERE id=?').bind(me.id).first(), first = !x.prime_used, price = (plan === 'year' ? 900 : 100) * (first ? 0.5 : 1);
    await env.DB.prepare("INSERT INTO prime_requests(id,user_id,phone,name,plan,price,first,status,created_at) VALUES(?,?,?,?,?,?,?,'new',?)").bind(randId(), me.id, me.phone, me.name, plan, price, first ? 1 : 0, Date.now()).run();
    return json({ ok: true, price });
  }

  // ---- المجموعات (محفوظة للتوافق)
  if (p.startsWith('/groups/')) return groups(p, POST, b, u, env, me);

  return fail('المسار غير موجود', 404, { path: p });
}

// ------------------------------- إرسال رسالة --------------------------------
async function send(b, env, me) {
  const to = phone(b.to || b.phone), mid = clean(b.id || '') || randId();
  const kind = ['image', 'audio'].includes(b.kind) ? b.kind : 'text';
  let txt = clean(b.text || b.message);
  if (!to) return fail('الرسالة غير صالحة', 400);
  if (kind === 'text' && (!txt || txt.length > LIM.text)) return fail('الرسالة غير صالحة', 400);
  if (kind === 'text' && moderated(txt)) return fail('تم رفض الرسالة لاحتوائها على ألفاظ غير لائقة', 422);
  if (txt.length > LIM.text) return fail('الرسالة غير صالحة', 400);
  if (!txt) txt = label(kind);
  const target = await env.DB.prepare('SELECT id FROM users WHERE phone=? AND banned=0').bind(to).first();
  if (!target) return fail('المستلم غير موجود', 404);
  const recent = await env.DB.prepare('SELECT COUNT(*) AS n FROM messages WHERE sender_id=? AND created_at>? AND kind<>?').bind(me.id, Date.now() - 60000, 'signal').first();
  if ((recent?.n || 0) >= LIM.sendPerMin) return fail('بتبعت بسرعة كبيرة، استنى شوية', 429);

  const msg = { id: mid, from: me.phone, name: me.name, to, text: txt, ts: Number(b.ts) || Date.now(), vip: !!me.vip, vipPlan: me.vip_plan || '', av: me.av || 0 };
  if (kind !== 'text') {
    const mediaId = clean(b.mid);
    if (mediaId) {
      const m = await env.DB.prepare('SELECT * FROM media WHERE id=?').bind(mediaId).first();
      if (!m || m.owner_id !== me.id || m.kind !== kind) return fail('الملف غير موجود، ارفعه من جديد', 404, { code: 'media_missing' });
      if (m.to_id && m.to_id !== target.id) return fail('الملف مرتبط بمحادثة تانية', 409);
      await env.DB.prepare('UPDATE media SET to_id=? WHERE id=?').bind(target.id, mediaId).run();
      msg.kind = kind; msg.mid = mediaId; msg.dur = m.dur; msg.size = m.size; msg.mime = m.mime;
    } else if (kind === 'image' && typeof b.img === 'string' && b.img.length > 0 && b.img.length <= LIM.legacyImg) {
      msg.kind = 'image'; msg.img = b.img; // توافق مع الإصدارات القديمة
    } else return fail('الملف مفقود أو كبير', 413);
  }
  const ins = await env.DB.prepare('INSERT OR IGNORE INTO messages(message_id,sender_id,recipient_id,body,kind,payload,created_at) VALUES(?,?,?,?,?,?,?)')
    .bind(mid, me.id, target.id, txt, kind, JSON.stringify(msg), Date.now()).run();
  const fresh = !!ins.meta?.changes;
  if (fresh) await env.DB.prepare('UPDATE users SET points=points+5 WHERE id=?').bind(me.id).run();
  return json({ ok: true, delivered: false, duplicate: !fresh, points_awarded: fresh ? 5 : 0, message_id: mid });
}

// ------------------------------- صندوق المطور -------------------------------
async function devRoutes(p, POST, b, u, env, me) {
  if (p === '/dev/summary') {
    const x = await env.DB.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN status='new' THEN 1 ELSE 0 END) AS open, COUNT(DISTINCT target_phone) AS accounts FROM reports").first();
    return json({ total: x?.total || 0, open: x?.open || 0, accounts: x?.accounts || 0 });
  }
  if (p === '/dev/accounts') { // الحسابات اللي عليها بلاغات، أو بحث برقم/اسم
    const q = clean(u.searchParams.get('q')).slice(0, 40), only = u.searchParams.get('only') !== '0';
    const like = '%' + q.replace(/[%_]/g, '') + '%';
    const sql = `SELECT u.phone,u.name,u.banned,u.vip,COUNT(r.id) AS reports,COALESCE(SUM(CASE WHEN r.status='new' THEN 1 ELSE 0 END),0) AS open,COALESCE(MAX(r.created_at),0) AS last
      FROM users u LEFT JOIN reports r ON r.target_phone=u.phone
      ${q ? 'WHERE (u.phone LIKE ? OR u.name LIKE ?)' : ''} GROUP BY u.id ${q || !only ? '' : 'HAVING COUNT(r.id)>0'} ORDER BY open DESC,last DESC,u.id DESC LIMIT 100`;
    const st = env.DB.prepare(sql);
    const res = await (q ? st.bind(like, like) : st).all();
    return json({ accounts: (res.results || []).map(x => ({ ...x, isDev: isDev(env, x) })) });
  }
  if (p === '/dev/reports') { // بلاغات حساب واحد
    const target = phone(u.searchParams.get('phone'));
    const q = await env.DB.prepare(`SELECT r.id,r.reason,r.status,r.created_at AS ts,ru.phone AS reporter,ru.name AS reporterName
      FROM reports r LEFT JOIN users ru ON ru.id=r.reporter_id WHERE r.target_phone=? ORDER BY r.created_at DESC LIMIT 200`).bind(target).all();
    return json({ phone: target, reports: q.results || [] });
  }
  if (p === '/dev/report-status' && POST) {
    const status = ['new', 'under_review', 'resolved', 'dismissed'].includes(clean(b.status)) ? clean(b.status) : 'resolved';
    if (b.id) await env.DB.prepare('UPDATE reports SET status=? WHERE id=?').bind(status, clean(b.id)).run();
    else if (b.phone) await env.DB.prepare('UPDATE reports SET status=? WHERE target_phone=?').bind(status, phone(b.phone)).run();
    else return fail('حدّد بلاغ أو حساب', 400);
    return json({ ok: true });
  }
  if (p === '/dev/ban' && POST) {
    const target = phone(b.phone);
    if (sameDev(target, me.phone)) return fail('لا يمكن حظر حساب المطور', 400);
    await env.DB.prepare('UPDATE users SET banned=?,token=CASE WHEN ?=1 THEN NULL ELSE token END WHERE phone=?').bind(b.banned ? 1 : 0, b.banned ? 1 : 0, target).run();
    return json({ ok: true });
  }
  if (p === '/dev/delete-account' && POST) {
    const target = phone(b.phone);
    if (sameDev(target, me.phone)) return fail('لا يمكن حذف حساب المطور', 400);
    return (await deleteAccount(env, target)) ? json({ ok: true }) : fail('الحساب غير موجود', 404);
  }
  return fail('مسار غير معروف', 404);
}

// ------------------------------- لوحة الإدارة (قديمة) -----------------------
async function adminRoutes(p, POST, b, env, a) {
  if (p === '/admin/users') {
    const q = await env.DB.prepare(`SELECT phone,name,role,points,vip,banned,created_at,(last_seen>?) AS online,0 AS pending,
      (SELECT COUNT(*) FROM reports r WHERE r.target_phone=users.phone) AS reports,
      (SELECT COUNT(*) FROM reports r WHERE r.target_phone=users.phone AND r.status='new') AS openReports
      FROM users ORDER BY id DESC LIMIT 500`).bind(Date.now() - 40000).all();
    const users = q.results || [];
    return json({ users, stats: { users: users.length, online: users.filter(x => x.online).length, relayed: 0, pending: 0 } });
  }
  if (p === '/admin/prime-requests') return json({ requests: ((await env.DB.prepare('SELECT id,phone,name,plan,price,first,status,created_at AS ts FROM prime_requests ORDER BY created_at DESC').all()).results) || [] });
  if (p === '/admin/prime-decide' && POST) {
    const x = await env.DB.prepare("SELECT * FROM prime_requests WHERE id=? AND status='new'").bind(clean(b.id)).first();
    if (!x) return fail('الطلب غير موجود أو تم التعامل معه', 404);
    if (b.approve) {
      const days = x.plan === 'year' ? 365 : 30;
      await env.DB.batch([
        env.DB.prepare('UPDATE users SET vip=1,vip_plan=?,prime_until=MAX(prime_until,?)+?,prime_used=1 WHERE id=?').bind(x.plan, Date.now(), days * 86400000, x.user_id),
        env.DB.prepare("UPDATE prime_requests SET status='paid' WHERE id=?").bind(x.id),
      ]);
    } else await env.DB.prepare("UPDATE prime_requests SET status='rejected' WHERE id=?").bind(x.id).run();
    return json({ ok: true });
  }
  if (p === '/admin/withdrawals') return json({ withdrawals: ((await env.DB.prepare('SELECT * FROM withdrawals ORDER BY created_at DESC').all()).results) || [] });
  if (p === '/admin/withdrawal-status' && POST) { await env.DB.prepare('UPDATE withdrawals SET status=? WHERE id=?').bind(clean(b.status), clean(b.id)).run(); return json({ ok: true }); }
  if (p === '/admin/ban' && POST) { await env.DB.prepare('UPDATE users SET banned=? WHERE phone=?').bind(b.banned ? 1 : 0, phone(b.phone)).run(); return json({ ok: true }); }
  if (p === '/admin/vip' && POST) { await env.DB.prepare('UPDATE users SET vip=? WHERE phone=?').bind(b.vip ? 1 : 0, phone(b.phone)).run(); return json({ ok: true }); }
  if (p === '/admin/delete' && POST) {
    const target = phone(b.phone);
    if (sameDev(target, a.phone)) return fail('لا يمكن حذف حساب المطور', 400);
    return (await deleteAccount(env, target)) ? json({ ok: true }) : fail('الحساب غير موجود', 404);
  }
  if (p === '/admin/set-password' && POST) {
    const target = phone(b.phone), np = String(b.pass || '');
    if (np.length < 6) return fail('كلمة السر لازم تكون 6 أحرف على الأقل', 400);
    const t = await env.DB.prepare('SELECT id FROM users WHERE phone=?').bind(target).first();
    if (!t) return fail('الحساب غير موجود', 404);
    const salt = token().slice(0, 32), hash = await hashPass(np, salt);
    if (sameDev(target, a.phone)) await env.DB.prepare('UPDATE users SET pass_hash=?,pass_salt=? WHERE id=?').bind(hash, salt, t.id).run();
    else await env.DB.prepare('UPDATE users SET pass_hash=?,pass_salt=?,token=NULL WHERE id=?').bind(hash, salt, t.id).run();
    return json({ ok: true });
  }
  if (p === '/admin/edit-user' && POST) { await env.DB.prepare('UPDATE users SET name=? WHERE phone=?').bind(clean(b.name).slice(0, 40), phone(b.phone)).run(); return json({ ok: true }); }
  if (p === '/admin/message' && POST) {
    const target = await env.DB.prepare('SELECT id FROM users WHERE phone=?').bind(phone(b.phone)).first();
    if (!target) return fail('المستخدم غير موجود', 404);
    const mid = 'admin-' + randId(), msg = { id: mid, from: 'ASDLE', name: 'فريق ASDLE', to: phone(b.phone), text: clean(b.text).slice(0, LIM.text), ts: Date.now() };
    await env.DB.prepare("INSERT INTO messages(message_id,sender_id,recipient_id,body,kind,payload,created_at) VALUES(?,?,?,?,?,?,?)").bind(mid, a.id, target.id, msg.text, 'text', JSON.stringify(msg), Date.now()).run();
    return json({ ok: true });
  }
  return fail('مسار إدارة غير معروف', 404);
}

// ------------------------------- المجموعات ----------------------------------
async function groups(p, POST, b, u, env, me) {
  if (p === '/groups/create' && POST) {
    const name = clean(b.name), desc = clean(b.desc);
    if (name.length < 2 || name.length > 60) return fail('اسم المجموعة غير صالح', 400);
    const id = 'g' + randId(), now = Date.now();
    await env.DB.prepare('INSERT INTO groups_chat(group_id,name,description,owner_id,created_at) VALUES(?,?,?,?,?)').bind(id, name, desc, me.id, now).run();
    await env.DB.prepare("INSERT INTO group_members(group_id,user_id,role,joined_at) VALUES(?,?,'owner',?)").bind(id, me.id, now).run();
    const list = (Array.isArray(b.members) ? b.members : []).slice(0, 99).map(phone).filter(Boolean);
    if (list.length) {
      const q = await env.DB.prepare(`SELECT id FROM users WHERE banned=0 AND phone IN (${inList(list.length)})`).bind(...list).all();
      for (const m of q.results || []) await env.DB.prepare("INSERT OR IGNORE INTO group_members(group_id,user_id,role,joined_at) VALUES(?,?,'member',?)").bind(id, m.id, now).run();
    }
    return json({ ok: true, id, name });
  }
  if (p === '/groups/list') {
    const q = await env.DB.prepare('SELECT g.group_id AS id,g.name,g.description AS desc,g.owner_id,gm.role,(SELECT COUNT(*) FROM group_members z WHERE z.group_id=g.group_id) AS members FROM groups_chat g JOIN group_members gm ON gm.group_id=g.group_id WHERE gm.user_id=? ORDER BY g.created_at DESC').bind(me.id).all();
    return json({ groups: q.results || [] });
  }
  if (p === '/groups/messages') {
    const id = clean(u.searchParams.get('id'));
    if (!(await env.DB.prepare('SELECT 1 FROM group_members WHERE group_id=? AND user_id=?').bind(id, me.id).first())) return fail('غير مسموح', 403);
    const q = await env.DB.prepare('SELECT m.message_id AS id,m.body AS text,m.created_at AS ts,u.phone AS "from",u.name FROM group_messages m JOIN users u ON u.id=m.sender_id WHERE m.group_id=? ORDER BY m.id DESC LIMIT 100').bind(id).all();
    return json({ messages: (q.results || []).reverse() });
  }
  if (p === '/groups/send' && POST) {
    const id = clean(b.id), txt = clean(b.text), mid = clean(b.message_id) || randId();
    if (!txt || txt.length > LIM.text) return fail('الرسالة غير صالحة', 400);
    if (moderated(txt)) return fail('تم رفض الرسالة', 422);
    if (!(await env.DB.prepare('SELECT 1 FROM group_members WHERE group_id=? AND user_id=?').bind(id, me.id).first())) return fail('لست عضواً', 403);
    const ins = await env.DB.prepare('INSERT OR IGNORE INTO group_messages(message_id,group_id,sender_id,body,created_at) VALUES(?,?,?,?,?)').bind(mid, id, me.id, txt, Date.now()).run();
    const fresh = !!ins.meta?.changes;
    if (fresh) await env.DB.prepare('UPDATE users SET points=points+5 WHERE id=?').bind(me.id).run();
    return json({ ok: true, duplicate: !fresh, points_awarded: fresh ? 5 : 0 });
  }
  if (p === '/groups/member' && POST) {
    const id = clean(b.id);
    const target = await env.DB.prepare('SELECT id FROM users WHERE phone=?').bind(phone(b.phone)).first();
    const owner = await env.DB.prepare('SELECT role FROM group_members WHERE group_id=? AND user_id=?').bind(id, me.id).first();
    if (!owner || !['owner', 'admin'].includes(owner.role)) return fail('صلاحية إدارة المجموعة مطلوبة', 403);
    if (b.action === 'add' && target) { await env.DB.prepare("INSERT OR IGNORE INTO group_members(group_id,user_id,role,joined_at) VALUES(?,?,'member',?)").bind(id, target.id, Date.now()).run(); return json({ ok: true }); }
    if (b.action === 'remove' && target) { await env.DB.prepare('DELETE FROM group_members WHERE group_id=? AND user_id=?').bind(id, target.id).run(); return json({ ok: true }); }
    return fail('طلب غير صالح', 400);
  }
  if (p === '/groups/leave' && POST) {
    const id = clean(b.id), x = await env.DB.prepare('SELECT role FROM group_members WHERE group_id=? AND user_id=?').bind(id, me.id).first();
    if (!x) return fail('لست عضواً', 404);
    if (x.role === 'owner') return fail('مالك المجموعة لا يمكنه المغادرة قبل نقل الملكية', 403);
    await env.DB.prepare('DELETE FROM group_members WHERE group_id=? AND user_id=?').bind(id, me.id).run();
    return json({ ok: true });
  }
  return fail('المسار غير موجود', 404);
}

// ------------------------------- تنظيف يومي (Cron) --------------------------
async function cleanup(env) {
  await ensureSchema(env);
  const now = Date.now();
  const old = ((await env.DB.prepare('SELECT id FROM media WHERE created_at<? LIMIT 200').bind(now - LIM.mediaDays * 86400000).all()).results || []).map(x => x.id);
  await dropMedia(env, old);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM messages WHERE delivered=2 AND created_at<?').bind(now - 3 * 86400000),
    env.DB.prepare('DELETE FROM messages WHERE created_at<?').bind(now - LIM.msgDays * 86400000),
    env.DB.prepare('DELETE FROM admin_sessions WHERE expires_at<?').bind(now),
  ]);
  return { media: old.length };
}

export default {
  async fetch(r, env, ctx) {
    try { return await route(r, env, ctx); }
    catch (err) {
      const m = String((err && err.message) || err);
      return json({ error: /no such table/i.test(m) ? 'قاعدة البيانات غير مهيأة: نفّذ schema.sql على D1' : 'خطأ داخلي', detail: (env.DEBUG === 'true' || /no such table/i.test(m)) ? m : undefined }, 500);
    }
  },
  async scheduled(_event, env, ctx) { ctx.waitUntil(cleanup(env)); },
};

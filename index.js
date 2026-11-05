// Fly High VoBaCa · servidor (Cloudflare Worker)
// - Sirve la web (los archivos del repositorio) tal cual.
// - /api/…: cuentas con «Entrar con Google», sesiones y sincronización de los datos de cada jugador en D1.
// Pensado para crecer: la tabla de usuarios (con nombre de jugador único) es la base de la liga y del simulador online.
//
// Secretos necesarios (Cloudflare → el Worker → Settings → Variables and Secrets):
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
// Base de datos: D1 enlazada como DB (ver wrangler.jsonc). Las tablas se crean solas la primera vez.

const SESSION_COOKIE = 'fh_s', STATE_COOKIE = 'fh_st';
const SESSION_DAYS = 180;
const MAX_BODY = 8 * 1024 * 1024;          // 8 MB por sincronización
const MAX_VALUE = 1800 * 1024;             // D1 admite filas de hasta 2 MB
const SYNC_KEYS = ['decks', 'del', 'tr', 'lay', 'col', 'games', 'liga', 'tags', 'srch', 'tourn'];

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);
    try {
      return await api(req, env, url);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message, code: e.code }, e.status);
      console.error(e);
      return json({ error: 'Error del servidor: ' + (e && e.message || e) }, 500);
    }
  }
};

class HttpError extends Error { constructor(status, message, code) { super(message); this.status = status; this.code = code || ''; } }
const json = (obj, status = 200, headers = {}) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers } });
const now = () => Date.now();
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const randomToken = (n = 32) => b64u(crypto.getRandomValues(new Uint8Array(n)));
const sha256 = async s => b64u(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
function cookies(req) {
  const out = {}; (req.headers.get('Cookie') || '').split(/;\s*/).forEach(p => { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i)] = decodeURIComponent(p.slice(i + 1)); });
  return out;
}
const setCookie = (name, value, maxAge) => `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady) return;
  if (!env.DB) throw new HttpError(503, 'Falta enlazar la base de datos D1 (DB) al Worker.', 'no_db');
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, google_sub TEXT UNIQUE NOT NULL, email TEXT, name TEXT, avatar TEXT,
      nick TEXT, nick_lc TEXT UNIQUE, sync_rev INTEGER NOT NULL DEFAULT 0, created INTEGER, seen INTEGER)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, created INTEGER, expires INTEGER, ua TEXT)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS userdata (user_id TEXT NOT NULL, k TEXT NOT NULL, v TEXT NOT NULL, updated INTEGER, PRIMARY KEY (user_id, k))`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS liga (user_id TEXT PRIMARY KEY, gist TEXT UNIQUE, data TEXT NOT NULL, updated INTEGER)`)
  ]);
  schemaReady = true;
}

async function currentUser(req, env) {
  const tok = cookies(req)[SESSION_COOKIE]; if (!tok) return null;
  const s = await env.DB.prepare('SELECT user_id, expires FROM sessions WHERE hash = ?').bind(await sha256(tok)).first();
  if (!s || s.expires < now()) return null;
  return env.DB.prepare('SELECT id, email, name, avatar, nick, sync_rev, created FROM users WHERE id = ?').bind(s.user_id).first();
}
async function needUser(req, env) {
  const u = await currentUser(req, env);
  if (!u) throw new HttpError(401, 'No has entrado con tu cuenta (o la sesión ha caducado).', 'no_session');
  return u;
}
// Las peticiones que cambian algo deben llevar esta cabecera: otra web no puede añadirla sin permiso (protección CSRF)
function needSameApp(req) { if (req.headers.get('X-FH') !== '1') throw new HttpError(403, 'Petición no permitida.', 'csrf'); }
async function readJson(req) {
  const len = +(req.headers.get('Content-Length') || 0); if (len > MAX_BODY) throw new HttpError(413, 'Demasiados datos.', 'too_big');
  const txt = await req.text(); if (txt.length > MAX_BODY) throw new HttpError(413, 'Demasiados datos.', 'too_big');
  try { return JSON.parse(txt || '{}'); } catch (e) { throw new HttpError(400, 'Datos no válidos.', 'bad_json'); }
}
const publicUser = u => ({ id: u.id, name: u.name || '', email: u.email || '', avatar: u.avatar || '', nick: u.nick || '', created: u.created });

async function api(req, env, url) {
  const p = url.pathname, m = req.method;
  if (p === '/api/health') return json({ ok: true, app: 'fly-high-vobaca', login: !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET), db: !!env.DB });
  await ensureSchema(env);

  // ---- Entrar con Google (flujo con redirección: funciona también en la app instalada) ----
  if (p === '/api/auth/google' && m === 'GET') {
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) throw new HttpError(503, 'Falta configurar el acceso con Google en el servidor.', 'no_google');
    const state = randomToken(18);
    const back = (url.searchParams.get('back') || '/').replace(/[^\w\-./#=]/g, '');
    const g = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    g.search = new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, redirect_uri: url.origin + '/api/auth/callback', response_type: 'code', scope: 'openid email profile', state, prompt: 'select_account' });
    return new Response(null, { status: 302, headers: { Location: g.href, 'Set-Cookie': setCookie(STATE_COOKIE, state + '|' + (back.startsWith('/') ? back : '/'), 600), 'Cache-Control': 'no-store' } });
  }
  if (p === '/api/auth/callback' && m === 'GET') {
    const st = (cookies(req)[STATE_COOKIE] || '').split('|'), back = st[1] || '/';
    const fail = why => new Response(null, { status: 302, headers: { Location: url.origin + back.split('#')[0] + '#acct=err&m=' + encodeURIComponent(why), 'Set-Cookie': setCookie(STATE_COOKIE, '', 0) } });
    if (url.searchParams.get('error')) return fail(url.searchParams.get('error') === 'access_denied' ? 'cancelado' : 'google');
    if (!st[0] || st[0] !== url.searchParams.get('state')) return fail('estado');
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code: url.searchParams.get('code') || '', client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: url.origin + '/api/auth/callback', grant_type: 'authorization_code' })
    });
    if (!r.ok) return fail('token');
    const tk = await r.json();
    // El id_token llega directamente de Google por HTTPS, así que basta con leerlo y comprobar sus datos básicos
    let info; try { info = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(tk.id_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)))); } catch (e) { return fail('token'); }
    if (info.aud !== env.GOOGLE_CLIENT_ID || !/^(https:\/\/)?accounts\.google\.com$/.test(info.iss) || info.exp * 1000 < now() || !info.sub) return fail('token');
    let u = await env.DB.prepare('SELECT id FROM users WHERE google_sub = ?').bind(info.sub).first();
    const t = now();
    if (!u) {
      u = { id: randomToken(12) };
      await env.DB.prepare('INSERT INTO users (id, google_sub, email, name, avatar, created, seen) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(u.id, info.sub, info.email || '', info.name || '', info.picture || '', t, t).run();
    } else {
      await env.DB.prepare('UPDATE users SET email = ?, name = ?, avatar = ?, seen = ? WHERE id = ?').bind(info.email || '', info.name || '', info.picture || '', t, u.id).run();
    }
    const tok = randomToken(32);
    await env.DB.prepare('INSERT INTO sessions (hash, user_id, created, expires, ua) VALUES (?, ?, ?, ?, ?)').bind(await sha256(tok), u.id, t, t + SESSION_DAYS * 864e5, (req.headers.get('User-Agent') || '').slice(0, 200)).run();
    const h = new Headers({ Location: url.origin + back.split('#')[0] + '#acct=ok', 'Cache-Control': 'no-store' });
    h.append('Set-Cookie', setCookie(SESSION_COOKIE, tok, SESSION_DAYS * 86400));
    h.append('Set-Cookie', setCookie(STATE_COOKIE, '', 0));
    return new Response(null, { status: 302, headers: h });
  }
  if (p === '/api/auth/logout' && m === 'POST') {
    needSameApp(req);
    const tok = cookies(req)[SESSION_COOKIE];
    if (tok) await env.DB.prepare('DELETE FROM sessions WHERE hash = ?').bind(await sha256(tok)).run();
    return json({ ok: true }, 200, { 'Set-Cookie': setCookie(SESSION_COOKIE, '', 0) });
  }

  // ---- Perfil ----
  if (p === '/api/me' && m === 'GET') {
    const u = await currentUser(req, env);
    return u ? json({ user: publicUser(u) }) : json({ user: null }, 401);
  }
  if (p === '/api/me' && m === 'PATCH') {
    needSameApp(req); const u = await needUser(req, env), b = await readJson(req);
    if ('nick' in b) {
      const nick = String(b.nick || '').trim().replace(/\s+/g, ' ');
      if (nick && !/^[\p{L}\p{N} _.\-]{2,20}$/u.test(nick)) throw new HttpError(400, 'El nombre de jugador debe tener entre 2 y 20 letras, números, espacios, «_», «.» o «-».', 'bad_nick');
      const lc = nick ? nick.toLowerCase() : null;
      if (lc) { const o = await env.DB.prepare('SELECT id FROM users WHERE nick_lc = ? AND id != ?').bind(lc, u.id).first(); if (o) throw new HttpError(409, 'Ese nombre de jugador ya lo usa otra persona.', 'nick_taken'); }
      await env.DB.prepare('UPDATE users SET nick = ?, nick_lc = ? WHERE id = ?').bind(nick || null, lc, u.id).run();
    }
    return json({ user: publicUser(await currentUser(req, env)) });
  }
  if (p === '/api/me' && m === 'DELETE') {   // borrar la cuenta y todos sus datos
    needSameApp(req); const u = await needUser(req, env);
    await env.DB.batch([
      env.DB.prepare('DELETE FROM userdata WHERE user_id = ?').bind(u.id),
      env.DB.prepare('DELETE FROM liga WHERE user_id = ?').bind(u.id),
      env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(u.id),
      env.DB.prepare('DELETE FROM users WHERE id = ?').bind(u.id)
    ]);
    return json({ ok: true }, 200, { 'Set-Cookie': setCookie(SESSION_COOKIE, '', 0) });
  }

  // ---- Sincronización: los mismos datos que el Gist, guardados por partes ----
  if (p === '/api/sync' && m === 'GET') {
    const u = await needUser(req, env);
    const rows = await env.DB.prepare('SELECT k, v FROM userdata WHERE user_id = ?').bind(u.id).all();
    const data = {}; (rows.results || []).forEach(r => { try { data[r.k] = JSON.parse(r.v); } catch (e) {} });
    return json({ rev: u.sync_rev, empty: !(rows.results || []).length, data });
  }
  if (p === '/api/sync' && m === 'PUT') {
    needSameApp(req); const u = await needUser(req, env), b = await readJson(req);
    const data = b.data || {}, writes = [];
    for (const k of SYNC_KEYS) if (k in data) {
      const v = JSON.stringify(data[k]);
      if (v.length > MAX_VALUE) throw new HttpError(413, `La parte «${k}» es demasiado grande para guardarla (${Math.round(v.length / 1024)} KB).`, 'too_big');
      writes.push([k, v]);
    }
    // Solo se guarda si nadie más ha guardado desde que este dispositivo leyó (si no, vuelve a leer y combinar)
    const r = await env.DB.prepare('UPDATE users SET sync_rev = sync_rev + 1, seen = ? WHERE id = ? AND sync_rev = ?').bind(now(), u.id, +b.rev || 0).run();
    if (!r.meta || !r.meta.changes) throw new HttpError(409, 'Hay cambios más nuevos en otro dispositivo.', 'conflict');
    const t = now();
    if (writes.length) await env.DB.batch(writes.map(([k, v]) => env.DB.prepare('INSERT INTO userdata (user_id, k, v, updated) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, k) DO UPDATE SET v = excluded.v, updated = excluded.updated').bind(u.id, k, v, t)));
    return json({ ok: true, rev: (+b.rev || 0) + 1 });
  }

  // ---- Liga con amigos ----
  // Cada jugador publica su «hoja de liga» (sus partidas contra amigos); la clasificación junta las de todos.
  // Los jugadores se identifican como «a-<id de cuenta>». Quien venía de la liga con Gist puede enlazar su Gist antiguo,
  // y así las partidas que sus amigos apuntaron contra ese Gist siguen contando.
  if (p === '/api/liga' && m === 'PUT') {
    needSameApp(req); const u = await needUser(req, env), b = await readJson(req);
    const file = b.file && typeof b.file === 'object' ? b.file : null; if (!file) throw new HttpError(400, 'Falta la hoja de liga.', 'bad_liga');
    const data = JSON.stringify(file); if (data.length > MAX_VALUE) throw new HttpError(413, 'La hoja de liga es demasiado grande.', 'too_big');
    const old = await env.DB.prepare('SELECT gist FROM liga WHERE user_id = ?').bind(u.id).first();
    let gist = old ? old.gist : null;
    const want = String(b.gist || '').toLowerCase();
    if (want && want !== gist) {   // enlazar un Gist antiguo: hay que demostrar que es tuyo (su hoja debe decir esta cuenta)
      if (!/^[0-9a-f]{20,40}$/.test(want)) throw new HttpError(400, 'Código de Gist no válido.', 'bad_gist');
      const taken = await env.DB.prepare('SELECT user_id FROM liga WHERE gist = ? AND user_id != ?').bind(want, u.id).first();
      if (taken) throw new HttpError(409, 'Ese Gist ya está enlazado a otra cuenta.', 'gist_taken');
      if (!(await gistClaims(want, 'a-' + u.id))) throw new HttpError(403, 'No se ha podido comprobar que ese Gist es tuyo.', 'gist_unverified');
      gist = want;
    }
    await env.DB.prepare('INSERT INTO liga (user_id, gist, data, updated) VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET gist = excluded.gist, data = excluded.data, updated = excluded.updated')
      .bind(u.id, gist, data, now()).run();
    return json({ ok: true, id: 'a-' + u.id, gist: gist || '' });
  }
  if (p === '/api/liga' && m === 'GET') {
    await needUser(req, env);
    const ids = [...new Set((url.searchParams.get('ids') || '').split(',').map(x => x.trim()).filter(Boolean))].slice(0, 60);
    const players = {};
    for (const id of ids) {
      let row = null;
      if (/^a-[A-Za-z0-9_-]{6,40}$/.test(id)) row = await env.DB.prepare('SELECT l.user_id, l.gist, l.data, l.updated, u.nick, u.name FROM liga l JOIN users u ON u.id = l.user_id WHERE l.user_id = ?').bind(id.slice(2)).first();
      else if (/^[0-9a-f]{20,40}$/i.test(id)) row = await env.DB.prepare('SELECT l.user_id, l.gist, l.data, l.updated, u.nick, u.name FROM liga l JOIN users u ON u.id = l.user_id WHERE l.gist = ?').bind(id.toLowerCase()).first();
      if (!row) continue;
      let file = null; try { file = JSON.parse(row.data); } catch (e) {}
      players[id] = { id: 'a-' + row.user_id, nick: row.nick || '', gist: row.gist || '', updated: row.updated, file };
    }
    return json({ players });
  }
  if (p === '/api/users' && m === 'GET') {   // buscar a un amigo por su nombre de jugador
    await needUser(req, env);
    const nick = String(url.searchParams.get('nick') || '').trim().toLowerCase();
    if (nick.length < 2) throw new HttpError(400, 'Escribe el nombre de jugador.', 'bad_nick');
    const u2 = await env.DB.prepare('SELECT id, nick FROM users WHERE nick_lc = ?').bind(nick).first();
    if (!u2) throw new HttpError(404, 'No hay nadie con ese nombre de jugador.', 'no_user');
    return json({ id: 'a-' + u2.id, nick: u2.nick });
  }

  throw new HttpError(404, 'No existe: ' + p, 'not_found');
}

// Comprueba en GitHub que la hoja de liga de ese Gist dice pertenecer a esta cuenta (solo su dueño puede escribir en él)
async function gistClaims(gistId, acctId) {
  try {
    const r = await fetch('https://api.github.com/gists/' + gistId, { headers: { 'User-Agent': 'fly-high-vobaca', Accept: 'application/vnd.github+json' } });
    if (!r.ok) return false;
    const g = await r.json(), f = g.files && g.files['vobaca-liga.json']; if (!f) return false;
    let txt = f.content; if (f.truncated && f.raw_url) txt = await (await fetch(f.raw_url, { headers: { 'User-Agent': 'fly-high-vobaca' } })).text();
    const j = JSON.parse(txt); return j && j.acct === acctId;
  } catch (e) { return false; }
}

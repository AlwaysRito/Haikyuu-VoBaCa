// Fly High VoBaCa · servidor (Cloudflare Worker)
// - Sirve la web (los archivos del repositorio) tal cual.
// - /api/…: cuentas con «Entrar con Google», sesiones y sincronización de los datos de cada jugador en D1.
// Pensado para crecer: la tabla de usuarios (con nombre de jugador único) es la base de la liga y del simulador online.
//
// Secretos necesarios (Cloudflare → el Worker → Settings → Variables and Secrets):
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
// Base de datos: D1 enlazada como DB (ver wrangler.jsonc). Las tablas se crean solas la primera vez.

import { newGame, act, view, SimError } from './sim.js';

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
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS liga (user_id TEXT PRIMARY KEY, gist TEXT UNIQUE, data TEXT NOT NULL, updated INTEGER)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS rooms (code TEXT PRIMARY KEY, host TEXT NOT NULL, guest TEXT, invitee TEXT, created INTEGER, updated INTEGER)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS rooms_inv ON rooms(invitee)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS friends (a TEXT NOT NULL, b TEXT NOT NULL, ok INTEGER NOT NULL DEFAULT 0, created INTEGER, PRIMARY KEY (a, b))`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS friends_b ON friends(b)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS leagues (id TEXT PRIMARY KEY, name TEXT NOT NULL, owner TEXT NOT NULL, created INTEGER)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS league_members (league_id TEXT NOT NULL, user_id TEXT NOT NULL, ok INTEGER NOT NULL DEFAULT 0, invited_by TEXT, joined INTEGER, PRIMARY KEY (league_id, user_id))`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS lm_user ON league_members(user_id)`)
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
      env.DB.prepare('DELETE FROM friends WHERE a = ? OR b = ?').bind(u.id, u.id),
      env.DB.prepare('DELETE FROM league_members WHERE user_id = ?').bind(u.id),
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

  // ---- Amigos (con solicitud: uno la manda y el otro la acepta) ----
  if (p === '/api/friends' && m === 'GET') {
    const u = await needUser(req, env);
    const r = await env.DB.prepare(`SELECT f.a, f.b, f.ok, f.created, ua.nick AS na, ub.nick AS nb FROM friends f JOIN users ua ON ua.id = f.a JOIN users ub ON ub.id = f.b WHERE f.a = ? OR f.b = ?`).bind(u.id, u.id).all();
    const out = { friends: [], incoming: [], outgoing: [] };
    (r.results || []).forEach(x => {
      const other = x.a === u.id ? { id: 'a-' + x.b, nick: x.nb || '' } : { id: 'a-' + x.a, nick: x.na || '' };
      other.since = x.created;
      if (x.ok) out.friends.push(other); else if (x.b === u.id) out.incoming.push(other); else out.outgoing.push(other);
    });
    out.friends.sort((p1, p2) => p1.nick.localeCompare(p2.nick));
    return json(out);
  }
  if (p === '/api/friends' && m === 'POST') {   // { nick } o { id }: manda una solicitud (o acepta la que ya te mandó)
    needSameApp(req); const u = await needUser(req, env), b = await readJson(req);
    let t = null;
    if (b.id) t = await env.DB.prepare('SELECT id, nick FROM users WHERE id = ?').bind(String(b.id).replace(/^a-/, '')).first();
    else if (b.nick) t = await env.DB.prepare('SELECT id, nick FROM users WHERE nick_lc = ?').bind(String(b.nick).trim().toLowerCase()).first();
    if (!t) throw new HttpError(404, 'No hay nadie con ese nombre de jugador.', 'no_user');
    if (t.id === u.id) throw new HttpError(400, 'Ese eres tú.', 'self');
    const rev = await env.DB.prepare('SELECT ok FROM friends WHERE a = ? AND b = ?').bind(t.id, u.id).first();
    if (rev) { await env.DB.prepare('UPDATE friends SET ok = 1 WHERE a = ? AND b = ?').bind(t.id, u.id).run(); return json({ ok: true, status: 'friends', id: 'a-' + t.id, nick: t.nick }); }
    const mine = await env.DB.prepare('SELECT ok FROM friends WHERE a = ? AND b = ?').bind(u.id, t.id).first();
    if (!mine) await env.DB.prepare('INSERT INTO friends (a, b, ok, created) VALUES (?, ?, 0, ?)').bind(u.id, t.id, now()).run();
    return json({ ok: true, status: mine && mine.ok ? 'friends' : 'sent', id: 'a-' + t.id, nick: t.nick });
  }
  const fa = p.match(/^\/api\/friends\/(accept|remove)$/);
  if (fa && m === 'POST') {   // aceptar una solicitud, o quitar amigo / rechazar / cancelar
    needSameApp(req); const u = await needUser(req, env), b = await readJson(req);
    const o = String(b.id || '').replace(/^a-/, ''); if (!o) throw new HttpError(400, 'Falta el amigo.', 'bad_id');
    if (fa[1] === 'accept') {
      const r = await env.DB.prepare('UPDATE friends SET ok = 1 WHERE a = ? AND b = ?').bind(o, u.id).run();
      if (!r.meta || !r.meta.changes) throw new HttpError(404, 'Esa solicitud ya no existe.', 'no_request');
    } else await env.DB.prepare('DELETE FROM friends WHERE (a = ? AND b = ?) OR (a = ? AND b = ?)').bind(u.id, o, o, u.id).run();
    return json({ ok: true });
  }

  // ---- Ligas compartidas: todos los miembros ven la misma clasificación ----
  // La clasificación se hace con las hojas de liga de los miembros, contando solo las partidas entre miembros.
  if (p === '/api/leagues' && m === 'GET') {
    const u = await needUser(req, env);
    const r = await env.DB.prepare(`SELECT l.id, l.name, l.owner, l.created, lm.ok, lm.invited_by, ib.nick AS inick FROM league_members lm JOIN leagues l ON l.id = lm.league_id LEFT JOIN users ib ON ib.id = lm.invited_by WHERE lm.user_id = ? ORDER BY l.created`).bind(u.id).all();
    const leagues = [];
    for (const x of (r.results || [])) {
      const mem = await env.DB.prepare(`SELECT lm.user_id, lm.ok, us.nick FROM league_members lm JOIN users us ON us.id = lm.user_id WHERE lm.league_id = ?`).bind(x.id).all();
      leagues.push({ id: x.id, name: x.name, owner: 'a-' + x.owner, mine: x.owner === u.id, joined: !!x.ok, invitedBy: x.inick || '', members: (mem.results || []).filter(y => y.ok).map(y => ({ id: 'a-' + y.user_id, nick: y.nick || '' })), invited: (mem.results || []).filter(y => !y.ok).map(y => ({ id: 'a-' + y.user_id, nick: y.nick || '' })) });
    }
    return json({ leagues });
  }
  if (p === '/api/leagues' && m === 'POST') {
    needSameApp(req); const u = await needUser(req, env), b = await readJson(req);
    const name = String(b.name || '').trim().slice(0, 40) || 'Liga';
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM league_members WHERE user_id = ? AND ok = 1').bind(u.id).first();
    if (n && n.n >= 20) throw new HttpError(400, 'Ya estás en 20 ligas.', 'too_many');
    const id = randomToken(9).replace(/[-_]/g, 'x');
    await env.DB.batch([
      env.DB.prepare('INSERT INTO leagues (id, name, owner, created) VALUES (?, ?, ?, ?)').bind(id, name, u.id, now()),
      env.DB.prepare('INSERT INTO league_members (league_id, user_id, ok, joined) VALUES (?, ?, 1, ?)').bind(id, u.id, now())
    ]);
    return json({ ok: true, id, name });
  }
  const lg = p.match(/^\/api\/leagues\/([A-Za-z0-9]{6,20})(?:\/(invite|join|leave|table))?$/);
  if (lg) {
    const u = await needUser(req, env), id = lg[1], what = lg[2] || '';
    const L = await env.DB.prepare('SELECT id, name, owner FROM leagues WHERE id = ?').bind(id).first();
    if (!L) throw new HttpError(404, 'Esa liga no existe.', 'no_league');
    const meRow = await env.DB.prepare('SELECT ok FROM league_members WHERE league_id = ? AND user_id = ?').bind(id, u.id).first();
    const member = !!(meRow && meRow.ok);
    if (what === 'table' && m === 'GET') {
      if (!member) throw new HttpError(403, 'No estás en esa liga.', 'not_member');
      const r = await env.DB.prepare(`SELECT lm.user_id, us.nick, lg2.gist, lg2.data, lg2.updated FROM league_members lm JOIN users us ON us.id = lm.user_id LEFT JOIN liga lg2 ON lg2.user_id = lm.user_id WHERE lm.league_id = ? AND lm.ok = 1`).bind(id).all();
      const players = (r.results || []).map(x => { let file = null; try { file = x.data ? JSON.parse(x.data) : null; } catch (e) {} return { id: 'a-' + x.user_id, nick: x.nick || '', gist: x.gist || '', updated: x.updated || 0, games: file && Array.isArray(file.games) ? file.games : [] }; });
      return json({ id: L.id, name: L.name, owner: 'a-' + L.owner, players });
    }
    if (what === 'invite' && m === 'POST') {
      needSameApp(req); if (!member) throw new HttpError(403, 'No estás en esa liga.', 'not_member');
      const b = await readJson(req);
      const t = b.id ? await env.DB.prepare('SELECT id, nick FROM users WHERE id = ?').bind(String(b.id).replace(/^a-/, '')).first()
        : await env.DB.prepare('SELECT id, nick FROM users WHERE nick_lc = ?').bind(String(b.nick || '').trim().toLowerCase()).first();
      if (!t) throw new HttpError(404, 'No hay nadie con ese nombre de jugador.', 'no_user');
      await env.DB.prepare('INSERT OR IGNORE INTO league_members (league_id, user_id, ok, invited_by, joined) VALUES (?, ?, 0, ?, ?)').bind(id, t.id, u.id, now()).run();
      return json({ ok: true, nick: t.nick });
    }
    if (what === 'join' && m === 'POST') {   // aceptar la invitación, o entrar con el código de la liga
      needSameApp(req);
      await env.DB.prepare('INSERT INTO league_members (league_id, user_id, ok, joined) VALUES (?, ?, 1, ?) ON CONFLICT(league_id, user_id) DO UPDATE SET ok = 1, joined = excluded.joined').bind(id, u.id, now()).run();
      return json({ ok: true, id, name: L.name });
    }
    if (what === 'leave' && m === 'POST') {   // salir, o rechazar la invitación
      needSameApp(req);
      await env.DB.prepare('DELETE FROM league_members WHERE league_id = ? AND user_id = ?').bind(id, u.id).run();
      const left = await env.DB.prepare('SELECT user_id FROM league_members WHERE league_id = ? AND ok = 1 ORDER BY joined LIMIT 1').bind(id).first();
      if (!left) await env.DB.batch([env.DB.prepare('DELETE FROM league_members WHERE league_id = ?').bind(id), env.DB.prepare('DELETE FROM leagues WHERE id = ?').bind(id)]);
      else if (L.owner === u.id) await env.DB.prepare('UPDATE leagues SET owner = ? WHERE id = ?').bind(left.user_id, id).run();
      return json({ ok: true });
    }
    if (!what && m === 'PATCH') {   // cambiar el nombre (cualquier miembro)
      needSameApp(req); if (!member) throw new HttpError(403, 'No estás en esa liga.', 'not_member');
      const b = await readJson(req); const name = String(b.name || '').trim().slice(0, 40);
      if (!name) throw new HttpError(400, 'Escribe un nombre.', 'bad_name');
      await env.DB.prepare('UPDATE leagues SET name = ? WHERE id = ?').bind(name, id).run();
      return json({ ok: true, name });
    }
  }

  // ---- Simulador: salas para jugar online ----
  if (p === '/api/rooms' && m === 'POST') {
    needSameApp(req); const u = await needUser(req, env), b = await readJson(req);
    if (!env.ROOMS) throw new HttpError(503, 'Falta activar las salas (Durable Objects) en el servidor.', 'no_rooms');
    if (!u.nick) throw new HttpError(400, 'Antes de jugar online, ponte un nombre de jugador (en tu cuenta).', 'need_nick');
    let invitee = null;
    if (b.invite) {
      const id = String(b.invite).replace(/^a-/, '');
      const iu = await env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(id).first();
      if (!iu) throw new HttpError(404, 'Ese amigo no tiene cuenta.', 'no_user');
      invitee = iu.id;
    }
    const ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let tries = 0; tries < 5; tries++) {
      code = Array.from(crypto.getRandomValues(new Uint8Array(6)), x => ABC[x % ABC.length]).join('');
      if (!(await env.DB.prepare('SELECT code FROM rooms WHERE code = ?').bind(code).first())) break;
    }
    const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
    const r = await stub.fetch('https://room/init', { method: 'POST', body: JSON.stringify({ code, host: { uid: u.id, nick: u.nick }, invitee }) });
    if (!r.ok) throw new HttpError(500, 'No se ha podido crear la sala.', 'room_fail');
    await env.DB.prepare('INSERT INTO rooms (code, host, invitee, created, updated) VALUES (?, ?, ?, ?, ?)').bind(code, u.id, invitee, now(), now()).run();
    return json({ code });
  }
  if (p === '/api/rooms' && m === 'GET') {   // tus salas recientes e invitaciones
    const u = await needUser(req, env);
    const r = await env.DB.prepare(`SELECT r.code, r.host, r.guest, r.invitee, r.created, h.nick AS hnick, g.nick AS gnick
      FROM rooms r JOIN users h ON h.id = r.host LEFT JOIN users g ON g.id = r.guest
      WHERE (r.host = ? OR r.guest = ? OR r.invitee = ?) AND r.created > ? ORDER BY r.created DESC LIMIT 20`).bind(u.id, u.id, u.id, now() - 2 * 864e5).all();
    return json({ rooms: (r.results || []).map(x => ({ code: x.code, host: x.hnick || '', guest: x.gnick || '', mine: x.host === u.id, invited: x.invitee === u.id && !x.guest, created: x.created })) });
  }
  const rd = p.match(/^\/api\/rooms\/([A-Z0-9]{6})$/);
  if (rd && m === 'DELETE') {   // cerrar una sala (quien la creó o el rival)
    needSameApp(req); const u = await needUser(req, env);
    const row = await env.DB.prepare('SELECT code, host, guest, invitee FROM rooms WHERE code = ?').bind(rd[1]).first();
    if (!row) return json({ ok: true });
    if (row.host !== u.id && row.guest !== u.id && row.invitee !== u.id) throw new HttpError(403, 'Esa sala no es tuya.', 'not_yours');
    if (row.host === u.id || row.guest === u.id) {
      try { await env.ROOMS.get(env.ROOMS.idFromName(row.code)).fetch('https://room/close', { method: 'POST', body: JSON.stringify({ nick: u.nick || u.name || '' }) }); } catch (e) {}
      await env.DB.prepare('DELETE FROM rooms WHERE code = ?').bind(row.code).run();
    } else await env.DB.prepare('UPDATE rooms SET invitee = NULL WHERE code = ?').bind(row.code).run();   // rechazar un reto
    return json({ ok: true });
  }
  const rm = p.match(/^\/api\/rooms\/([A-Z0-9]{6})\/ws$/);
  if (rm && m === 'GET') {
    const u = await needUser(req, env);
    if ((req.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') throw new HttpError(426, 'Hace falta WebSocket.', 'ws');
    const row = await env.DB.prepare('SELECT code, host, guest, invitee FROM rooms WHERE code = ?').bind(rm[1]).first();
    if (!row) throw new HttpError(404, 'Esa sala no existe.', 'no_room');
    if (row.host !== u.id && row.guest !== u.id) {
      if (row.guest) throw new HttpError(403, 'Esa sala ya está completa.', 'room_full');
      if (row.invitee && row.invitee !== u.id) throw new HttpError(403, 'Esa sala es para otro jugador.', 'room_private');
      await env.DB.prepare('UPDATE rooms SET guest = ?, updated = ? WHERE code = ? AND guest IS NULL').bind(u.id, now(), row.code).run();
    }
    const stub = env.ROOMS.get(env.ROOMS.idFromName(row.code));
    const fwd = new Request('https://room/ws', req);
    fwd.headers.set('X-Uid', u.id); fwd.headers.set('X-Nick', encodeURIComponent(u.nick || u.name || 'Jugador'));
    return stub.fetch(fwd);
  }

  throw new HttpError(404, 'No existe: ' + p, 'not_found');
}

// ---- Una sala de juego (Durable Object): guarda la partida y la reparte a los dos jugadores por WebSocket ----
export class Room {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; this.G = null; }
  async load() { if (!this.G) this.G = (await this.ctx.storage.get('G')) || null; return this.G; }
  async save() { await this.ctx.storage.put('G', this.G); }
  send(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch (e) {} }
  broadcast() {
    for (const ws of this.ctx.getWebSockets()) { const at = ws.deserializeAttachment() || {}; this.send(ws, { code: this.G.code, view: view(this.G, at.seat) }); }
  }
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/init') {
      const b = await req.json(); const G = newGame();
      G.code = b.code; G.invitee = b.invitee || null; G.seats[0] = { uid: b.host.uid, nick: b.host.nick, on: false };
      this.G = G; await this.save(); return new Response('ok');
    }
    if (url.pathname === '/close') {
      const G = await this.load(); if (!G) return new Response('ok');
      const b = await req.json().catch(() => ({}));
      G.closed = true; await this.save();
      for (const ws of this.ctx.getWebSockets()) { this.send(ws, { closed: true, by: b.nick || '' }); try { ws.close(1000, 'closed'); } catch (e) {} }
      return new Response('ok');
    }
    if (url.pathname === '/ws') {
      const G = await this.load(); if (!G || G.closed) return new Response('no room', { status: 404 });
      const uid = req.headers.get('X-Uid'), nick = decodeURIComponent(req.headers.get('X-Nick') || 'Jugador');
      let seat = G.seats.findIndex(x => x && x.uid === uid);
      if (seat < 0) {
        if (G.seats[1] || (G.invitee && G.invitee !== uid)) return new Response('full', { status: 403 });
        G.seats[1] = { uid, nick, on: false }; seat = 1; G.v++;
        G.log.push({ t: Date.now(), s: 1, k: 'join', a: {} });
      }
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      pair[1].serializeAttachment({ seat, uid });
      G.seats[seat].on = true; G.seats[seat].nick = nick;
      await this.save(); this.broadcast();
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    return new Response('not found', { status: 404 });
  }
  async webSocketMessage(ws, msg) {
    const at = ws.deserializeAttachment() || {}; const G = await this.load(); if (!G) return;
    let a; try { a = JSON.parse(typeof msg === 'string' ? msg : new TextDecoder().decode(msg)); } catch (e) { return; }
    if (a.type === 'ping') { this.send(ws, { pong: Date.now() }); return; }
    if (a.type === 'hello') { this.send(ws, { code: G.code, view: view(G, at.seat) }); return; }
    try {
      if (act(G, at.seat, a)) { await this.save(); this.broadcast(); }
    } catch (e) {
      this.send(ws, { err: e instanceof SimError ? e.message : 'Error: ' + (e && e.message || e), id: a.id || null });
      if (!(e instanceof SimError)) console.error(e);
    }
  }
  async webSocketClose(ws) { await this.gone(ws); }
  async webSocketError(ws) { await this.gone(ws); }
  async gone(ws) {
    const at = ws.deserializeAttachment() || {}; const G = await this.load(); if (!G || !G.seats[at.seat]) return;
    const still = this.ctx.getWebSockets().some(w => w !== ws && (w.deserializeAttachment() || {}).seat === at.seat);
    if (!still) { G.seats[at.seat].on = false; G.v++; await this.save(); this.broadcast(); }
  }
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

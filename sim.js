// Fly High VoBaCa · motor del simulador (reglas asistidas)
// Lo usa el servidor (cada sala online) y puede usarlo la propia web. El tablero guía las fases, coloca cada carta en su zona,
// suma la potencia del balón y la defensa y declara el «lost»; las habilidades y eventos se aplican a mano (±puntos, mover cartas…).
//
// Reglas (resumen del reglamento oficial): 40 cartas; mano inicial 6 con un cambio; después, 2 cartas de set boca abajo.
// Primer turno de cada set: saque. Después, cada turno es de bloqueo (bloqueo) o de recepción (robo, recepción, colocación, ataque).
// Contra un saque o un balón devuelto por un bloqueo solo se puede recibir; el balón bloqueado vuelve con 0 de ataque. Defensa ≥ ataque = éxito; si no, «lost».
// Al perder un set coges una carta de set; si no te quedan, pierdes la partida. En el descanso, los dos roban hasta tener 6.

export const ZONES = ['serve', 'block', 'receive', 'toss', 'attack'];
export const STAT = { serve: 0, block: 1, receive: 2, toss: 3, attack: 4 };
const HAND0 = 6, MAX_DECK = 60;

const rnd = n => { const a = new Uint32Array(1); crypto.getRandomValues(a); return a[0] % n; };
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = rnd(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; }
const top = z => z.length ? z[z.length - 1] : null;
const statOf = (c, k) => (c && Array.isArray(c.st) && typeof c.st[STAT[k]] === 'number') ? c.st[STAT[k]] : 0;
class SimError extends Error {}
const no = msg => { throw new SimError(msg); };

function newPlayer() {
  return { deck: [], hand: [], set: [], drop: [], ev: [], z: { serve: [], block: [], receive: [], toss: [], attack: [] }, side: [], mod: { serve: 0, block: 0, receive: 0, toss: 0, attack: 0 }, peek: 0, sets: 0, mull: false, list: null, deckName: '' };
}
export function newGame() {
  return { v: 0, phase: 'lobby', seats: [null, null], p: [newPlayer(), newPlayer()], turn: -1, server: -1, setNo: 0, step: '', ball: null, placed: [], winner: -1, log: [], uid: 0, again: [false, false] };
}
const log = (G, s, k, a = {}) => { G.log.push({ t: Date.now(), s, k, a }); if (G.log.length > 200) G.log.splice(0, G.log.length - 200); };
const nameOf = c => (c && (c.en || c.n)) || '?';
const sameName = (a, b) => !!(a && b && a.n && b.n && a.n === b.n);

// Puntos de una zona: el personaje de arriba + modificadores; el bloqueo suma también los laterales
export function zonePts(P, k) {
  if (k === 'block') return statOf(top(P.z.block), 'block') + P.side.reduce((t, c) => t + statOf(c, 'block'), 0) + P.mod.block;
  return statOf(top(P.z[k]), k) + P.mod[k];
}
const spikePts = P => zonePts(P, 'toss') + zonePts(P, 'attack');

function cleanCard(G, c) {
  const st = Array.isArray(c.st) ? c.st.slice(0, 5).map(v => (typeof v === 'number' && isFinite(v)) ? Math.max(-99, Math.min(99, Math.round(v))) : null) : [null, null, null, null, null];
  return { u: 'c' + (++G.uid), id: String(c.id || '').slice(0, 40), no: String(c.no || '').slice(0, 30), n: String(c.n || '').slice(0, 60), en: String(c.en || '').slice(0, 60), st, ev: !!c.ev, img: /^https:\/\//.test(c.img || '') ? String(c.img).slice(0, 300) : '', tr: typeof c.tr === 'string' ? c.tr.slice(0, 1500) : '' };
}
function draw(G, s, n) { const P = G.p[s]; let k = 0; while (k < n && P.deck.length) { P.hand.push(P.deck.shift()); k++; } P.peek = 0; return k; }

function setup(G) {
  G.p.forEach(P => {
    const keep = { list: P.list, deckName: P.deckName };
    Object.assign(P, newPlayer(), keep);
    P.deck = shuffle(P.list.map(c => cleanCard(G, c)));
    for (let i = 0; i < HAND0; i++) if (P.deck.length) P.hand.push(P.deck.shift());
  });
  G.phase = 'mull'; G.turn = -1; G.setNo = 0; G.step = ''; G.ball = null; G.placed = []; G.winner = -1; G.again = [false, false];
  G.server = rnd(2); G.coinT = Date.now();   // el sorteo del saque se hace antes del cambio de mano, para que los dos lo sepan
  log(G, -1, 'setup'); log(G, G.server, 'coin');
}
function startMatch(G) {
  G.phase = 'play'; G.setNo = 1;
  startSet(G, G.server);
}
function startSet(G, srv) {
  G.turn = srv; G.server = srv; G.step = 'serve'; G.ball = null; G.placed = [];
  G.p.forEach(P => { ZONES.forEach(k => { P.mod[k] = 0; }); });
  log(G, srv, 'set', { n: G.setNo });
}
function resetMods(G) { G.p.forEach(P => ZONES.forEach(k => { P.mod[k] = 0; })); }
function endTurn(G, s) {
  const P = G.p[s];
  if (P.side.length) { P.drop.push(...P.side); P.side = []; }
  resetMods(G); G.placed = [];
  const d = 1 - s; G.turn = d;
  if (G.ball && G.ball.kind === 'spike') G.step = 'choose';
  else startReceive(G, d);
}
function startReceive(G, s) {
  const k = draw(G, s, 1);
  G.step = 'receive'; G.placed = [];
  log(G, s, 'draw', { n: k });
}
function lost(G, s, why) {
  const w = 1 - s, L = G.p[s];
  log(G, s, 'lost', { why: why || '' });
  G.p[w].sets++;
  G.p.forEach(P => { if (P.side.length) { P.drop.push(...P.side); P.side = []; } });
  if (!L.set.length) { G.phase = 'over'; G.winner = w; G.step = ''; G.ball = null; log(G, w, 'win'); return; }
  L.hand.push(L.set.pop());
  G.p.forEach((P, i) => { const n = Math.max(0, HAND0 - P.hand.length); if (n) draw(G, i, n); });
  G.setNo++;
  startSet(G, w);
}

// Aplica una acción del jugador s. Devuelve true si el estado cambió.
export function act(G, s, a) {
  if (!a || typeof a.type !== 'string') no('Acción no válida.');
  if (s !== 0 && s !== 1) no('No estás sentado en esta mesa.');
  const P = G.p[s], O = G.p[1 - s], mine = G.turn === s;
  const findHand = u => { const i = P.hand.findIndex(c => c.u === u); if (i < 0) no('Esa carta no está en tu mano.'); return i; };
  switch (a.type) {
    case 'deck': {
      if (G.phase !== 'lobby' && G.phase !== 'over') no('La partida ya ha empezado.');
      const list = Array.isArray(a.cards) ? a.cards : [];
      if (list.length < 10 || list.length > MAX_DECK) no('El mazo debe tener entre 10 y 60 cartas.');
      P.list = list.slice(0, MAX_DECK).map(c => ({ id: c.id, no: c.no, n: c.n, en: c.en, st: c.st, ev: c.ev, img: c.img, tr: c.tr }));
      P.deckName = String(a.name || '').slice(0, 60);
      if (G.phase === 'over') G.phase = 'lobby';
      log(G, s, 'ready', { name: P.deckName, n: list.length });
      if (G.p[0].list && G.p[1].list && G.seats[0] && G.seats[1]) setup(G);
      break;
    }
    case 'again': {   // revancha con los mismos mazos
      if (G.phase !== 'over') no('La partida no ha terminado.');
      G.again[s] = true; log(G, s, 'again');
      if (G.again[0] && G.again[1]) setup(G);
      break;
    }
    case 'mull': {
      if (G.phase !== 'mull') no('Ahora no se puede cambiar la mano.');
      if (P.mull) no('Ya has decidido tu mano.');
      const us = Array.isArray(a.us) ? [...new Set(a.us)] : [];
      const back = us.map(u => P.hand.splice(findHand(u), 1)[0]);
      if (back.length) { P.deck.push(...back); shuffle(P.deck); draw(G, s, back.length); }
      P.mull = true; log(G, s, 'mull', { n: back.length });
      for (let i = 0; i < 2; i++) if (P.deck.length) P.set.push(P.deck.shift());   // las 2 cartas de set se ponen después de decidir la mano
      if (G.p[0].mull && G.p[1].mull) startMatch(G);
      break;
    }
    case 'choose': {
      if (G.phase !== 'play' || !mine || G.step !== 'choose') no('Ahora no toca elegir.');
      if (a.mode === 'block') { G.step = 'block'; G.placed = []; log(G, s, 'choose', { m: 'block' }); }
      else if (a.mode === 'receive') { log(G, s, 'choose', { m: 'receive' }); startReceive(G, s); }
      else no('Elige bloquear o recibir.');
      break;
    }
    case 'place': {
      if (G.phase !== 'play' || !mine) no('No es tu turno.');
      const zone = G.step;
      if (!ZONES.includes(zone)) no('Ahora no se coloca ningún personaje.');
      const i = findHand(a.u), c = P.hand[i];
      if (c.ev) no('Los eventos van a la zona de eventos.');
      if (zone === 'block') {
        if (G.placed.length >= 3) no('Como mucho 3 bloqueadores.');
        const inBlock = G.placed.map(u => [top(P.z.block), ...P.side].find(x => x && x.u === u)).filter(Boolean);
        if (inBlock.some(x => sameName(x, c))) no('No puede haber dos bloqueadores con el mismo nombre.');
        P.hand.splice(i, 1);
        const center = !G.placed.some(u => top(P.z.block) && top(P.z.block).u === u);
        if (center) P.z.block.push(c); else P.side.push(c);
      } else {
        if (G.placed.length) no('Ya has puesto un personaje en esta fase (quítalo para cambiarlo).');
        if (zone === 'toss' && sameName(top(P.z.receive), c)) no('El colocador no puede tener el mismo nombre que el receptor.');
        if (zone === 'attack' && sameName(top(P.z.toss), c)) no('El atacante no puede tener el mismo nombre que el colocador.');
        P.hand.splice(i, 1); P.z[zone].push(c);
      }
      G.placed.push(c.u);
      log(G, s, 'place', { z: zone, c: nameOf(c), side: zone === 'block' && P.side.includes(c) });
      break;
    }
    case 'unplace': {
      if (G.phase !== 'play' || !mine || !G.placed.includes(a.u)) no('Esa carta no se puede devolver.');
      let c = null;
      for (const k of ZONES) { const z = P.z[k]; if (top(z) && top(z).u === a.u) { c = z.pop(); break; } }
      if (!c) { const j = P.side.findIndex(x => x.u === a.u); if (j >= 0) c = P.side.splice(j, 1)[0]; }
      if (!c) no('Esa carta ya no está en la zona.');
      P.hand.push(c); G.placed = G.placed.filter(u => u !== a.u);
      // si se quita el bloqueador central, el primer lateral pasa a central
      if (G.step === 'block' && !G.placed.some(u => top(P.z.block) && top(P.z.block).u === u) && P.side.length && G.placed.length) P.z.block.push(P.side.shift());
      log(G, s, 'unplace', { c: nameOf(c) });
      break;
    }
    case 'confirm': {
      if (G.phase !== 'play' || !mine) no('No es tu turno.');
      const st = G.step;
      if (st === 'choose') no('Primero elige bloquear o recibir.');
      if (!G.placed.length) no('Primero pon un personaje (o declara «lost»).');
      if (st === 'serve') { const pw = zonePts(P, 'serve'); G.ball = { power: pw, kind: 'serve', from: s }; log(G, s, 'serve', { p: pw }); endTurn(G, s); }
      else if (st === 'block') {
        const t = zonePts(P, 'block'), need = G.ball ? G.ball.power : 0;
        if (t >= need) { G.ball = { power: 0, kind: 'block', from: s }; log(G, s, 'block', { p: t, vs: need, ok: true }); endTurn(G, s); }   // el balón devuelto por un bloqueo vuelve con 0
        else { log(G, s, 'block', { p: t, vs: need, ok: false }); lost(G, s, 'block'); }
      } else if (st === 'receive') {
        const t = zonePts(P, 'receive'), need = G.ball ? G.ball.power : 0;
        if (t >= need) { log(G, s, 'receive', { p: t, vs: need, ok: true }); G.step = 'toss'; G.placed = []; }
        else { log(G, s, 'receive', { p: t, vs: need, ok: false }); lost(G, s, 'receive'); }
      } else if (st === 'toss') { log(G, s, 'toss', { p: zonePts(P, 'toss') }); G.step = 'attack'; G.placed = []; }
      else if (st === 'attack') { const pw = spikePts(P); G.ball = { power: pw, kind: 'spike', from: s }; log(G, s, 'spike', { p: pw }); endTurn(G, s); }
      else no('Nada que confirmar.');
      break;
    }
    case 'event': {
      if (G.phase !== 'play') no('La partida no está en juego.');
      const i = findHand(a.u), c = P.hand[i];
      if (!c.ev) no('Solo se juegan aquí las cartas de evento.');
      P.hand.splice(i, 1); P.ev.push(c); log(G, s, 'event', { c: nameOf(c) });
      break;
    }
    case 'mod': {
      if (G.phase !== 'play') no('La partida no está en juego.');
      if (!ZONES.includes(a.zone)) no('Zona no válida.');
      const d = Math.max(-20, Math.min(20, Math.round(+a.d || 0))); if (!d) return false;
      P.mod[a.zone] += d; log(G, s, 'mod', { z: a.zone, d });
      break;
    }
    case 'ballmod': {
      if (G.phase !== 'play' || !G.ball) no('No hay balón en juego.');
      const d = Math.max(-20, Math.min(20, Math.round(+a.d || 0))); if (!d) return false;
      G.ball.power += d; log(G, s, 'ballmod', { d, p: G.ball.power });
      break;
    }
    case 'draw': {
      if (G.phase !== 'play') no('La partida no está en juego.');
      const n = Math.max(1, Math.min(10, Math.round(+a.n || 1))); const k = draw(G, s, n); log(G, s, 'mdraw', { n: k });
      break;
    }
    case 'shuffle': { if (G.phase !== 'play') no('La partida no está en juego.'); shuffle(P.deck); P.peek = 0; log(G, s, 'shuffle'); break; }
    case 'peek': { if (G.phase !== 'play') no('La partida no está en juego.'); P.peek = Math.max(0, Math.min(10, Math.round(+a.n || 0))); if (P.peek) log(G, s, 'peek', { n: P.peek }); break; }
    case 'guts': {   // pagar agallas: las de debajo del personaje van al drop
      if (G.phase !== 'play' || !ZONES.includes(a.zone)) no('Zona no válida.');
      const z = P.z[a.zone], n = Math.max(1, Math.min(z.length - 1, Math.round(+a.n || 1)));
      if (z.length < 2) no('Ese personaje no tiene agallas.');
      const paid = z.splice(0, n); P.drop.push(...paid); log(G, s, 'guts', { z: a.zone, n: paid.length });
      break;
    }
    case 'move': {   // mover a mano una carta propia (para habilidades y eventos)
      if (G.phase !== 'play') no('La partida no está en juego.');
      let c = null, from = '';
      const take = (arr, name) => { const j = arr.findIndex(x => x.u === a.u); if (j >= 0) { c = arr.splice(j, 1)[0]; from = name; } };
      take(P.hand, 'hand'); if (!c) take(P.drop, 'drop'); if (!c) take(P.ev, 'ev'); if (!c) take(P.side, 'side'); if (!c) take(P.set, 'set');
      if (!c) for (const k of ZONES) { take(P.z[k], k); if (c) break; }
      if (!c && P.peek) { const j = P.deck.slice(0, P.peek).findIndex(x => x.u === a.u); if (j >= 0) { c = P.deck.splice(j, 1)[0]; from = 'deck'; P.peek--; } }
      if (!c) no('No encuentro esa carta.');
      const to = String(a.to || '');
      if (to === 'hand') P.hand.push(c);
      else if (to === 'drop') P.drop.push(c);
      else if (to === 'ev') P.ev.push(c);
      else if (to === 'deckTop') P.deck.unshift(c);
      else if (to === 'deckBottom') P.deck.push(c);
      else if (to === 'set') P.set.push(c);
      else if (to.startsWith('guts:') && ZONES.includes(to.slice(5))) P.z[to.slice(5)].unshift(c);
      else if (to.startsWith('top:') && ZONES.includes(to.slice(4))) P.z[to.slice(4)].push(c);
      else { P.hand.push(c); no('Destino no válido.'); }
      G.placed = G.placed.filter(u => u !== c.u);
      const pub = !['hand', 'deck', 'set'].includes(from) || !['hand', 'deckTop', 'deckBottom', 'set'].includes(to);
      log(G, s, 'move', { c: pub ? nameOf(c) : '', from, to });
      break;
    }
    case 'lost': {
      if (G.phase !== 'play' || !mine) no('Solo puedes declarar «lost» en tu turno.');
      lost(G, s, 'manual');
      break;
    }
    case 'concede': {
      if (G.phase !== 'play' && G.phase !== 'mull') no('No hay partida que abandonar.');
      G.phase = 'over'; G.winner = 1 - s; G.step = ''; log(G, s, 'concede');
      break;
    }
    case 'chat': {
      const m = String(a.m || '').replace(/\s+/g, ' ').trim().slice(0, 200); if (!m) return false;
      log(G, s, 'chat', { m });
      break;
    }
    default: no('Acción desconocida: ' + a.type);
  }
  G.v++;
  return true;
}

// Lo que ve cada jugador: su mano completa; del rival, solo cuántas cartas tiene en la mano, el mazo y el set
export function view(G, s) {
  const pub = (P, i) => ({ nick: G.seats[i] ? G.seats[i].nick : '', on: !!(G.seats[i] && G.seats[i].on), ready: !!P.list, deckName: P.deckName, handN: P.hand.length, deckN: P.deck.length, setN: P.set.length, drop: P.drop, ev: P.ev, z: P.z, side: P.side, mod: P.mod, sets: P.sets, mull: P.mull, again: G.again[i],
    pts: { serve: zonePts(P, 'serve'), block: zonePts(P, 'block'), receive: zonePts(P, 'receive'), toss: zonePts(P, 'toss'), attack: zonePts(P, 'attack'), spike: spikePts(P) } });
  const me = s === 0 || s === 1 ? s : -1;
  const players = G.p.map((P, i) => i === me ? { ...pub(P, i), hand: P.hand, peek: P.deck.slice(0, P.peek) } : pub(P, i));
  return { v: G.v, phase: G.phase, step: G.step, turn: G.turn, server: G.server, coinT: G.coinT || 0, setNo: G.setNo, ball: G.ball, winner: G.winner, you: me, placed: me === G.turn ? G.placed : [], players, log: G.log.slice(-80) };
}
export { SimError };

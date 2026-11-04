/* Vobaca Proxies · script para la web oficial de Takara Tomy
   Lo carga el marcador «Vobaca». Funciona en tres modos:
   1. Sin nada más: lee el mazo oficial abierto (o pide un código) y lo manda a Vobaca Proxies.
   2. #vobaca=… con a:'img': dibuja la imagen del mazo con las cartas reales.
   3. #vobaca=… con a:'build': rellena el constructor oficial con el mazo para guardarlo y obtener un código oficial.
   4. #vobaca=… con a:'cards': busca cartas que la herramienta aún no tiene y se las manda.
   5. #vobaca=… con a:'decks': descarga los mazos públicos y se los manda a la herramienta. */
(function () {
  var ME = document.currentScript && document.currentScript.src;
  var HOME = ME ? new URL('./', ME).href : '';
  var BASE = 'https://www.takaratomy.co.jp/products/haikyuvobacabreak/';
  var ORANGE = '#e8631c';
  var BTN = 'padding:10px 16px;border-radius:8px;font-weight:700;text-decoration:none;font-size:15px;cursor:pointer;';
  var B1 = BTN + 'border:0;background:' + ORANGE + ';color:#fff';
  var B2 = BTN + 'border:1px solid #ccc;background:#fff;color:#111';
  var esc = function (s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var b64u = function (str) { var b = new TextEncoder().encode(str), bin = ''; b.forEach(function (x) { bin += String.fromCharCode(x); }); return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
  var unb64u = function (s) { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; var bin = atob(s); return new TextDecoder().decode(Uint8Array.from(bin, function (ch) { return ch.charCodeAt(0); })); };

  // Comprime (si el navegador puede) para que el enlace de vuelta a la herramienta sea corto
  function pack(obj) {
    var str = JSON.stringify(obj);
    var toB64 = function (u8) { var bin = ''; for (var i = 0; i < u8.length; i += 8192) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 8192)); return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
    if (!window.CompressionStream) return Promise.resolve('j' + b64u(str));
    var cs = new Blob([str]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    return new Response(cs).arrayBuffer().then(function (buf) { return 'z' + toB64(new Uint8Array(buf)); });
  }
  function sendBack(param, data, title, lines) {
    return pack(data).then(function (z) {
      var url = HOME + '#' + param + '=' + z;
      box('<b>' + esc(title) + '</b>' + lines.map(function (l) { return '<span>' + l + '</span>'; }).join('') +
        (HOME ? '<div style="display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap">' + closeBtn + '<a style="' + B1 + '" href="' + esc(url) + '">Abrir en Vobaca Proxies</a></div>'
          : '<span style="color:#b00">Este marcador no sabe dónde está tu herramienta. Instala el marcador desde tu web de Vobaca Proxies.</span><div style="display:flex;justify-content:flex-end">' + closeBtn + '</div>'));
    });
  }
  // Idioma: el que manda la herramienta (payload.ui); si no, el del navegador
  var EN = false;
  var T_EN = [["Este marcador no sabe dónde está tu herramienta. Instala el marcador desde tu web de Vobaca Proxies.", "This bookmarklet doesn't know where your tool is. Install the bookmarklet from your Vobaca Proxies site."], ["Usa el marcador en la web oficial de Vobaca (takaratomy.co.jp).", "Use the bookmarklet on the official Vobaca site (takaratomy.co.jp)."], ["Preparando la imagen del mazo…", "Preparing the deck image…"], ["Imagen del mazo", "Deck image"], [" imágenes no se han podido cargar.", " images could not be loaded."], ["Mantén pulsada la imagen para guardarla, o usa los botones.", "Long-press the image to save it, or use the buttons."], [">Compartir<", ">Share<"], [">Descargar<", ">Download<"], [">Cerrar<", ">Close<"], [">Copiar<", ">Copy<"], [">Entendido<", ">Got it<"], ["Cargando el mazo en el constructor oficial…", "Loading the deck into the official builder…"], ["Tarda unos segundos.", "It takes a few seconds."], ["Mazo cargado en el constructor oficial", "Deck loaded into the official builder"], [" cartas · ", " cards · "], [" eventos", " events"], ["no encontradas: ", "not found: "], ["Revisa el mazo y pulsa el botón de guardar de la web (", "Check the deck and press the site's save button ("], ["). Te dará el ", "). It will give you the "], ["código oficial</b> del mazo.", "official code</b> of the deck."], ["La web oficial solo deja guardar mazos de <b>40 cartas</b> con <b>8 eventos como máximo</b>. Ajusta el mazo aquí mismo o en Vobaca Proxies antes de guardar.", "The official site only saves decks of <b>40 cards</b> with <b>at most 8 events</b>. Adjust the deck here or in Vobaca Proxies before saving."], ["Opcional: en «デッキ情報を追加» puedes poner autor y etiquetas. Marca «デッキ検索に掲載する» solo si quieres que salga en la búsqueda pública.", "Optional: in «デッキ情報を追加» you can add an author and tags. Tick «デッキ検索に掲載する» only if you want it to appear in the public search."], ["No se ha podido cargar el mazo en el constructor: ", "Couldn't load the deck into the builder: "], ["no se encuentra el constructor", "the builder can't be found"], ["Buscando cartas nuevas en la web oficial…", "Looking for new cards on the official site…"], ["No hay cartas nuevas", "No new cards"], ["Tu herramienta ya tiene las ", "Your tool already has all "], [" cartas de la web oficial.", " cards from the official site."], ["Cartas nuevas encontradas", "New cards found"], [" japonesas y ", " Japanese and "], [" inglesas que tu herramienta aún no tiene.", " English cards your tool doesn't have yet."], ["Pulsa «Abrir en Vobaca Proxies» para añadirlas.", "Press «Open in Vobaca Proxies» to add them."], ["Descargando los mazos públicos…", "Downloading the public decks…"], [" mazos públicos descargados", " public decks downloaded"], ["Pulsa «Abrir en Vobaca Proxies» para verlos, filtrarlos e importarlos.", "Press «Open in Vobaca Proxies» to see, filter and import them."], ["Código de mazo oficial de Vobaca", "Official Vobaca deck code"], ["No existe ningún mazo con el código ", "There is no deck with the code "], ["Pulsa «Abrir en Vobaca Proxies» para cargarlo como mazo nuevo, o copia la lista.", "Press «Open in Vobaca Proxies» to load it as a new deck, or copy the list."], [">Abrir en Vobaca Proxies<", ">Open in Vobaca Proxies<"], ["¡Copiada!", "Copied!"], ["Selecciónala y cópiala", "Select it and copy it"], ["Este enlace no es de Vobaca Proxies.", "This link is not from Vobaca Proxies."], ["Error: ", "Error: "], [" cartas", " cards"]];
  var T = function (s2) { if (!EN) return s2; s2 = String(s2); T_EN.forEach(function (p) { s2 = s2.split(p[0]).join(p[1]); }); return s2; };
  function box(inner) {
    inner = T(inner);
    var old = document.getElementById('vbx'); if (old) old.remove();
    var d = document.createElement('div'); d.id = 'vbx';
    d.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;padding:16px;font:16px/1.4 system-ui,sans-serif';
    d.innerHTML = '<div style="background:#fff;color:#111;border-radius:12px;padding:16px;width:100%;max-width:560px;max-height:calc(100vh - 32px);overflow:auto;display:grid;gap:10px;box-sizing:border-box">' + inner + '</div>';
    document.body.appendChild(d);
    var z = d.querySelector('[data-close]'); if (z) z.onclick = function () { d.remove(); };
    return d;
  }
  var closeBtn = '<button data-close style="' + B2 + '">Cerrar</button>';
  function fail(msg) { box('<b>Vobaca Proxies</b><span>' + esc(msg) + '</span><div style="display:flex;justify-content:flex-end">' + closeBtn + '</div>'); }

  if (!/takaratomy\.co\.jp$/.test(location.hostname)) { alert(/^es/i.test(navigator.language || 'es') ? 'Usa el marcador en la web oficial de Vobaca (takaratomy.co.jp).' : 'Use the bookmarklet on the official Vobaca site (takaratomy.co.jp).'); return; }

  var payload = null;
  var hm = location.hash.match(/vobaca=([A-Za-z0-9_-]+)/);
  if (hm) { try { payload = JSON.parse(unb64u(hm[1])); } catch (e) { payload = null; } }
  EN = payload && payload.ui ? payload.ui === 'en' : !/^es/i.test(navigator.language || 'es');

  // ---------- Todas las cartas japonesas (para el constructor) ----------
  function allCards() {
    var url = BASE + 'cardlist/itemsearch.php?para=normal%2Cp%2Ca&p=';
    return fetch(url + 1).then(function (r) { return r.json(); }).then(function (first) {
      var pages = Math.ceil(first.count / Math.max(1, first.items.length)), reqs = [];
      for (var p = 2; p <= pages; p++) reqs.push(fetch(url + p).then(function (r) { return r.json(); }));
      return Promise.all(reqs).then(function (rest) {
        var all = first.items; rest.forEach(function (x) { all = all.concat(x.items || []); });
        return all;
      });
    });
  }

  // ---------- Modo 2: imagen del mazo ----------
  function drawImage(P) {
    var d = box('<b>Preparando la imagen del mazo…</b>');
    var url = function (id) { return BASE + (id.indexOf('-EN-') > 0 ? 'english/' : '') + 'cardlist/card/' + id + '.webp'; };
    var ids = [];
    P.secs.forEach(function (s) { s[3].forEach(function (r) { if (ids.indexOf(r[0]) < 0) ids.push(r[0]); }); });
    var imgs = {};
    return Promise.all(ids.map(function (id) {
      return new Promise(function (res) { var im = new Image(); im.onload = function () { imgs[id] = im; res(); }; im.onerror = function () { res(); }; im.src = url(id); });
    })).then(function () {
      var W = 1200, PAD = 40, COLS = 8, TW = (W - PAD * 2 - (COLS - 1) * 12) / COLS, TH = TW * 88 / 63, FN = 'system-ui,"Segoe UI",Roboto,sans-serif';
      var H = 200; P.secs.forEach(function (s) { H += 60 + Math.ceil(s[3].length / COLS) * (TH + 44); }); H += 50;
      var cv = document.createElement('canvas'); cv.width = W; cv.height = H;
      var g = cv.getContext('2d'); g.textBaseline = 'top';
      var rr = function (x, y, w, h, r) { g.beginPath(); if (g.roundRect) g.roundRect(x, y, w, h, r); else g.rect(x, y, w, h); };
      var fit = function (t, w) { var s = t; while (g.measureText(s + (s !== t ? '…' : '')).width > w && s.length > 2) s = s.slice(0, -1); return s + (s !== t ? '…' : ''); };
      g.fillStyle = '#f4f5f7'; g.fillRect(0, 0, W, H);
      g.fillStyle = '#1b2330'; g.fillRect(0, 0, W, 170); g.fillStyle = ORANGE; g.fillRect(0, 170, W, 6);
      g.fillStyle = '#fff'; g.font = '700 54px ' + FN; g.fillText(fit(P.name || 'Mazo', W - PAD * 2), PAD, 30);
      g.font = '500 26px ' + FN; g.fillStyle = '#c9d1dc'; g.fillText(P.st || '', PAD, 98);
      g.font = '500 22px ' + FN; g.fillStyle = '#9aa5b4'; g.fillText(P.rl || '', PAD, 134);
      var y = 200;
      P.secs.forEach(function (s) {
        var title = s[0], muted = s[1], sub = s[2], rows = s[3];
        g.fillStyle = muted ? '#5f6a7a' : '#1b2330'; g.font = '700 34px ' + FN; g.fillText(title.toUpperCase(), PAD, y);
        var tw = g.measureText(title.toUpperCase()).width;
        g.font = '500 22px ' + FN; g.fillStyle = '#5f6a7a'; g.fillText(sub, PAD + tw + 16, y + 9); y += 54;
        rows.forEach(function (r, i) {
          var X = PAD + (i % COLS) * (TW + 12), Y = y + Math.floor(i / COLS) * (TH + 44);
          g.save(); rr(X, Y, TW, TH, 8); g.clip();
          if (imgs[r[0]]) g.drawImage(imgs[r[0]], X, Y, TW, TH); else { g.fillStyle = '#d3d8e0'; g.fillRect(X, Y, TW, TH); }
          g.restore();
          g.font = '700 24px ' + FN; var bt = '×' + r[1], bw = Math.max(36, g.measureText(bt).width + 18);
          g.fillStyle = ORANGE; rr(X + TW - bw - 4, Y + 4, bw, 34, 17); g.fill();
          g.fillStyle = '#fff'; g.textAlign = 'center'; g.fillText(bt, X + TW - 4 - bw / 2, Y + 9); g.textAlign = 'left';
          g.fillStyle = '#1b2330'; g.font = '600 17px ' + FN; g.fillText(fit(r[2] || r[0], TW), X, Y + TH + 6);
          g.fillStyle = '#5f6a7a'; g.font = '500 15px ' + FN; g.fillText(fit(r[3] || '', TW), X, Y + TH + 26);
        });
        y += Math.ceil(rows.length / COLS) * (TH + 44) + 6;
      });
      g.fillStyle = '#9aa5b4'; g.font = '500 18px ' + FN; g.fillText('Vobaca Proxies · ' + new Date().toLocaleDateString('es-ES'), PAD, H - 34);
      var fname = (String(P.name || '').replace(/[\\/:*?"<>|]+/g, '').trim() || 'mazo') + '.png';
      return new Promise(function (res) { cv.toBlob(res, 'image/png'); }).then(function (blob) {
        var u = URL.createObjectURL(blob), miss = ids.length - Object.keys(imgs).length;
        d = box('<b>Imagen del mazo</b>' + (miss ? '<span style="color:#b9770e;font-size:14px">' + miss + ' imágenes no se han podido cargar.</span>' : '') +
          '<span style="font-size:13px;color:#555">Mantén pulsada la imagen para guardarla, o usa los botones.</span>' +
          '<img src="' + u + '" style="width:100%;border:1px solid #ccc;border-radius:8px">' +
          '<div style="display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap"><button id="vbs" style="' + B2 + '">Compartir</button><a id="vbd" style="' + B1 + '">Descargar</a>' + closeBtn + '</div>');
        var a = d.querySelector('#vbd'); a.href = u; a.download = fname;
        var file = new File([blob], fname, { type: 'image/png' }), sb = d.querySelector('#vbs');
        if (!(navigator.canShare && navigator.canShare({ files: [file] }))) sb.style.display = 'none';
        sb.onclick = function () { navigator.share({ files: [file], title: P.name || 'Mazo' }).catch(function () {}); };
      });
    });
  }

  // ---------- Modo 3: rellenar el constructor oficial ----------
  function findVm() {
    var el = document.getElementById('app');
    var c = el && el._vnode && el._vnode.component;
    return c && c.proxy && c.proxy.deck ? c.proxy : null;
  }
  function waitVm(ms) {
    var t0 = Date.now();
    return new Promise(function (res, rej) {
      (function poll() { var vm = findVm(); if (vm) return res(vm); if (Date.now() - t0 > ms) return rej(new Error('no se encuentra el constructor')); setTimeout(poll, 250); })();
    });
  }
  function build(P) {
    if (!/\/deck\/edit\.html/.test(location.pathname)) { location.href = BASE + 'deck/edit.html' + location.hash; return; }
    box('<b>Cargando el mazo en el constructor oficial…</b><span style="font-size:14px;color:#555">Tarda unos segundos.</span>');
    return Promise.all([waitVm(15000), allCards()]).then(function (res) {
      var vm = res[0], all = res[1], idx = {}, byNo = {};
      all.forEach(function (c) { idx[c.card_no + '-' + c.image_end] = c; if (!byNo[c.card_no]) byNo[c.card_no] = c; });
      var cards = [], missing = [], now = new Date().toISOString();
      P.b.forEach(function (e) {
        var id = e[0], n = e[1], role = e[2] || '';
        var c = idx[id] || byNo[id.replace(/-[A-Z]{1,3}$/, '')];
        if (!c) { missing.push(id); return; }
        for (var k = 0; k < n && cards.length < 50; k++) cards.push({ card_no: c.card_no, image_end: c.image_end, category: c.category, vobarity: c.vobarity, voba_order: c.voba_order, product_order: c.product_order, added_at: now, selectedCategory: c.category === 'EVENT' ? '' : role, selected: false });
      });
      vm.deck.cards = cards;
      vm.deck.name = String(P.name || '').slice(0, 40);
      vm.deck.updated_at = now;
      var ev = cards.filter(function (c) { return c.category === 'EVENT'; }).length;
      var ok = cards.length === 40 && ev <= 8;
      var d = box('<b>Mazo cargado en el constructor oficial</b>' +
        '<span>' + cards.length + ' cartas · ' + ev + ' eventos' + (missing.length ? ' · <span style="color:#b9770e">no encontradas: ' + esc(missing.join(', ')) + '</span>' : '') + '</span>' +
        (ok ? '<span>Revisa el mazo y pulsa el botón de guardar de la web (<b>デッキの保存</b>). Te dará el <b>código oficial</b> del mazo.</span>'
          : '<span style="color:#b00">La web oficial solo deja guardar mazos de <b>40 cartas</b> con <b>8 eventos como máximo</b>. Ajusta el mazo aquí mismo o en Vobaca Proxies antes de guardar.</span>') +
        '<span style="font-size:13px;color:#555">Opcional: en «デッキ情報を追加» puedes poner autor y etiquetas. Marca «デッキ検索に掲載する» solo si quieres que salga en la búsqueda pública.</span>' +
        '<div style="display:flex;justify-content:flex-end"><button data-close style="' + B1 + '">Entendido</button></div>');
    }).catch(function (e) { fail('No se ha podido cargar el mazo en el constructor: ' + e.message); });
  }

  // ---------- Modo 4: cartas nuevas ----------
  function pagesOf(url) {
    return fetch(url + 1).then(function (r) { return r.json(); }).then(function (first) {
      var pages = Math.ceil(first.count / Math.max(1, first.items.length)), reqs = [];
      for (var p = 2; p <= pages; p++) reqs.push(fetch(url + p).then(function (r) { return r.json(); }));
      return Promise.all(reqs).then(function (rest) { var all = first.items; rest.forEach(function (x) { all = all.concat(x.items || []); }); return all; });
    });
  }
  function newCards(P) {
    box('<b>Buscando cartas nuevas en la web oficial…</b><span style="font-size:14px;color:#555">Tarda unos segundos.</span>');
    var known = {}; String(P.k || '').split(',').forEach(function (k) { if (k) known['HV-' + k] = 1; });
    var Q = 'itemsearch.php?para=normal%2Cp%2Ca&p=';
    var txt = function (t) { t = String(t == null ? '' : t).replace(/\r\n|\r|\n/g, '¶').trim(); return t === '-' ? '' : t; };
    var stat = function (v) { v = String(v == null ? '' : v).trim(); return /^\d$/.test(v) ? v : '-'; };
    return Promise.all([pagesOf(BASE + 'cardlist/' + Q), pagesOf(BASE + 'english/cardlist/' + Q).catch(function () { return []; })]).then(function (res) {
      var jp = [], en = [];
      res[0].forEach(function (c) {
        if (known[c.card_no + '-' + c.image_end]) return;
        jp.push([c.card_no, c.image_end, c.name, c.category === 'EVENT' ? 'E' : 'C', c.affiliation || '', c.position || '',
          [c.serve, c.block, c.receive, c.toss, c.attack].map(stat).join(''), txt(c.skill), txt(c.annotation), c.product_name || '']);
      });
      res[1].forEach(function (c) {
        if (known[c.card_no + '-EN-' + c.image_end]) return;
        en.push([c.card_no, c.image_end, c.name, c.category === 'EVENT' ? 'E' : 'C', txt(c.skill), txt(c.annotation), c.product_name || '']);
      });
      var total = res[0].length + res[1].length;
      if (!jp.length && !en.length) { box('<b>No hay cartas nuevas</b><span>Tu herramienta ya tiene las ' + total + ' cartas de la web oficial.</span><div style="display:flex;justify-content:flex-end">' + closeBtn + '</div>'); return; }
      return sendBack('vbcards', { v: 1, date: new Date().toISOString(), jp: jp, en: en }, 'Cartas nuevas encontradas',
        [jp.length + ' japonesas y ' + en.length + ' inglesas que tu herramienta aún no tiene.', 'Pulsa «Abrir en Vobaca Proxies» para añadirlas.']);
    });
  }

  // ---------- Modo 5: mazos públicos ----------
  function publicDecks() {
    box('<b>Descargando los mazos públicos…</b><span style="font-size:14px;color:#555">Tarda unos segundos.</span>');
    var url = BASE + 'deck/deck_list.php?per_page=100&page=';
    return fetch(url + 1).then(function (r) { return r.json(); }).then(function (first) {
      var pages = Math.min(10, Math.ceil((first.total_count || 0) / 100)), reqs = [];
      for (var p = 2; p <= pages; p++) reqs.push(fetch(url + p).then(function (r) { return r.json(); }));
      return Promise.all(reqs).then(function (rest) {
        var all = first.decks || []; rest.forEach(function (x) { all = all.concat(x.decks || []); });
        var decks = all.map(function (d) {
          var tags = Array.isArray(d.tags) ? d.tags.map(function (t) { return (t && t.name) || t; }).join(',') : (d.tags || '');
          return [d.deck_key, d.recommendation_name || '', d.recommendation_creator || '', d.updated_at || '', +d.favorite_count || 0, tags,
            (d.recommendation_card_no_1 || ''), (d.cards || []).map(function (c) { return [c.card_no + '-' + c.image_end, +c.count || 1, c.category === 'EVENT' ? 'E' : (c.role === 'フリー' ? '' : c.role || '')]; })];
        });
        return sendBack('vbdecks', { v: 1, date: new Date().toISOString(), decks: decks }, decks.length + ' mazos públicos descargados',
          ['Pulsa «Abrir en Vobaca Proxies» para verlos, filtrarlos e importarlos.']);
      });
    });
  }

  // ---------- Modo 1: mazo oficial → Vobaca Proxies ----------
  function importOfficial() {
    var k = (location.search.match(/deck_key=([A-Za-z0-9]+)/) || [])[1] || prompt(T('Código de mazo oficial de Vobaca'));
    if (!k) return;
    k = ((k.match(/deck_key=([A-Za-z0-9]+)/) || [])[1] || k).trim();
    return fetch(BASE + 'deck/get_deck.php?deck_key=' + encodeURIComponent(k)).then(function (r) { return r.json(); }).then(function (j) {
      if (!j.success || !j.deck) { fail('No existe ningún mazo con el código ' + k); return; }
      var m = {}, o = [];
      j.deck.cards.forEach(function (c) {
        var ro = (c.category !== 'EVENT' && c.role && c.role !== 'フリー') ? ' ' + c.role : '';
        var id = c.card_no + '-' + c.image_end + ro;
        if (!m[id]) { m[id] = 0; o.push(id); } m[id]++;
      });
      var t = '# ' + (j.deck.name || k) + '\n' + o.map(function (id) { return m[id] + ' ' + id; }).join('\n');
      var d = box('<b>' + j.deck.cards.length + ' cartas · «' + esc(j.deck.name || k) + '»</b>' +
        (HOME ? '<span style="font-size:14px;color:#555">Pulsa «Abrir en Vobaca Proxies» para cargarlo como mazo nuevo, o copia la lista.</span>' : '') +
        '<textarea readonly style="width:100%;height:180px;font:13px monospace;border:1px solid #ccc;border-radius:8px;padding:8px;box-sizing:border-box"></textarea>' +
        '<div style="display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap"><span id="vbm" style="margin-right:auto;align-self:center;color:' + ORANGE + '"></span>' +
        '<button id="vbc" style="' + B2 + '">Copiar</button>' + (HOME ? '<a id="vbo" style="' + B1 + '">Abrir en Vobaca Proxies</a>' : '') + closeBtn + '</div>');
      var ta = d.querySelector('textarea'); ta.value = t;
      if (HOME) d.querySelector('#vbo').href = HOME + '#vbimp=' + b64u(t);
      d.querySelector('#vbc').onclick = function () {
        var msg = d.querySelector('#vbm');
        (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(function () { msg.textContent = T('¡Copiada!'); }, function () {
          ta.focus(); ta.select(); ta.setSelectionRange(0, t.length);
          try { document.execCommand('copy'); msg.textContent = T('¡Copiada!'); } catch (e) { msg.textContent = T('Selecciónala y cópiala'); }
        });
      };
    });
  }

  var run = !payload ? importOfficial() : payload.a === 'img' ? drawImage(payload) : payload.a === 'build' ? build(payload)
    : payload.a === 'cards' ? newCards(payload) : payload.a === 'decks' ? publicDecks() : (fail('Este enlace no es de Vobaca Proxies.'), null);
  if (run && run.catch) run.catch(function (e) { fail('Error: ' + e.message); });
})();

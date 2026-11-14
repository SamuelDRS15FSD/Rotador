/* Rotador · control de vencimientos y pedido de precios (PWA, offline) */
(function () {
  'use strict';
  const D = window.RotDates;
  const $ = (s, r) => (r || document).querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const norm = (s) => String(s || '').trim().toLowerCase();
  const supplierList = (extra) => Array.from(new Set(state.products.map((x) => x.supplier).concat(extra || []).filter(Boolean))).sort();
  function csvBlob(rows) {
    const q = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    return new Blob(['\ufeff' + rows.map((r) => r.map(q).join(';')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
  }
  const AREAS = { atendida: { name: 'Atendida' }, autoservicio: { name: 'Autoservicio' } };
  const areaOf = (l) => (l && l.area === 'autoservicio' ? 'autoservicio' : 'atendida');
  const areaTag = (a) => '<span class="atag ' + a + '">' + AREAS[a].name + '</span>';
  const REASONS = { vendido: 'Vendido', merma: 'Merma (dañado o vencido)', devolucion: 'Devolución al proveedor', donacion: 'Donación', otro: 'Otro' };
  const REASON_SHORT = { vendido: 'Vendido', merma: 'Merma', devolucion: 'Devolución', donacion: 'Donación', otro: 'Otro' };
  function areaChips(action, cur) {
    const c = (k, t) => '<button class="chip area ' + k + ' ' + (cur === k ? 'on' : '') + '" data-action="' + action + '" data-a="' + k + '">' + t + '</button>';
    return '<div class="chips">' + c('', 'Todas las áreas') + c('atendida', 'Atendida') + c('autoservicio', 'Autoservicio') + '</div>';
  }

  /* ===================== Estado ===================== */
  const DEFAULTS = { windowDays: 7, removeBefore: 1, promoManual: false, promoFrom: '', promoTo: '', snooze: {}, scalesOn: false };
  const state = {
    products: [], lots: [], rounds: [], removals: [], scales: [], settings: Object.assign({}, DEFAULTS),
    tab: 'home', filter: 'all', q: '', supplier: '', pedirTab: 'pedir', area: '', pedirArea: '', lastArea: 'atendida', repTab: 'retiro', retiroDays: 0, retiroArea: '', period: 'month', lastReason: 'vendido',
    editingLotId: null, draft: {}, cq: '', sq: '', scaleArea: 'autoservicio', scaleCat: '', scaleSup: '', lastScaleCat: ''
  };

  /* ===================== Base de datos local (IndexedDB) ===================== */
  let db;
  function openDB() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('rotador', 3);
      r.onupgradeneeded = () => {
        const d = r.result;
        ['products', 'lots', 'rounds', 'removals', 'scales'].forEach((n) => {
          if (!d.objectStoreNames.contains(n)) d.createObjectStore(n, { keyPath: 'id', autoIncrement: true });
        });
        if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv', { keyPath: 'key' });
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  function tx(store, mode, fn) {
    return new Promise((res, rej) => {
      const t = db.transaction(store, mode);
      const out = fn(t.objectStore(store));
      t.oncomplete = () => res(out && typeof out === 'object' && 'readyState' in out ? out.result : out);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    });
  }
  const getAll = (s) => tx(s, 'readonly', (st) => st.getAll());
  const put = (s, o) => tx(s, 'readwrite', (st) => st.put(o));
  function putMany(s, arr) {
    return new Promise((res, rej) => {
      const t = db.transaction(s, 'readwrite'), st = t.objectStore(s);
      arr.forEach((o) => st.put(o));
      t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
    });
  }
  const del = (s, id) => tx(s, 'readwrite', (st) => st.delete(id));
  function replaceAll(data) {
    return new Promise((res, rej) => {
      const t = db.transaction(['products', 'lots', 'rounds', 'removals', 'scales', 'kv'], 'readwrite');
      ['products', 'lots', 'rounds', 'removals', 'scales'].forEach((n) => {
        const s = t.objectStore(n); s.clear();
        (data[n] || []).forEach((o) => s.put(o));
      });
      const kv = t.objectStore('kv'); kv.clear();
      if (data.settings) kv.put({ key: 'settings', value: data.settings });
      t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
    });
  }
  async function reload() {
    const r = await Promise.all([getAll('products'), getAll('lots'), getAll('rounds'), getAll('removals'), getAll('scales'), tx('kv', 'readonly', (s) => s.get('settings'))]);
    state.products = r[0]; state.lots = r[1]; state.rounds = r[2]; state.removals = r[3]; state.scales = r[4];
    state.settings = Object.assign({}, DEFAULTS, r[5] ? r[5].value : {});
  }
  const saveSettings = () => put('kv', { key: 'settings', value: state.settings });

  /* ===================== Cálculos ===================== */
  const T = () => D.today();
  const prodById = (id) => state.products.find((p) => p.id === id);
  const lotById = (id) => state.lots.find((l) => l.id === id);
  function enrich(l) {
    const p = prodById(l.productId) || {};
    const t = T();
    const dExp = D.diffDays(t, D.fromISO(l.expiry));
    const dRem = dExp - state.settings.removeBefore;
    const sEnd = l.sale && l.sale.end ? l.sale.end : '';
    const saleEnded = !!sEnd && sEnd < D.toISO(t);
    return Object.assign({}, l, {
      area: areaOf(l), name: p.name || '(sin nombre)', code: p.code || '', codeType: p.codeType || '', unit: p.unit || 'und',
      photo: p.thumb || p.photo || '', photoFull: p.photo || '', supplier: p.supplier || 'Sin proveedor', dExp: dExp, dRem: dRem, urg: D.urgency(dRem),
      saleOn: !!l.sale && !saleEnded, saleEnded: !!l.sale && saleEnded, dSale: sEnd ? D.diffDays(t, D.fromISO(sEnd)) : null
    });
  }
  const activeLots = () => state.lots.filter((l) => l.status === 'active').map(enrich);
  const lotActive = (id) => { const l = lotById(id); return !!l && l.status === 'active'; };
  const roundPending = (r) => r.items.filter((i) => i.check === 'pending' && lotActive(i.lotId));
  const isOpen = (r) => roundPending(r).length > 0;
  const openRounds = () => state.rounds.filter(isOpen).sort((a, b) => a.date < b.date ? -1 : 1);
  function pendingLotIds() {
    const s = new Set();
    state.rounds.forEach((r) => r.items.forEach((i) => { if (i.check === 'pending') s.add(i.lotId); }));
    return s;
  }
  // Lotes que faltan por pedir: vencen en <= N días, no vencidos, sin rebaja, sin verificación pendiente.
  function porPedir() {
    const pend = pendingLotIds();
    const w = state.settings.windowDays;
    return activeLots().filter((l) => !l.saleOn && !pend.has(l.id) && l.dExp >= 0 && l.dExp <= w)
      .sort((a, b) => a.dExp - b.dExp || a.name.localeCompare(b.name));
  }
  function porPedirArea() { return porPedir().filter((l) => !state.pedirArea || l.area === state.pedirArea); }
  function verifyDueCount() {
    const iso = D.toISO(T());
    return openRounds().filter((r) => r.verifyDate <= iso).reduce((n, r) => n + roundPending(r).length, 0);
  }
  const qtyText = (q, u) => String(+Number(q).toFixed(3)).replace('.', ',') + ' ' + (u || 'und');
  function whenText(l) {
    if (l.dExp < 0) return 'Vencido hace ' + (-l.dExp) + (l.dExp === -1 ? ' día' : ' días');
    if (l.dRem < 0) return 'Atrasado ' + (-l.dRem) + (l.dRem === -1 ? ' día' : ' días');
    if (l.dRem === 0) return 'Retirar hoy';
    if (l.dRem === 1) return 'Retirar mañana';
    return 'Retirar en ' + l.dRem + ' días';
  }

  /* ===================== Avisos internos ===================== */
  function nextRequest() { return D.nextRequestDay(T(), state.settings); }
  function computeAlerts() {
    const t = T(), iso = D.toISO(t), s = state.settings, a = [];
    const lots = activeLots();
    const red = lots.filter((l) => l.dRem <= 0);
    const orange = lots.filter((l) => l.dRem >= 1 && l.dRem <= 3);
    const pp = porPedir();
    const isReq = D.isRequestDay(t, s);
    if (red.length) a.push({ key: 'red', cls: 'red', icon: '🔴', text: red.length + (red.length === 1 ? ' lote para retirar hoy o atrasado' : ' lotes para retirar hoy o atrasados'), go: { tab: 'home', filter: 'red' } });
    if (orange.length) a.push({ key: 'orange', cls: 'orange', icon: '🟠', text: orange.length + (orange.length === 1 ? ' lote se retira en 1 a 3 días' : ' lotes se retiran en 1 a 3 días'), go: { tab: 'home', filter: 'soon' } });
    const sEnded = lots.filter((l) => l.saleEnded), sSoon = lots.filter((l) => l.saleOn && l.dSale !== null && l.dSale <= 1);
    if (sEnded.length) a.push({ key: 'saleend', cls: 'orange', icon: '🏷️', text: sEnded.length + (sEnded.length === 1 ? ' rebaja terminó: quita la etiqueta de oferta' : ' rebajas terminaron: quita la etiqueta de oferta'), go: { tab: 'home', filter: 'saleend' } });
    if (sSoon.length) a.push({ key: 'salesoon', cls: 'blue', icon: '⏳', text: sSoon.length + (sSoon.length === 1 ? ' rebaja termina hoy o mañana' : ' rebajas terminan hoy o mañana'), go: { tab: 'home', filter: 'sale' } });
    if (isReq && pp.length) a.push({ key: 'request', cls: 'blue', icon: '📋', text: 'Hoy toca pedir precios (' + pp.length + (pp.length === 1 ? ' lote)' : ' lotes)'), go: { tab: 'pedir', pedirTab: 'pedir' } });
    const due = openRounds().filter((r) => r.verifyDate <= iso);
    due.forEach((r) => {
      const n = roundPending(r).length;
      a.push({ key: 'verify' + r.id, cls: 'blue', icon: '✅', text: 'Verificar precios de la ronda del ' + D.fmt(D.fromISO(r.date)) + ' (' + n + (n === 1 ? ' pendiente)' : ' pendientes)'), go: { tab: 'pedir', pedirTab: 'verificar' } });
    });
    if (!isReq && pp.length) {
      const nx = D.nextRequestDay(t, s);
      const ya = pp.filter((l) => nx && D.diffDays(t, nx) >= l.dRem);
      if (ya.length) a.push({ key: 'urgent', cls: 'orange', icon: '⚠️', text: ya.length + (ya.length === 1 ? ' lote' : ' lotes') + ' se retira antes del próximo pedido (' + D.fmt(nx) + '): pide ya', go: { tab: 'pedir', pedirTab: 'pedir' } });
    }
    return a.filter((x) => !(s.snooze[x.key] && s.snooze[x.key] > iso));
  }
  function alertsHTML() {
    const list = computeAlerts();
    if (!list.length) return '<div class="empty">Sin avisos por ahora 🎉</div>';
    return list.map((x) => '<div class="alert ' + x.cls + '"><span class="ico">' + x.icon + '</span><span class="txt">' + esc(x.text) +
      '</span><span class="acts"><button class="btn-mini" data-action="alert-go" data-key="' + esc(x.key) + '">Ver</button>' +
      '<button class="btn-mini" data-action="alert-snooze" data-key="' + esc(x.key) + '">Mañana</button></span></div>').join('');
  }
  function updateBadges() {
    const lots = activeLots();
    const red = lots.filter((l) => l.dRem <= 0).length;
    const pedir = porPedir().length + verifyDueCount();
    const setB = (id, n) => { const e = $(id); e.textContent = n; e.classList.toggle('hidden', !n); };
    setB('#bHome', red); setB('#bPedir', pedir);
    const nAl = computeAlerts().length;
    const bc = $('#bellCount'); bc.textContent = nAl; bc.classList.toggle('hidden', !nAl);
    try { if (navigator.setAppBadge) { (red + verifyDueCount()) ? navigator.setAppBadge(red + verifyDueCount()) : navigator.clearAppBadge(); } } catch (e) { /* sin soporte */ }
  }

  /* ===================== Vistas ===================== */
  const photoImg = (src, cls) => src ? '<img class="' + (cls || 'pth') + '" src="' + esc(src) + '" alt="">' : '';
  const saleEndText = (l) => l.sale && l.sale.end ? D.fmt(D.fromISO(l.sale.end)) : '';
  function lotCard(l) {
    const tags = [];
    if (l.saleOn) tags.push('<span class="tag">En rebaja · ' + esc(l.sale.type === '2x1' ? '2x1' : 'precio') + (l.sale.note ? ' · ' + esc(l.sale.note) : '') + (l.sale.end ? ' · hasta ' + esc(saleEndText(l)) : '') + '</span>');
    else if (l.saleEnded) tags.push('<span class="tag warn">Rebaja terminada el ' + esc(saleEndText(l)) + ' · quitar etiqueta</span>');
    return '<article class="lot ' + l.urg + ' ar-' + l.area + '">' + (l.photo ? '<div data-action="zoom-photo" data-pid="' + l.productId + '">' + photoImg(l.photo) + '</div>' : '') + '<div class="lot-main" data-action="open-lot" data-id="' + l.id + '">' +
      '<div class="lot-name">' + areaTag(l.area) + ' ' + esc(l.name) + '</div>' +
      '<div class="lot-sub">' + (l.lot ? 'Lote ' + esc(l.lot) + ' · ' : '') + esc(qtyText(l.qty, l.unit)) + ' · ' + esc(l.supplier) + '</div>' +
      '<div class="lot-dates">Vence ' + D.fmt(D.fromISO(l.expiry)) + ' · <span class="when">' + whenText(l) + '</span></div>' +
      (tags.length ? '<div>' + tags.join('') + '</div>' : '') + '</div>' +
      '<button class="btn-mini" data-action="remove-lot" data-id="' + l.id + '">Retirar</button></article>';
  }

  function viewHome() {
    const w = state.settings.windowDays;
    let lots = activeLots();
    if (state.area) lots = lots.filter((l) => l.area === state.area);
    const red = lots.filter((l) => l.dRem <= 0).length;
    const near = lots.filter((l) => l.dRem > 0 && l.dExp <= w).length;
    const suppliers = Array.from(new Set(state.products.map((p) => p.supplier).filter(Boolean))).sort();
    const f = state.filter;
    if (f === 'red') lots = lots.filter((l) => l.dRem <= 0);
    else if (f === 'soon') lots = lots.filter((l) => l.dRem <= 3);
    else if (f === 'week') lots = lots.filter((l) => l.dExp <= w);
    else if (f === 'sale') lots = lots.filter((l) => l.saleOn);
    else if (f === 'saleend') lots = lots.filter((l) => l.saleEnded);
    if (state.supplier) lots = lots.filter((l) => l.supplier === state.supplier);
    const q = norm(state.q);
    if (q) lots = lots.filter((l) => norm(l.name).includes(q) || norm(l.code).includes(q) || norm(l.lot).includes(q));
    lots.sort((a, b) => a.dExp - b.dExp || a.name.localeCompare(b.name));
    const chip = (k, t) => '<button class="chip ' + (f === k ? 'on' : '') + '" data-action="filter" data-f="' + k + '">' + t + '</button>';
    const total = state.lots.filter((l) => l.status === 'active').length;
    return alertsHTML() +
      '<div class="stats"><div class="stat red"><b>' + red + '</b><span>Retirar hoy o atrasados</span></div>' +
      '<div class="stat orange"><b>' + near + '</b><span>Vencen en ≤ ' + w + ' días</span></div></div>' +
      areaChips('area-filter', state.area) + '<div class="row"><input type="search" id="q" class="grow" placeholder="Buscar producto, código o lote" value="' + esc(state.q) + '"><button type="button" class="btn" data-action="scan-search" data-k="q" aria-label="Escanear">📷</button></div>' +
      '<div class="chips">' + chip('all', 'Todos') + chip('red', '🔴 Retirar hoy') + chip('soon', '🟠 ≤ 3 días') + chip('week', '≤ ' + w + ' días') + chip('sale', 'En rebaja') + chip('saleend', 'Rebaja terminada') + '</div>' +
      (suppliers.length ? '<select id="supSel" style="margin-bottom:10px"><option value="">Todos los proveedores</option>' +
        suppliers.map((s) => '<option ' + (state.supplier === s ? 'selected' : '') + '>' + esc(s) + '</option>').join('') + '</select>' : '') +
      (lots.length ? lots.map(lotCard).join('') :
        '<div class="empty">' + (total ? 'Ningún lote coincide con el filtro.' : 'Aún no hay productos.<br>Toca <b>Agregar</b> para registrar el primero.') + '</div>');
  }

  function guessType(code) { return /^\d{8,14}$/.test(code) ? 'EAN' : 'PLU'; }
  function viewAdd() {
    const edit = state.editingLotId ? lotById(state.editingLotId) : null;
    const p = edit ? (prodById(edit.productId) || {}) : null;
    const d = edit ? { name: p.name, code: p.code, codeType: p.codeType, unit: p.unit, supplier: p.supplier, lot: edit.lot, expiry: edit.expiry, qty: edit.qty } : (state.draft || {});
    const unit = d.unit || 'und';
    const area = edit ? areaOf(edit) : (d.area || state.lastArea);
    const names = Array.from(new Set(state.products.map((x) => x.name))).sort();
    const sups = supplierList();
    const scOn = state.settings.scalesOn, sc0 = scOn && edit && p && p.id ? state.scales.find((x) => x.productId === p.id && x.area === area) : null;
    photoBuf.f = edit ? (p.photo || '') : (d.photo || ''); thumbBuf.f = edit ? (p.thumb || '') : ''; photoCleared.f = false;
    return '<h2>' + (edit ? 'Editar lote' : 'Agregar producto') + '</h2>' +
      (edit ? '' : '<button type="button" class="btn block" style="margin-bottom:10px" data-action="cat-open">📥 Importar catálogo (PDF o imagen)</button>') +
      '<form id="lotForm" autocomplete="off">' +
      '<label class="f" style="margin-top:0">Área</label><div class="seg">' +
      '<label><input type="radio" name="f-area" value="atendida" hidden' + (area === 'atendida' ? ' checked' : '') + '><span class="segopt atendida">Atendida</span></label>' +
      '<label><input type="radio" name="f-area" value="autoservicio" hidden' + (area === 'autoservicio' ? ' checked' : '') + '><span class="segopt autoservicio">Autoservicio</span></label></div>' +
      '<label class="f" for="f-code">Código (EAN o PLU)</label>' +
      '<div class="row"><input id="f-code" inputmode="numeric" placeholder="Escanea o escribe" value="' + esc(d.code || '') + '" class="grow">' +
      '<button type="button" class="btn" data-action="scan" aria-label="Escanear">📷</button></div>' +
      '<div class="row" style="margin-top:6px"><select id="f-ctype" style="width:auto"><option value="EAN"' + ((d.codeType || 'EAN') === 'EAN' ? ' selected' : '') + '>EAN</option><option value="PLU"' + (d.codeType === 'PLU' ? ' selected' : '') + '>PLU</option></select>' +
      '<span class="muted small" id="codeHint"></span></div>' +
      '<label class="f" for="f-name">Nombre</label><input id="f-name" list="dl-names" required value="' + esc(d.name || '') + '">' +
      '<label class="f">Foto del producto (opcional)</label>' + photoWidget('f', photoBuf.f) +
      '<datalist id="dl-names">' + names.map((n) => '<option value="' + esc(n) + '">').join('') + '</datalist>' +
      '<label class="f">Se cuenta en</label><div class="seg"><label><input type="radio" name="f-unit" value="und" hidden' + (unit === 'und' ? ' checked' : '') + '><span class="segopt">Unidades</span></label>' +
      '<label><input type="radio" name="f-unit" value="kg" hidden' + (unit === 'kg' ? ' checked' : '') + '><span class="segopt">Kilos</span></label></div>' +
      '<label class="f" for="f-supplier">Proveedor</label><input id="f-supplier" list="dl-sups" value="' + esc(d.supplier || '') + '">' +
      '<datalist id="dl-sups">' + sups.map((n) => '<option value="' + esc(n) + '">').join('') + '</datalist>' +
      (scOn ? '<div class="card" style="margin-top:14px"><b>⚖️ Código de balanza</b> <span class="muted small">(opcional)</span>' +
        '<div id="sf-catwrap"' + (area === 'atendida' ? '' : ' class="hidden"') + '><label class="f" for="sf-cat">Categoría (Atendida)</label><select id="sf-cat">' +
        Object.keys(SCATS).map((k) => '<option value="' + k + '"' + ((sc0 ? scatOf(sc0) : (state.lastScaleCat || 'res')) === k ? ' selected' : '') + '>' + SCATS[k] + '</option>').join('') + '</select></div>' +
        '<label class="f" for="sf-code">Código de balanza</label><input id="sf-code" autocomplete="off" value="' + esc(sc0 ? sc0.code : '') + '">' +
        '<p class="small muted" style="margin:6px 0 0">Se guarda en la pestaña Balanzas (sección según el Área de arriba) y queda vinculado a este producto: nombre, PLU y proveedor se toman de aquí.</p></div>' : '') +
      '<div class="row"><div class="grow"><label class="f" for="f-lot">Lote</label><input id="f-lot" value="' + esc(d.lot || '') + '"></div>' +
      '<div class="grow"><label class="f" for="f-qty">Cantidad (<span id="unitLbl">' + (unit === 'kg' ? 'kg' : 'und') + '</span>)</label><input id="f-qty" type="text" inputmode="decimal" pattern="[0-9]*[.,]?[0-9]*" placeholder="0" required value="' + esc(d.qty != null ? d.qty : '') + '"></div></div>' +
      '<label class="f" for="f-exp">Fecha de vencimiento</label><input id="f-exp" type="date" required value="' + esc(d.expiry || '') + '">' +
      '<div style="margin-top:16px" class="row wrap">' +
      '<button class="btn primary grow" type="submit">' + (edit ? 'Guardar cambios' : 'Guardar') + '</button>' +
      (edit ? '<button class="btn" type="button" data-action="cancel-edit">Cancelar</button>' :
        '<button class="btn grow" type="button" data-action="save-again">Guardar y agregar otro</button>') +
      '</div></form>';
  }

  function scheduleBox() {
    const t = T(), s = state.settings, req = D.isRequestDay(t, s);
    const ref = req ? t : D.nextRequestDay(t, s);
    let h;
    if (req) h = '<b>Hoy es día de pedir precios</b><br><span class="muted">Verificar mañana: ' + D.fmt(D.verifyDay(t)) + '</span>';
    else h = 'Próximo pedido: <b>' + D.fmt(ref) + '</b><br><span class="muted">Verificar: ' + D.fmt(D.verifyDay(ref)) + '</span>';
    const why = D.shiftReason(ref, s);
    if (why) h += '<br><span class="tag warn">Esta semana se pide martes y viernes · ' + (why.type === 'festivo' ? 'lunes festivo: ' + esc(why.name) : 'promoción') + '</span>';
    return '<div class="card">' + h + '</div>';
  }

  function pedirList() {
    const list = porPedirArea();
    const nx = D.isRequestDay(T(), state.settings) ? null : nextRequest();
    if (!list.length) return '<div class="empty">No hay lotes por pedir 👌<br><span class="small">Aparecen cuando vencen en ' + state.settings.windowDays + ' días o menos.</span></div>';
    let h = '<div class="row wrap" style="margin-bottom:6px"><span class="small muted">Todos a:</span>' +
      '<button class="btn-mini" data-action="bulk-type" data-type="precio">Precio</button><button class="btn-mini" data-action="bulk-type" data-type="2x1">2x1</button></div>';
    ['atendida', 'autoservicio'].forEach((ar) => {
      const al = list.filter((l) => l.area === ar);
      if (!al.length) return;
      h += '<div class="areahead ' + ar + '">' + AREAS[ar].name + ' · ' + al.length + '</div>';
      const groups = {};
      al.forEach((l) => { (groups[l.supplier] = groups[l.supplier] || []).push(l); });
      Object.keys(groups).sort().forEach((sup) => {
        h += '<div class="supplier">' + esc(sup) + '</div>';
        groups[sup].forEach((l) => {
          const type = l.reqType || 'precio';
          const tags = [];
          if (nx && D.diffDays(T(), nx) >= l.dRem) tags.push('<span class="tag warn">⚠️ Pedir ya</span>');
          if (l.lastFail) tags.push('<span class="tag bad">Sin precio el ' + D.fmt(D.fromISO(l.lastFail)) + '</span>');
          h += '<div class="plot ' + (l.urg === 'green' ? '' : l.urg) + ' ar-' + l.area + '"><div class="row"><div class="grow"><b>' + esc(l.name) + '</b><div class="lot-sub">' +
            (l.lot ? 'Lote ' + esc(l.lot) + ' · ' : '') + esc(qtyText(l.qty, l.unit)) + '</div>' +
            '<div class="lot-dates">Vence ' + D.fmt(D.fromISO(l.expiry)) + ' (en ' + l.dExp + ' d) · <span class="when">' + whenText(l) + '</span></div>' +
            (tags.length ? '<div>' + tags.join('') + '</div>' : '') + '</div></div>' +
            '<div class="row" style="margin-top:8px"><div class="seg">' +
            '<button class="' + (type === 'precio' ? 'on' : '') + '" data-action="set-type" data-id="' + l.id + '" data-type="precio">Precio</button>' +
            '<button class="' + (type === '2x1' ? 'on' : '') + '" data-action="set-type" data-id="' + l.id + '" data-type="2x1">2x1</button></div></div>' +
            '<input class="note" placeholder="Nota (opcional)" value="' + esc(l.reqNote || '') + '" data-change="req-note" data-id="' + l.id + '"></div>';
        });
      });
    });
    h += '<div class="actionbar"><button class="btn primary block" data-action="gen-pdf">Generar PDF (' + list.length + ')</button></div>';
    return h;
  }

  function roundHTML(r, editable) {
    const iso = D.toISO(T());
    const items = r.items.filter((i) => lotActive(i.lotId) || i.check !== 'pending');
    const pend = roundPending(r).length;
    let status = '';
    if (pend) status = r.verifyDate < iso ? '<span class="tag bad">Verificación atrasada</span>' : r.verifyDate === iso ? '<span class="tag warn">Verificar hoy</span>' : '<span class="tag">Verificar mañana</span>';
    else status = '<span class="tag">Completa</span>';
    const sorted = items.slice().sort((a, b) => (a.snap.area || 'atendida').localeCompare(b.snap.area || 'atendida') || (a.snap.supplier || '').localeCompare(b.snap.supplier || '') || a.snap.name.localeCompare(b.snap.name));
    let h = '<section class="card"><div class="row wrap"><div class="grow"><b>Ronda del ' + D.fmt(D.fromISO(r.date)) + '</b><div class="small muted">Verificar: ' + D.fmt(D.fromISO(r.verifyDate)) + '</div></div>' + status + '</div>' +
      '<div class="row wrap" style="margin:8px 0">' + (pend ? '<button class="btn-mini" data-action="check-all" data-round="' + r.id + '">✅ Marcar todos</button>' : '') +
      '<button class="btn-mini" data-action="round-pdf" data-round="' + r.id + '">📄 PDF</button></div>';
    sorted.forEach((i) => {
      const cur = i.check;
      const b = (v, label) => '<button class="ck ' + v + ' ' + (cur === v ? 'on' : '') + '" data-action="check" data-round="' + r.id + '" data-lot="' + i.lotId + '" data-val="' + v + '">' + label + '</button>';
      h += '<div class="plot ar-' + (i.snap.area || 'atendida') + '" style="border-left-color:var(--line)">' + areaTag(i.snap.area || 'atendida') + ' <b>' + esc(i.snap.name) + '</b> <span class="tag">' + esc(i.type === '2x1' ? '2x1' : 'Precio') + '</span>' +
        '<div class="lot-sub">' + (i.snap.lot ? 'Lote ' + esc(i.snap.lot) + ' · ' : '') + esc(qtyText(i.snap.qty, i.snap.unit)) + ' · ' + esc(i.snap.supplier || '') + '</div>' +
        '<div class="checks">' + b('pending', '⬜ Pendiente') + b('ok', '✅ Sí') + b('no', '❌ No') + '</div>' +
        '<input class="note" placeholder="Precio nuevo o nota" value="' + esc(i.price || '') + '" data-change="item-price" data-round="' + r.id + '" data-lot="' + i.lotId + '">' +
        (cur === 'no' ? '' : '<div class="row endrow"><span class="small muted">Rebaja hasta</span><input type="date" class="grow" value="' + esc(i.saleEnd || '') + '" min="' + D.toISO(T()) + '" data-change="item-end" data-round="' + r.id + '" data-lot="' + i.lotId + '"></div>') + '</div>';
    });
    return h + '</section>';
  }

  function viewVerificar() {
    const open = openRounds();
    const hist = state.rounds.filter((r) => !isOpen(r)).sort((a, b) => a.date < b.date ? 1 : -1).slice(0, 8);
    let h = open.length ? open.map((r) => roundHTML(r)).join('') : '<div class="empty">No hay rondas por verificar.<br><span class="small">Se crean al generar el PDF en “Por pedir”.</span></div>';
    if (hist.length) h += '<details class="hist"><summary>Historial (' + hist.length + ')</summary>' + hist.map((r) => roundHTML(r)).join('') + '</details>';
    return h;
  }

  function viewPedir() {
    const n1 = porPedir().length, n2 = openRounds().reduce((n, r) => n + roundPending(r).length, 0);
    return '<h2>Pedir precios</h2>' + scheduleBox() +
      '<div class="subtabs"><button class="' + (state.pedirTab === 'pedir' ? 'on' : '') + '" data-action="pedir-tab" data-t="pedir">Por pedir (' + n1 + ')</button>' +
      '<button class="' + (state.pedirTab === 'verificar' ? 'on' : '') + '" data-action="pedir-tab" data-t="verificar">Por verificar (' + n2 + ')</button></div>' +
      (state.pedirTab === 'pedir' ? areaChips('pedir-area', state.pedirArea) + pedirList() : viewVerificar());
  }

  /* ---------- Reportes: lista de retiro y pérdidas ---------- */
  function retiroList() {
    let l = activeLots().filter((x) => x.dRem <= state.retiroDays);
    if (state.retiroArea) l = l.filter((x) => x.area === state.retiroArea);
    return l.sort((a, b) => a.dExp - b.dExp || a.name.localeCompare(b.name));
  }
  const retiroName = () => 'Retiro_' + D.toISO(T()) + '.pdf';
  function viewRetiro() {
    const list = retiroList();
    const sg = (d, t) => '<button class="' + (state.retiroDays === d ? 'on' : '') + '" data-action="retiro-days" data-d="' + d + '">' + t + '</button>';
    let h = '<div class="card"><div class="small muted" style="margin-bottom:8px">Lotes que hay que sacar de la góndola (retiro = vencimiento − ' + state.settings.removeBefore + (state.settings.removeBefore === 1 ? ' día' : ' días') + ').</div>' +
      '<div class="seg">' + sg(0, 'Hoy') + sg(1, 'Hasta mañana') + sg(3, 'Hasta 3 días') + '</div></div>' + areaChips('retiro-area', state.retiroArea);
    if (!list.length) return h + '<div class="empty">Nada para retirar en este rango 👌</div>';
    ['atendida', 'autoservicio'].forEach((ar) => {
      const al = list.filter((x) => x.area === ar);
      if (!al.length) return;
      h += '<div class="areahead ' + ar + '">' + AREAS[ar].name + ' · ' + al.length + '</div>' + al.map(lotCard).join('');
    });
    return h + '<div class="actionbar"><button class="btn primary block" data-action="retiro-pdf">PDF de retiro (' + list.length + ')</button></div>';
  }
  function retiroSheet() {
    const n = retiroList().length;
    if (!n) return toast('No hay lotes en la lista');
    openSheet('<h2>📄 Lista de retiro</h2><p class="muted small">' + n + (n === 1 ? ' lote' : ' lotes') + ' · ' + esc(retiroName()) + '</p>' +
      '<div class="row wrap"><button class="btn primary grow" data-action="retiro-share">Compartir</button><button class="btn grow" data-action="retiro-download">Descargar</button></div>' +
      '<button class="btn block" style="margin-top:8px" data-action="close-sheet">Cerrar</button>');
  }
  function periodRange() {
    const t = T(), iso = D.toISO(t);
    if (state.period === 'month') return [iso.slice(0, 8) + '01', iso];
    if (state.period === 'prev') return [D.toISO(new Date(t.getFullYear(), t.getMonth() - 1, 1)), D.toISO(new Date(t.getFullYear(), t.getMonth(), 0))];
    if (state.period === '30') return [D.toISO(D.addDays(t, -29)), iso];
    return ['0000-00-00', '9999-99-99'];
  }
  function sumByUnit(arr) { const o = {}; arr.forEach((r) => { const u = r.snap.unit === 'kg' ? 'kg' : 'und'; o[u] = (o[u] || 0) + r.qty; }); return o; }
  function sumText(o) { const p = []; if (o.und) p.push(qtyText(o.und, 'und')); if (o.kg) p.push(qtyText(o.kg, 'kg')); return p.length ? p.join(' · ') : '0'; }
  const rrow = (a, b) => '<div class="rrow"><span>' + a + '</span><b>' + b + '</b></div>';
  function periodRecords() {
    const rg = periodRange();
    return state.removals.filter((r) => r.date >= rg[0] && r.date <= rg[1]).sort((a, b) => a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id);
  }
  function viewPerdidas() {
    const recs = periodRecords();
    const pc = (k, t) => '<button class="chip ' + (state.period === k ? 'on' : '') + '" data-action="period" data-p="' + k + '">' + t + '</button>';
    let h = '<div class="chips">' + pc('month', 'Este mes') + pc('prev', 'Mes pasado') + pc('30', 'Últimos 30 días') + pc('all', 'Todo') + '</div>';
    if (!recs.length) return h + '<div class="empty">Aún no hay retiros en este período.<br><span class="small">Se registran al tocar “Retirar” en un lote.</span></div>';
    const mer = recs.filter((r) => r.reason === 'merma');
    h += '<div class="stats"><div class="stat"><b>' + recs.length + '</b><span>Retiros · ' + esc(sumText(sumByUnit(recs))) + '</span></div>' +
      '<div class="stat red"><b>' + mer.length + '</b><span>Mermas · ' + esc(sumText(sumByUnit(mer))) + '</span></div></div>';
    h += '<div class="card"><b>Por motivo</b>';
    Object.keys(REASON_SHORT).forEach((k) => {
      const a = recs.filter((r) => r.reason === k);
      if (a.length) h += rrow(esc(REASON_SHORT[k]), esc(sumText(sumByUnit(a))) + ' <span class="muted small">(' + a.length + ')</span>');
    });
    h += '</div><div class="card"><b>Por área</b>';
    ['atendida', 'autoservicio'].forEach((ar) => {
      const a = recs.filter((r) => areaOf(r.snap) === ar);
      if (!a.length) return;
      h += rrow(areaTag(ar), esc(sumText(sumByUnit(a))) + ' <span class="muted small">· merma ' + esc(sumText(sumByUnit(a.filter((r) => r.reason === 'merma')))) + '</span>');
    });
    h += '</div>';
    if (mer.length) {
      const g = {};
      mer.forEach((r) => { const k = r.snap.supplier || 'Sin proveedor'; (g[k] = g[k] || []).push(r); });
      h += '<div class="card"><b>Mermas por proveedor</b>';
      Object.keys(g).sort((x, y) => g[y].length - g[x].length).forEach((k) => { h += rrow(esc(k), esc(sumText(sumByUnit(g[k]))) + ' <span class="muted small">(' + g[k].length + ')</span>'); });
      h += '</div>';
    }
    h += '<h3>Últimos retiros</h3>' + recs.slice(0, 15).map((r) => '<div class="plot ar-' + areaOf(r.snap) + '" style="border-left-color:var(--line)">' + areaTag(areaOf(r.snap)) +
      ' <b>' + esc(r.snap.name) + '</b> <span class="tag' + (r.reason === 'merma' ? ' bad' : '') + '">' + esc(REASON_SHORT[r.reason] || r.reason) + '</span>' +
      '<div class="lot-sub">' + D.fmt(D.fromISO(r.date)) + ' · ' + esc(qtyText(r.qty, r.snap.unit)) + (r.snap.lot ? ' · Lote ' + esc(r.snap.lot) : '') + (r.note ? ' · ' + esc(r.note) : '') + '</div></div>').join('');
    return h + '<button class="btn block" style="margin-top:12px" data-action="export-csv">Exportar a Excel (CSV)</button>';
  }
  async function exportCSV() {
    const recs = periodRecords().slice().reverse();
    if (!recs.length) return toast('No hay retiros en este período');
    const rows = [['Fecha', 'Área', 'Producto', 'Código', 'Lote', 'Proveedor', 'Cantidad', 'Unidad', 'Motivo', 'Nota']];
    recs.forEach((r) => rows.push([r.date, AREAS[areaOf(r.snap)].name, r.snap.name, r.snap.code, r.snap.lot, r.snap.supplier, String(r.qty).replace('.', ','), r.snap.unit, REASON_SHORT[r.reason] || r.reason, r.note]));
    await shareOrDownload(csvBlob(rows), 'retiros_' + D.toISO(T()) + '.csv', 'text/csv', 'Retiros');
  }
  function viewReports() {
    return '<h2>Reportes</h2><div class="subtabs">' +
      '<button class="' + (state.repTab === 'retiro' ? 'on' : '') + '" data-action="rep-tab" data-t="retiro">Retiro del día</button>' +
      '<button class="' + (state.repTab === 'perdidas' ? 'on' : '') + '" data-action="rep-tab" data-t="perdidas">Retiros y pérdidas</button></div>' +
      (state.repTab === 'retiro' ? viewRetiro() : viewPerdidas());
  }

  function viewSettings() {
    const s = state.settings, t = T();
    const hol = [];
    [t.getFullYear(), t.getFullYear() + 1].forEach((y) => { const h = D.holidays(y); Object.keys(h).sort().forEach((k) => { if (k >= D.toISO(t)) hol.push([k, h[k]]); }); });
    return '<h2>Ajustes</h2>' +
      '<div class="card"><label class="f" style="margin-top:0">Ventana de “Pedir precios” (días hasta el vencimiento)</label>' +
      '<input type="number" min="1" max="60" data-setting="windowDays" value="' + s.windowDays + '">' +
      '<label class="f">Retirar el producto N días antes de vencer</label>' +
      '<input type="number" min="0" max="7" data-setting="removeBefore" value="' + s.removeBefore + '"></div>' +
      '<div class="card"><b>Temporada de promoción</b><p class="small muted" style="margin:4px 0 8px">Mientras esté activa, se pide martes y viernes (igual que con lunes festivo).</p>' +
      '<label class="row small"><input type="checkbox" style="width:auto" data-setting="promoManual"' + (s.promoManual ? ' checked' : '') + '> Activar ahora (manual)</label>' +
      '<div class="row" style="margin-top:8px"><div class="grow"><label class="f" style="margin-top:0">Desde</label><input type="date" data-setting="promoFrom" value="' + esc(s.promoFrom) + '"></div>' +
      '<div class="grow"><label class="f" style="margin-top:0">Hasta</label><input type="date" data-setting="promoTo" value="' + esc(s.promoTo) + '"></div></div></div>' +
      '<div class="card"><b>Próximos festivos (Colombia)</b><ul class="small" style="margin:6px 0 0;padding-left:18px">' +
      hol.slice(0, 6).map((x) => '<li>' + D.fmtFull(D.fromISO(x[0])) + ' — ' + esc(x[1]) + '</li>').join('') + '</ul></div>' +
      '<div class="card"><b>Extras</b>' +
      '<button class="btn block" style="margin-top:10px" data-action="cat-open">📦 Catálogo de productos (' + state.products.length + ')</button>' +
      '<label class="row small" style="margin-top:14px"><input type="checkbox" style="width:auto" data-setting="scalesOn"' + (s.scalesOn ? ' checked' : '') + '> <b>⚖️ Códigos de balanzas</b></label>' +
      '<p class="small muted" style="margin:4px 0 0">Agrega una pestaña para guardar nombre, código y proveedor de los productos de balanza (autoservicio y atendida).</p></div>' +
      '<div class="card"><b>Copia de seguridad</b><p class="small muted" style="margin:4px 0 10px">Tus datos (incluidas las fotos) viven solo en este teléfono. Exporta una copia de vez en cuando.</p>' +
      (() => { const ph = state.products.filter((p) => p.photo); const kb = ph.reduce((a, p) => a + (p.photo.length + (p.thumb || '').length) * 0.75 / 1024, 0); return ph.length ? '<p class="small muted" style="margin:-4px 0 10px">📷 ' + ph.length + (ph.length === 1 ? ' foto' : ' fotos') + ' guardadas · ' + (kb >= 1024 ? (kb / 1024).toFixed(1) + ' MB' : Math.round(kb) + ' KB') + ' (se incluyen en la copia)</p>' : ''; })() +
      '<div class="row wrap"><button class="btn grow" data-action="export">Exportar copia</button><button class="btn grow" data-action="import">Importar copia</button></div>' +
      '<input type="file" id="importFile" accept=".json,application/json" class="hidden"><p class="small muted" id="persistInfo" style="margin:10px 0 0"></p></div>' +
      '<div class="card"><b>Instalar en el teléfono</b><p class="small muted" style="margin:4px 0 0">iPhone: Safari → Compartir → “Agregar a pantalla de inicio”.<br>Android: Chrome → menú ⋮ → “Instalar app”.<br>Ábrela una vez con internet para que funcione sin conexión.</p></div>' +
      '<button class="btn danger block" data-action="wipe">Borrar todos los datos</button>';
  }

  function render() {
    const y = $('#view').scrollTop;
    const v = $('#view');
    if (state.tab === 'scales' && !state.settings.scalesOn) state.tab = 'home';
    $('#tabScales').classList.toggle('hidden', !state.settings.scalesOn);
    v.innerHTML = state.tab === 'home' ? viewHome() : state.tab === 'add' ? viewAdd() : state.tab === 'pedir' ? viewPedir() : state.tab === 'reports' ? viewReports() :
      state.tab === 'catalog' ? viewCatalog() : state.tab === 'scales' ? viewScales() : viewSettings();
    const hl = state.tab === 'catalog' ? 'settings' : state.tab;
    document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === hl));
    updateBadges();
    $('#view').scrollTop = y;
    if (state.tab === 'settings') updatePersistInfo();
  }
  function setTab(t) { state.tab = t; if (t !== 'add') { state.editingLotId = null; } render(); $('#view').scrollTop = 0; }

  /* ===================== Sheet / toast ===================== */
  function openSheet(html) {
    const s = $('#sheet');
    s.innerHTML = '<div class="sheet-bg" data-action="close-sheet"></div><div class="sheet-card">' + html + '</div>';
    s.classList.remove('hidden');
  }
  function closeSheet() { $('#sheet').classList.add('hidden'); $('#sheet').innerHTML = ''; }
  let toastTimer;
  function toast(msg, label, fn) {
    const t = $('#toast');
    t.innerHTML = '<span>' + esc(msg) + '</span>' + (label ? '<button type="button">' + esc(label) + '</button>' : '');
    t.classList.remove('hidden');
    if (label) t.querySelector('button').onclick = () => { t.classList.add('hidden'); fn && fn(); };
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), label ? 6000 : 3200);
  }

  /* ===================== Acciones sobre datos ===================== */
  async function saveLot(again) {
    const g = (id) => ($('#' + id).value || '').trim();
    const name = g('f-name'), code = g('f-code').replace(/\s+/g, ''), supplier = g('f-supplier'), lotNo = g('f-lot'), expiry = g('f-exp');
    const unit = (document.querySelector('input[name=f-unit]:checked') || {}).value || 'und';
    const area = (document.querySelector('input[name=f-area]:checked') || {}).value || 'atendida';
    const qty = parseFloat(g('f-qty').replace(',', '.'));
    const codeType = code ? (g('f-ctype') || guessType(code)) : '';
    if (!name) return toast('Falta el nombre');
    if (!expiry) return toast('Falta la fecha de vencimiento');
    if (!(qty > 0)) return toast('Falta la cantidad');
    const edit = state.editingLotId ? lotById(state.editingLotId) : null;
    let prod = edit ? prodById(edit.productId)
      : (code ? state.products.find((p) => p.code === code) : state.products.find((p) => norm(p.name) === norm(name)));
    // código de balanza (extra): se valida antes de guardar nada
    const sfCode = state.settings.scalesOn && $('#sf-code') ? $('#sf-code').value.trim() : '';
    const sfCat = area === 'atendida' && $('#sf-cat') ? $('#sf-cat').value : '';
    let sfEx = null;
    if (sfCode) {
      sfEx = prod ? state.scales.find((x) => x.productId === prod.id && x.area === area) || null : null;
      const clash = state.scales.find((x) => x.id !== (sfEx && sfEx.id) && x.area === area && scatOf(x) === (area === 'atendida' ? sfCat || 'res' : '') && norm(x.code) === norm(sfCode));
      if (clash) return toast('Ese código de balanza ya existe en ' + scaleLabel(clash) + ': ' + sv(clash).name);
    }
    const photo = photoBuf.f || (photoCleared.f ? '' : ((prod && prod.photo) || ''));
    const thumb = photoBuf.f ? thumbBuf.f : (photoCleared.f ? '' : ((prod && prod.thumb) || ''));
    const data = { name: name, code: code, codeType: codeType, unit: unit, supplier: supplier, photo: photo, thumb: thumb };
    if (prod) { Object.assign(prod, data); await put('products', prod); }
    else { prod = Object.assign({}, data); prod.id = await put('products', prod); }
    if (sfCode) {
      const o = sfEx || { createdAt: Date.now() };
      Object.assign(o, { area: area, cat: area === 'atendida' ? sfCat || 'res' : '', name: name, code: sfCode, plu: codeType === 'PLU' ? code : '', supplier: supplier, productId: prod.id });
      await put('scales', o); if (o.cat) state.lastScaleCat = o.cat;
    }
    state.lastArea = area;
    if (edit) { Object.assign(edit, { lot: lotNo, expiry: expiry, qty: qty, area: area }); await put('lots', edit); }
    else await put('lots', { productId: prod.id, area: area, lot: lotNo, expiry: expiry, qty: qty, status: 'active', reqType: 'precio', reqNote: '', sale: null, lastFail: null, createdAt: Date.now() });
    await reload();
    if (edit) { state.editingLotId = null; state.tab = 'home'; toast('Cambios guardados'); }
    else if (again) { state.draft = { supplier: supplier, area: area }; toast('Guardado. Agrega el siguiente'); }
    else { state.draft = {}; state.tab = 'home'; toast('Lote guardado'); }
    render(); $('#view').scrollTop = 0;
  }

  function openRemoveSheet(id) {
    const l = activeLots().find((x) => x.id === id); if (!l) return;
    const full = String(l.qty).replace('.', ',');
    const opts = Object.keys(REASONS).map((k) => '<option value="' + k + '"' + (state.lastReason === k ? ' selected' : '') + '>' + esc(REASONS[k]) + '</option>').join('');
    openSheet('<h2>Retirar lote</h2><div class="card">' + areaTag(l.area) + ' <b>' + esc(l.name) + '</b><div class="lot-sub">' +
      (l.lot ? 'Lote ' + esc(l.lot) + ' · ' : '') + 'Hay ' + esc(qtyText(l.qty, l.unit)) + ' · vence ' + D.fmt(D.fromISO(l.expiry)) + '</div></div>' +
      '<label class="f" style="margin-top:0" for="rm-qty">Cantidad a retirar (' + (l.unit === 'kg' ? 'kg' : 'und') + ')</label>' +
      '<div class="row"><input id="rm-qty" type="text" inputmode="decimal" class="grow" value="' + esc(full) + '"><button type="button" class="btn-mini" data-action="rm-all" data-q="' + esc(full) + '">Todo</button></div>' +
      '<label class="f" for="rm-reason">Motivo</label><select id="rm-reason">' + opts + '</select>' +
      '<label class="f" for="rm-note">Nota (opcional)</label><input id="rm-note" placeholder="Ej: empaque roto">' +
      '<div class="row wrap" style="margin-top:14px"><button class="btn primary grow" data-action="rm-confirm" data-id="' + id + '">Confirmar retiro</button>' +
      '<button class="btn grow" data-action="close-sheet">Cancelar</button></div>');
  }
  async function confirmRemove(id) {
    const l = lotById(id); if (!l) return;
    const p = prodById(l.productId) || {};
    let q = parseFloat(String($('#rm-qty').value || '').replace(',', '.'));
    if (!(q > 0)) return toast('Escribe la cantidad a retirar');
    const reason = $('#rm-reason').value, note = ($('#rm-note').value || '').trim();
    if (q > l.qty) q = l.qty;
    const full = q >= l.qty - 1e-9;
    const prevQty = l.qty, prevStatus = l.status, unit = p.unit || 'und';
    const rec = { date: D.toISO(T()), lotId: l.id, qty: q, reason: reason, note: note, createdAt: Date.now(),
      snap: { name: p.name || '', code: p.code || '', supplier: p.supplier || '', area: areaOf(l), lot: l.lot || '', expiry: l.expiry, unit: unit } };
    rec.id = await put('removals', rec);
    if (full) { l.status = 'removed'; l.removedAt = rec.date; } else { l.qty = Math.round((l.qty - q) * 1000) / 1000; }
    await put('lots', l);
    state.lastReason = reason;
    await reload(); closeSheet(); render();
    toast(full ? 'Lote retirado' : 'Retiraste ' + qtyText(q, unit) + '. Quedan ' + qtyText(l.qty, unit), 'Deshacer', async () => {
      await del('removals', rec.id);
      const x = lotById(id);
      if (x) { x.qty = prevQty; x.status = prevStatus; x.removedAt = null; await put('lots', x); }
      await reload(); render();
    });
  }
  async function deleteLot(id) {
    if (!confirm('¿Eliminar este lote? No se puede deshacer.')) return;
    await del('lots', id); await reload(); closeSheet(); render(); toast('Lote eliminado');
  }

  async function setCheck(roundId, lotId, val) {
    const r = state.rounds.find((x) => x.id === roundId); if (!r) return;
    const it = r.items.find((i) => i.lotId === lotId); if (!it) return;
    it.check = val;
    const lot = lotById(lotId);
    if (lot) {
      if (val === 'ok') { lot.sale = { type: it.type, note: it.price || it.note || '', date: D.toISO(T()), end: it.saleEnd || '' }; lot.lastFail = null; }
      else if (val === 'no') { lot.sale = null; lot.lastFail = D.toISO(T()); }
      else lot.sale = null;
      await put('lots', lot);
    }
    await put('rounds', r);
    const wasOpen = true; await reload();
    const rr = state.rounds.find((x) => x.id === roundId);
    if (wasOpen && rr && !isOpen(rr)) toast('Ronda completa ✅');
    render();
  }

  /* ===================== PDF ===================== */
  const AREA_COL = { atendida: [37, 99, 235], autoservicio: [147, 51, 234] };
  const URG_COL = { red: [220, 38, 38], orange: [234, 88, 12], yellow: [202, 138, 4], green: [22, 163, 74] };
  function pdfFooters(doc, W, H, M) {
    const n = doc.getNumberOfPages();
    for (let p = 1; p <= n; p++) {
      doc.setPage(p); doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(120);
      doc.text('Página ' + p + ' de ' + n, W - M, H - 6, { align: 'right' });
      doc.text('Generado con Rotador', M, H - 6);
    }
  }
  // Pedir precios: una tarjeta (mini tabla de 2 columnas) por producto, 2 tarjetas por fila.
  function buildPDF(round) {
    const J = window.jspdf.jsPDF;
    const doc = new J({ unit: 'mm', format: 'letter' });
    const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight(), M = 12, GAP = 6;
    const CW = (W - 2 * M - GAP) / 2, LW = 25, HH = 7, LH = 3.7;
    const rd = D.fromISO(round.date), before = state.settings.removeBefore, items = round.items;
    const areaOfItem = (i) => (i.snap.area === 'autoservicio' ? 'autoservicio' : 'atendida');
    let y = M;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(16); doc.setTextColor(0); doc.text('Rotador · Pedir precios', M, y + 5); y += 9;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10);
    doc.text('Fecha: ' + D.fmtFull(rd) + '   ·   Verificar: ' + D.fmtFull(D.fromISO(round.verifyDate)), M, y + 3); y += 6;
    const n2 = items.filter((i) => i.type === '2x1').length;
    const nA = items.filter((i) => areaOfItem(i) === 'atendida').length;
    doc.text(items.length + (items.length === 1 ? ' lote' : ' lotes') + ': ' + (items.length - n2) + ' para precio · ' + n2 + ' para 2x1', M, y + 3); y += 5;
    doc.text('Atendida: ' + nA + '   ·   Autoservicio: ' + (items.length - nA), M, y + 3); y += 10;

    function prep(i) {
      const s = i.snap, dRem = D.diffDays(rd, D.fromISO(s.expiry)) - before;
      const raw = [
        ['Nombre', s.name || '', null, true],
        [s.codeType === 'EAN' ? 'EAN' : 'PLU', s.code ? String(s.code) : '—'],
        ['Lote', s.lot || '—'],
        ['Vencimiento', D.fmtFull(D.fromISO(s.expiry))],
        ['Retirar el', D.fmt(D.addDays(D.fromISO(s.expiry), -before)), D.urgency(dRem)],
        ['Cantidad', qtyText(s.qty, s.unit)],
        ['Proveedor', s.supplier || 'Sin proveedor']
      ];
      if (i.note) raw.push(['Nota', i.note]);
      let h = HH;
      const rows = raw.map((r) => {
        doc.setFont('helvetica', r[3] ? 'bold' : 'normal'); doc.setFontSize(9);
        const lines = doc.splitTextToSize(String(r[1]), CW - LW - (r[2] ? 7.7 : 3.5));
        const rh = Math.max(1, lines.length) * LH + 2.1;
        h += rh;
        return { label: r[0], lines: lines, urg: r[2], bold: !!r[3], h: rh };
      });
      return { item: i, rows: rows, h: h };
    }
    function drawCard(x, y0, c) {
      const ac = AREA_COL[areaOfItem(c.item)];
      doc.setFillColor(ac[0], ac[1], ac[2]); doc.rect(x, y0, CW, HH, 'F');
      doc.setFont('helvetica', 'bold'); doc.setFontSize(9.5); doc.setTextColor(255);
      doc.text(c.item.type === '2x1' ? 'PEDIR 2x1' : 'PEDIR PRECIO', x + 2.5, y0 + 4.9);
      let yy = y0 + HH;
      doc.setLineWidth(0.2);
      c.rows.forEach((r) => {
        doc.setFillColor(238, 243, 241); doc.rect(x, yy, LW, r.h, 'F');
        doc.setDrawColor(200); doc.line(x, yy + r.h, x + CW, yy + r.h); doc.line(x + LW, yy, x + LW, yy + r.h);
        doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5); doc.setTextColor(70); doc.text(r.label, x + 2, yy + 4);
        doc.setFont('helvetica', r.bold ? 'bold' : 'normal'); doc.setFontSize(9); doc.setTextColor(0);
        let tx = x + LW + 2;
        if (r.urg) { const u = URG_COL[r.urg]; doc.setFillColor(u[0], u[1], u[2]); doc.circle(x + LW + 3.4, yy + r.h / 2, 1.3, 'F'); tx = x + LW + 6.2; }
        doc.text(r.lines, tx, yy + 4);
        yy += r.h;
      });
      doc.setDrawColor(ac[0], ac[1], ac[2]); doc.setLineWidth(0.5); doc.rect(x, y0, CW, yy - y0); doc.setLineWidth(0.2);
    }
    ['atendida', 'autoservicio'].forEach((ar) => {
      const arr = items.filter((i) => areaOfItem(i) === ar).sort((a, b) => a.snap.expiry < b.snap.expiry ? -1 : a.snap.expiry > b.snap.expiry ? 1 : (a.snap.name || '').localeCompare(b.snap.name || ''));
      if (!arr.length) return;
      const ac = AREA_COL[ar];
      const band = (cont) => {
        doc.setFillColor(ac[0], ac[1], ac[2]); doc.rect(M, y, W - 2 * M, 9, 'F');
        doc.setTextColor(255); doc.setFont('helvetica', 'bold'); doc.setFontSize(13);
        doc.text(AREAS[ar].name.toUpperCase() + '  ·  ' + arr.length + (arr.length === 1 ? ' lote' : ' lotes') + (cont ? '  (continuación)' : ''), M + 3, y + 6.3);
        y += 12; doc.setTextColor(0);
      };
      const pairs = [];
      for (let k = 0; k < arr.length; k += 2) pairs.push(arr.slice(k, k + 2).map(prep));
      pairs.forEach((pair, idx) => {
        const rh = Math.max.apply(null, pair.map((c) => c.h));
        if (idx === 0) { if (y + 12 + rh > H - 14) { doc.addPage(); y = M; } band(false); }
        else if (y + rh > H - 14) { doc.addPage(); y = M; band(true); }
        pair.forEach((c, k) => drawCard(M + k * (CW + GAP), y, c));
        y += rh + 5;
      });
      y += 3;
    });
    pdfFooters(doc, W, H, M);
    return doc;
  }
  // Lista de retiro: tabla con casilla para marcar a mano, separada por área.
  function buildRetiroPDF(list) {
    const J = window.jspdf.jsPDF;
    const doc = new J({ unit: 'mm', format: 'letter' });
    const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight(), M = 12, LH = 3.7;
    const cols = [{ t: 'Ok', w: 9 }, { t: 'Producto', w: 56 }, { t: 'Código', w: 28 }, { t: 'Lote', w: 20 }, { t: 'Vence', w: 26 }, { t: 'Cant.', w: 20 }, { t: 'Proveedor', w: W - 2 * M - 159 }];
    const lim = state.retiroDays;
    let y = M;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(16); doc.setTextColor(0); doc.text('Rotador · Lista de retiro', M, y + 5); y += 9;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10);
    doc.text('Fecha: ' + D.fmtFull(T()) + '   ·   Incluye: ' + (lim === 0 ? 'retirar hoy o atrasados' : lim === 1 ? 'hasta mañana' : 'hasta ' + lim + ' días'), M, y + 3); y += 6;
    doc.text(list.length + (list.length === 1 ? ' lote' : ' lotes') + ' para sacar de la góndola', M, y + 3); y += 10;
    ['atendida', 'autoservicio'].forEach((ar) => {
      const arr = list.filter((l) => l.area === ar);
      if (!arr.length) return;
      const ac = AREA_COL[ar];
      const band = (cont) => {
        doc.setFillColor(ac[0], ac[1], ac[2]); doc.rect(M, y, W - 2 * M, 9, 'F');
        doc.setTextColor(255); doc.setFont('helvetica', 'bold'); doc.setFontSize(13);
        doc.text(AREAS[ar].name.toUpperCase() + '  ·  ' + arr.length + (arr.length === 1 ? ' lote' : ' lotes') + (cont ? '  (continuación)' : ''), M + 3, y + 6.3);
        y += 12; doc.setTextColor(0);
      };
      const header = () => {
        doc.setFillColor(229, 236, 233); doc.rect(M, y, W - 2 * M, 6, 'F');
        doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5); doc.setTextColor(30);
        let x = M; cols.forEach((c) => { doc.text(c.t, x + 1.5, y + 4.2); x += c.w; }); y += 6.5;
      };
      if (y + 12 + 20 > H - 14) { doc.addPage(); y = M; }
      band(false); header();
      arr.forEach((l) => {
        doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
        const nl = doc.splitTextToSize(l.name || '', cols[1].w - 3), sl = doc.splitTextToSize(l.supplier || '', cols[6].w - 3);
        const rh = Math.max(nl.length, sl.length, 1) * LH + 3.2;
        if (y + rh > H - 14) { doc.addPage(); y = M; band(true); header(); }
        doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(0);
        let x = M;
        doc.setDrawColor(90); doc.setLineWidth(0.3); doc.rect(x + 2.6, y + 1.3, 4, 4); x += cols[0].w;
        doc.text(nl, x + 1.5, y + 4.2); x += cols[1].w;
        doc.text(String(l.code || '—'), x + 1.5, y + 4.2); x += cols[2].w;
        doc.text(String(l.lot || '—'), x + 1.5, y + 4.2); x += cols[3].w;
        const u = URG_COL[l.urg]; doc.setFillColor(u[0], u[1], u[2]); doc.circle(x + 2.6, y + 3.3, 1.3, 'F');
        doc.text(D.fmt(D.fromISO(l.expiry)), x + 5.4, y + 4.2); x += cols[4].w;
        doc.text(qtyText(l.qty, l.unit), x + 1.5, y + 4.2); x += cols[5].w;
        doc.text(sl, x + 1.5, y + 4.2);
        doc.setDrawColor(220); doc.setLineWidth(0.2); doc.line(M, y + rh, W - M, y + rh);
        y += rh + 0.4;
      });
      y += 6;
    });
    if (y + 14 > H - 14) { doc.addPage(); y = M; }
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(0);
    doc.text('Responsable: ______________________________        Hora: __________', M, y + 6);
    pdfFooters(doc, W, H, M);
    return doc;
  }
  const pdfName = (r) => 'Pedir-precios_' + r.date + '.pdf';
  function downloadBlob(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  async function shareOrDownload(blob, name, type, title) {
    const file = new File([blob], name, { type: type });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: title }); return; }
      catch (e) { if (e && e.name === 'AbortError') return; }
    }
    downloadBlob(blob, name);
  }
  function reportSheet(round) {
    openSheet('<h2>📄 Reporte listo</h2><p class="muted small">' + round.items.length + ' lotes · ' + esc(pdfName(round)) + '</p>' +
      '<div class="row wrap"><button class="btn primary grow" data-action="pdf-share" data-round="' + round.id + '">Compartir</button>' +
      '<button class="btn grow" data-action="pdf-download" data-round="' + round.id + '">Descargar</button></div>' +
      '<button class="btn block" style="margin-top:8px" data-action="close-sheet">Cerrar</button>');
  }
  async function generateRound() {
    const list = porPedirArea();
    if (!list.length) return toast('No hay lotes por pedir');
    const t = T(), iso = D.toISO(t);
    const items = list.map((l) => ({
      lotId: l.id, type: l.reqType === '2x1' ? '2x1' : 'precio', note: l.reqNote || '', check: 'pending', price: '',
      snap: { area: l.area, name: l.name, code: l.code, codeType: l.codeType, supplier: l.supplier, lot: l.lot, expiry: l.expiry, qty: l.qty, unit: l.unit }
    }));
    let round = state.rounds.find((r) => r.date === iso && isOpen(r));
    if (round) { round.items = round.items.concat(items); await put('rounds', round); }
    else {
      round = { date: iso, verifyDate: D.toISO(D.verifyDay(t)), createdAt: Date.now(), items: items };
      round.id = await put('rounds', round);
    }
    await reload();
    state.pedirTab = 'verificar'; render();
    reportSheet(state.rounds.find((r) => r.id === round.id) || round);
  }

  /* ===================== Escáner ===================== */
  let scanner = null;
  const SCAN_FORMATS = () => { const F = window.Html5QrcodeSupportedFormats; return [F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E, F.CODE_128, F.CODE_39, F.ITF, F.QR_CODE, F.DATA_MATRIX]; };
  const scanPref = () => { try { return localStorage.getItem('rotador.scanNative') !== '0'; } catch (e) { return true; } };
  const setScanPref = (v) => { try { localStorage.setItem('rotador.scanNative', v ? '1' : '0'); } catch (e) { /* ignorar */ } };
  let scanCb = null, scanHintTimer = null, torchOn = false;

  // Etiquetas de balanza (EAN-13 que empieza con 2): llevan el PLU dentro del código. Si coincide con un solo PLU
  // conocido (catálogo o balanzas) se usa ese PLU; si hay duda se deja el código tal cual.
  function resolveScan(c) {
    // UPC-A (12 dígitos) y EAN-13 que empieza con 0 son el mismo código: se usa la forma que ya esté guardada.
    if (/^\d{12}$/.test(c) && state.products.some((p) => p.code === '0' + c)) return '0' + c;
    if (/^0\d{12}$/.test(c) && state.products.some((p) => p.code === c.slice(1))) return c.slice(1);
    if (/^\d{12}$/.test(c) && !state.products.some((p) => p.code === c)) c = '0' + c;
    if (!/^2\d{12}$/.test(c) || state.products.some((p) => p.code === c)) return c;
    const pool = state.products.filter((p) => p.codeType === 'PLU' && /^\d+$/.test(p.code)).map((p) => p.code)
      .concat(state.scales.map((x) => sv(x).plu).filter((x) => /^\d+$/.test(x)));
    const found = new Set();
    [3, 4, 5, 6].forEach((L) => { const n = String(Number(c.slice(1, 1 + L))); pool.forEach((pl) => { if (String(Number(pl)) === n) found.add(pl); }); });
    if (found.size === 1) { const pl = Array.from(found)[0]; toast('Etiqueta de balanza · PLU ' + pl); return pl; }
    return c;
  }
  function onScanned(text) {
    const pl = Cat.parseScan(text), c = resolveScan(pl.code || String(text).trim());
    closeScanner().then(() => {
      if (scanCb) scanCb(c);
      else {
        const i = $('#f-code'); if (i) { i.value = c; onCodeInput(); }
        // QR / DataMatrix con más datos: rellena lote y vencimiento
        const got = [];
        if (pl.lot && $('#f-lot')) { $('#f-lot').value = pl.lot; got.push('lote ' + pl.lot); }
        if (pl.expiry && $('#f-exp')) { $('#f-exp').value = pl.expiry; got.push('vence ' + D.fmt(D.fromISO(pl.expiry))); }
        if (got.length) toast('Leído del código: ' + got.join(' · '));
      }
      if (navigator.vibrate) navigator.vibrate(60);
    });
  }
  async function openScanner(onCode) {
    if (!window.Html5Qrcode) return toast('El escáner no está disponible. Escribe el código.');
    scanCb = onCode || null; torchOn = false;
    $('#scanner').classList.remove('hidden');
    $('#scanTorch').classList.add('hidden');
    $('#scanHint').textContent = 'Apunta la cámara al código de barras o QR. Aléjate un poco hasta que enfoque.';
    clearTimeout(scanHintTimer);
    scanHintTimer = setTimeout(() => { $('#scanHint').textContent = '¿No lee? Prueba la linterna, “Cambiar lector” o “Foto del código”.'; }, 7000);
    try {
      scanner = new window.Html5Qrcode('reader', { formatsToSupport: SCAN_FORMATS(), useBarCodeDetectorIfSupported: scanPref(), verbose: false });
      await scanner.start({ facingMode: 'environment' }, {
        fps: 15,
        // zona de lectura ancha: el código no necesita quedar centrado ni encajar en un recuadro pequeño
        qrbox: (w, h) => ({ width: Math.max(60, Math.floor(w * 0.94)), height: Math.max(60, Math.floor(Math.min(h * 0.7, w * 0.62))) }),
        videoConstraints: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }
      }, (text) => onScanned(text), () => { /* sin lectura en este cuadro */ });
      try { await scanner.applyVideoConstraints({ advanced: [{ focusMode: 'continuous' }] }); } catch (e) { /* el teléfono no lo admite */ }
      try { if (scanner.getRunningTrackCameraCapabilities().torchFeature().isSupported()) $('#scanTorch').classList.remove('hidden'); } catch (e) { /* sin linterna */ }
    } catch (e) {
      await closeScanner();
      toast('No se pudo abrir la cámara. Revisa el permiso o usa “Foto del código”.');
    }
  }
  async function closeScanner() {
    clearTimeout(scanHintTimer);
    $('#scanner').classList.add('hidden');
    if (scanner) { try { await scanner.stop(); scanner.clear(); } catch (e) { /* ya detenido */ } scanner = null; }
  }
  async function toggleTorch() {
    try { const t = scanner.getRunningTrackCameraCapabilities().torchFeature(); torchOn = !torchOn; await t.apply(torchOn); $('#scanTorch').textContent = torchOn ? '🔦 Apagar linterna' : '🔦 Linterna'; }
    catch (e) { toast('No se pudo usar la linterna'); }
  }
  async function switchScanEngine() {
    setScanPref(!scanPref()); const cb = scanCb;
    await closeScanner(); await openScanner(cb);
    toast(scanPref() ? 'Lector del teléfono (rápido)' : 'Lector alternativo');
  }
  // Foto con la cámara nativa del teléfono (enfoque y resolución completos): suele leer lo que el video en vivo no puede.
  async function scanFromPhoto(file) {
    if (!file) return;
    $('#scanHint').textContent = 'Leyendo la foto…';
    const tmp = new window.Html5Qrcode('scanTmp', { formatsToSupport: SCAN_FORMATS(), useBarCodeDetectorIfSupported: false, verbose: false });
    const tryFile = async (f) => { try { return await tmp.scanFile(f, false); } catch (e) { return null; } };
    let r = await tryFile(file);
    // Reintentos: otros tamaños y más contraste ayudan con etiquetas térmicas pequeñas o desvaídas.
    if (!r) for (const v of await photoVariants(file)) { r = await tryFile(v); if (r) break; }
    try { tmp.clear(); } catch (e) { /* ignorar */ }
    if (r) onScanned(r);
    else { $('#scanHint').textContent = 'No se pudo leer el código en la foto. Acércate, enfoca las barras y que no haya reflejos.'; toast('No se encontró un código en la foto'); }
  }
  function photoVariants(file) {
    return new Promise((res) => {
      const url = URL.createObjectURL(file), img = new Image();
      img.onload = async () => {
        const out = [];
        for (const [w, filt] of [[1400, ''], [900, ''], [1400, 'grayscale(1) contrast(2.2)'], [600, 'grayscale(1) contrast(1.8)']]) {
          try {
            const sc = w / img.width, c = document.createElement('canvas'); c.width = Math.round(img.width * sc); c.height = Math.round(img.height * sc);
            const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); if (filt) g.filter = filt;
            g.drawImage(img, 0, 0, c.width, c.height);
            const b = await new Promise((r) => c.toBlob(r, 'image/png')); if (b) out.push(new File([b], 'v.png', { type: 'image/png' }));
          } catch (e) { /* variante no disponible */ }
        }
        URL.revokeObjectURL(url); res(out);
      };
      img.onerror = () => { URL.revokeObjectURL(url); res([]); };
      img.src = url;
    });
  }
  window.__scan = { onScanned: onScanned, resolveScan: resolveScan, scanFromPhoto: scanFromPhoto };

  /* ===================== Formulario: autocompletado ===================== */
  function fillFromProduct(p, force) {
    if (!p) return;
    if (force || !$('#f-name').value.trim()) $('#f-name').value = p.name || '';
    if (!$('#f-supplier').value.trim()) $('#f-supplier').value = p.supplier || '';
    const r = document.querySelector('input[name=f-unit][value="' + (p.unit || 'und') + '"]'); if (r) r.checked = true;
    if (p.photo && !photoBuf.f && !photoCleared.f) setPhoto('f', p.photo, false, p.thumb);
    const sc = $('#sf-code') && p.id ? state.scales.find((x) => x.productId === p.id) : null; // balanza ya registrada para este producto
    if (sc && !$('#sf-code').value.trim()) { $('#sf-code').value = sc.code; if (sc.cat && $('#sf-cat')) $('#sf-cat').value = sc.cat; }
    updateUnitLbl();
  }
  function onCodeInput() {
    const code = $('#f-code').value.replace(/\s+/g, '');
    if (!code) { $('#codeHint').textContent = ''; return; }
    $('#f-ctype').value = guessType(code);
    const p = code.length >= 3 ? state.products.find((x) => x.code === code) : null;
    $('#codeHint').textContent = p ? 'Producto conocido' : '';
    if (p && !state.editingLotId) fillFromProduct(p, true);
  }
  function onNameChange() {
    if (state.editingLotId || $('#f-code').value.trim()) return;
    const p = state.products.find((x) => norm(x.name) === norm($('#f-name').value));
    if (p) { $('#f-code').value = p.code || ''; if (p.codeType) $('#f-ctype').value = p.codeType; fillFromProduct(p, false); $('#codeHint').textContent = 'Producto conocido'; }
  }
  function updateUnitLbl() {
    const r = document.querySelector('input[name=f-unit]:checked');
    const l = $('#unitLbl'); if (l && r) l.textContent = r.value === 'kg' ? 'kg' : 'und';
  }

  /* ===================== Visor de fotos con zoom ===================== */
  const V = { s: 1, x: 0, y: 0, ptrs: new Map(), d0: 0, s0: 1, last: 0 };
  const vEl = () => ({ box: $('#viewer'), stage: $('#viewerStage'), img: $('#viewerImg') });
  function vApply() {
    const { stage, img } = vEl(); if (!img.naturalWidth) return;
    const fit = Math.min(stage.clientWidth / img.naturalWidth, stage.clientHeight / img.naturalHeight, 1) || 1;
    const w = img.naturalWidth * fit * V.s, h = img.naturalHeight * fit * V.s;
    const mx = Math.max(0, (w - stage.clientWidth) / 2), my = Math.max(0, (h - stage.clientHeight) / 2);
    V.x = Math.max(-mx, Math.min(mx, V.x)); V.y = Math.max(-my, Math.min(my, V.y));
    img.style.transform = 'translate(' + V.x + 'px,' + V.y + 'px) scale(' + V.s + ')';
    $('#vReset').textContent = Math.round(V.s * 100) + '%';
  }
  function vZoom(ns, px, py) { // zoom hacia el punto (px,py) relativo al centro del visor
    ns = Math.max(1, Math.min(8, ns)); const k = ns / V.s;
    V.x = px - (px - V.x) * k; V.y = py - (py - V.y) * k; V.s = ns; if (ns === 1) { V.x = 0; V.y = 0; } vApply();
  }
  function openViewer(src, title) {
    const { box, img } = vEl(); V.s = 1; V.x = 0; V.y = 0; V.ptrs.clear();
    $('#viewerTitle').textContent = title || 'Foto';
    img.onload = () => { vApply(); $('#viewerInfo').textContent = img.naturalWidth + '×' + img.naturalHeight + ' px · ' + Math.round(src.length * 0.75 / 1024) + ' KB'; };
    img.src = src; box.classList.remove('hidden');
  }
  function closeViewer() { $('#viewer').classList.add('hidden'); $('#viewerImg').removeAttribute('src'); V.ptrs.clear(); }
  function initViewer() {
    const { stage } = vEl();
    const rel = (e) => { const r = stage.getBoundingClientRect(); return { x: e.clientX - r.left - r.width / 2, y: e.clientY - r.top - r.height / 2 }; };
    stage.addEventListener('pointerdown', (e) => {
      try { stage.setPointerCapture(e.pointerId); } catch (x) { /* ignorar */ } V.ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (V.ptrs.size === 2) { const [a, b] = Array.from(V.ptrs.values()); V.d0 = Math.hypot(a.x - b.x, a.y - b.y); V.s0 = V.s; }
      const now = Date.now(); // doble toque: alterna entre ajustado y 3×
      if (V.ptrs.size === 1 && now - V.last < 300) { const p = rel(e); vZoom(V.s > 1.05 ? 1 : 3, p.x, p.y); V.last = 0; } else V.last = now;
    });
    stage.addEventListener('pointermove', (e) => {
      const prev = V.ptrs.get(e.pointerId); if (!prev) return;
      const cur = { x: e.clientX, y: e.clientY };
      if (V.ptrs.size === 1) { if (V.s > 1) { V.x += cur.x - prev.x; V.y += cur.y - prev.y; vApply(); } }
      else if (V.ptrs.size === 2) {
        V.ptrs.set(e.pointerId, cur); const [a, b] = Array.from(V.ptrs.values()), d = Math.hypot(a.x - b.x, a.y - b.y);
        const r = stage.getBoundingClientRect(); vZoom(V.s0 * d / (V.d0 || d), (a.x + b.x) / 2 - r.left - r.width / 2, (a.y + b.y) / 2 - r.top - r.height / 2);
      }
      V.ptrs.set(e.pointerId, cur);
    });
    const up = (e) => { V.ptrs.delete(e.pointerId); };
    stage.addEventListener('pointerup', up); stage.addEventListener('pointercancel', up);
    stage.addEventListener('wheel', (e) => { e.preventDefault(); const p = rel(e); vZoom(V.s * (e.deltaY < 0 ? 1.2 : 1 / 1.2), p.x, p.y); }, { passive: false });
    $('#vZoomIn').addEventListener('click', () => vZoom(V.s * 1.5, 0, 0));
    $('#vZoomOut').addEventListener('click', () => vZoom(V.s / 1.5, 0, 0));
    $('#vReset').addEventListener('click', () => vZoom(1, 0, 0));
    $('#viewerClose').addEventListener('click', closeViewer);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#viewer').classList.contains('hidden')) closeViewer(); });
    window.addEventListener('resize', vApply);
  }

  /* ===================== Fotos de producto ===================== */
  const PHOTO_MAX = 1600, PHOTO_Q = 0.85, THUMB_MAX = 256, THUMB_Q = 0.72;
  const photoBuf = { f: '', p: '' }, thumbBuf = { f: '', p: '' }, photoCleared = { f: false, p: false };
  const photoInner = (src) => src ? '<img src="' + esc(src) + '" alt="Foto del producto">' : '<span>Sin foto</span>';
  function photoWidget(k, src) {
    return '<div class="photo-box"><div class="photo-prev" id="pv-' + k + '" data-action="zoom-photo" data-k="' + k + '">' + photoInner(src) + '</div><div class="photo-btns">' +
      '<button type="button" class="btn-mini" data-action="photo-cam" data-k="' + k + '">📷 Tomar foto</button>' +
      '<button type="button" class="btn-mini" data-action="photo-gal" data-k="' + k + '">🖼️ Galería</button>' +
      '<button type="button" class="btn-mini' + (src ? '' : ' hidden') + '" id="pc-' + k + '" data-action="photo-clear" data-k="' + k + '">Quitar</button></div>' +
      '<input type="file" accept="image/*" capture="environment" class="hidden" id="ph-cam-' + k + '" data-photo="' + k + '">' +
      '<input type="file" accept="image/*" class="hidden" id="ph-gal-' + k + '" data-photo="' + k + '"></div>';
  }
  function setPhoto(k, src, cleared, thumb) {
    photoBuf[k] = src || ''; thumbBuf[k] = src ? (thumb || '') : ''; photoCleared[k] = !!cleared;
    const pv = $('#pv-' + k); if (pv) pv.innerHTML = photoInner(src);
    const pc = $('#pc-' + k); if (pc) pc.classList.toggle('hidden', !src);
  }
  // Foto en alta calidad (hasta 1600 px, JPEG 85 %) para poder ampliar detalles + miniatura liviana para las listas.
  function processPhoto(file) {
    return new Promise((res, rej) => {
      const url = URL.createObjectURL(file), img = new Image();
      img.onload = () => {
        const draw = (max) => {
          const sc = Math.min(1, max / Math.max(img.width, img.height));
          const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(img.width * sc)); c.height = Math.max(1, Math.round(img.height * sc));
          const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
          return c;
        };
        const full = draw(PHOTO_MAX).toDataURL('image/jpeg', PHOTO_Q), thumb = draw(THUMB_MAX).toDataURL('image/jpeg', THUMB_Q);
        URL.revokeObjectURL(url); res({ full: full, thumb: thumb });
      };
      img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('img')); };
      img.src = url;
    });
  }
  async function onPhotoFile(input) {
    const f = input.files && input.files[0]; if (!f) return;
    try { const r = await processPhoto(f); setPhoto(input.dataset.photo, r.full, false, r.thumb); }
    catch (e) { toast('No se pudo leer la foto'); }
    input.value = '';
  }

  /* ===================== Rebaja: fecha fin ===================== */
  function openSaleSheet(id) {
    const l = activeLots().find((x) => x.id === id); if (!l) return;
    const sl = l.sale || { type: l.reqType === '2x1' ? '2x1' : 'precio', note: '', end: '' };
    const seg = (v, t) => '<label><input type="radio" name="sl-type" value="' + v + '" hidden' + (sl.type === v ? ' checked' : '') + '><span class="segopt">' + t + '</span></label>';
    openSheet('<h2>🏷️ Rebaja</h2><div class="card">' + areaTag(l.area) + ' <b>' + esc(l.name) + '</b><div class="lot-sub">Vence ' + D.fmt(D.fromISO(l.expiry)) + '</div>' +
      (l.saleEnded ? '<span class="tag warn">La rebaja terminó el ' + esc(saleEndText(l)) + '</span>' : '') + '</div>' +
      '<label class="f" style="margin-top:0">Tipo</label><div class="seg">' + seg('precio', 'Precio') + seg('2x1', '2x1') + '</div>' +
      '<label class="f" for="sl-note">Precio nuevo o nota</label><input id="sl-note" value="' + esc(sl.note || '') + '">' +
      '<label class="f" for="sl-end">Fecha fin de rebaja</label><input id="sl-end" type="date" min="' + D.toISO(T()) + '" value="' + esc(sl.end || '') + '">' +
      '<p class="small muted" style="margin:6px 0 0">Al llegar esa fecha la app te avisa para quitar la etiqueta y el producto vuelve a “Pedir precios”. Sin fecha, la rebaja no termina sola.</p>' +
      '<div class="row wrap" style="margin-top:14px"><button class="btn primary grow" data-action="sale-save" data-id="' + id + '">Guardar rebaja</button>' +
      (l.sale ? '<button class="btn danger grow" data-action="sale-clear" data-id="' + id + '">Quitar rebaja</button>' : '') + '</div>' +
      '<button class="btn block" style="margin-top:8px" data-action="close-sheet">Cancelar</button>');
  }
  async function saveSale(id) {
    const l = lotById(id); if (!l) return;
    const end = ($('#sl-end').value || '').trim();
    if (end && end < D.toISO(T())) return toast('La fecha fin debe ser hoy o posterior');
    const type = (document.querySelector('input[name=sl-type]:checked') || {}).value || 'precio';
    l.sale = { type: type, note: ($('#sl-note').value || '').trim(), date: (l.sale && l.sale.date) || D.toISO(T()), end: end };
    l.lastFail = null; await put('lots', l); await reload(); closeSheet(); render(); toast('Rebaja guardada');
  }
  async function clearSale(id) {
    const l = lotById(id); if (!l) return;
    l.sale = null; await put('lots', l); await reload(); closeSheet(); render(); toast('Rebaja quitada');
  }

  /* ===================== Catálogo de productos ===================== */
  const Cat = window.RotCatalog;
  const byName = (a, b) => (a.name || '').localeCompare(b.name || '');
  const prodLots = (id) => state.lots.filter((l) => l.productId === id).length;
  function viewCatalog() {
    const q = norm(state.cq);
    let list = state.products.slice().sort(byName);
    if (q) list = list.filter((p) => norm(p.name).includes(q) || norm(p.code).includes(q) || norm(p.supplier).includes(q));
    return '<div class="row" style="margin-bottom:6px"><button class="btn-mini" data-action="go-settings">← Ajustes</button></div><h2>📦 Catálogo</h2>' +
      '<p class="small muted" style="margin:0 0 10px">Los productos del catálogo se autocompletan al agregar un lote (por código o nombre).</p>' +
      '<div class="row wrap"><button class="btn primary grow" data-action="cat-import">📥 Importar PDF o imagen</button><button class="btn grow" data-action="cat-new">➕ Producto</button></div>' +
      '<input type="file" id="catFile" class="hidden" accept="application/pdf,image/*,.csv,.txt,text/plain,text/csv">' +
      '<div class="row" style="margin-top:10px"><input type="search" id="cq" class="grow" placeholder="Buscar nombre, código o proveedor" value="' + esc(state.cq) + '"><button type="button" class="btn" data-action="scan-search" data-k="cq" aria-label="Escanear">📷</button></div>' +
      '<div class="small muted" style="margin:6px 2px 8px">' + list.length + (list.length === 1 ? ' producto' : ' productos') + '</div>' +
      (list.length ? list.map((p) => '<div class="prow" data-action="prod-edit" data-id="' + p.id + '">' + ((p.thumb || p.photo) ? photoImg(p.thumb || p.photo) : '<div class="pth ph-empty">📦</div>') +
        '<div class="grow"><div class="lot-name">' + esc(p.name) + '</div><div class="lot-sub">' + (p.code ? esc((p.codeType || 'EAN') + ' ' + p.code) + ' · ' : '') + esc(p.unit === 'kg' ? 'kg' : 'und') + (p.supplier ? ' · ' + esc(p.supplier) : '') + '</div></div></div>').join('') :
        '<div class="empty">' + (state.products.length ? 'Ningún producto coincide.' : 'El catálogo está vacío.<br>Importa un PDF o una imagen, o agrega productos a mano.') + '</div>');
  }
  function openProdSheet(id) {
    const p = id ? prodById(id) : null; if (id && !p) return;
    const d = p || { name: '', code: '', unit: 'und', supplier: '', photo: '' };
    const sups = supplierList();
    photoBuf.p = d.photo || ''; thumbBuf.p = d.thumb || ''; photoCleared.p = false;
    const seg = (v, t) => '<label><input type="radio" name="pd-unit" value="' + v + '" hidden' + ((d.unit || 'und') === v ? ' checked' : '') + '><span class="segopt">' + t + '</span></label>';
    openSheet('<h2>' + (p ? 'Editar producto' : 'Nuevo producto') + '</h2>' +
      '<label class="f" style="margin-top:0" for="pd-name">Nombre</label><input id="pd-name" value="' + esc(d.name) + '">' +
      '<label class="f" for="pd-code">Código (EAN o PLU)</label><input id="pd-code" inputmode="numeric" value="' + esc(d.code || '') + '">' +
      '<label class="f">Se cuenta en</label><div class="seg">' + seg('und', 'Unidades') + seg('kg', 'Kilos') + '</div>' +
      '<label class="f" for="pd-sup">Proveedor</label><input id="pd-sup" list="dl-sups-pd" value="' + esc(d.supplier || '') + '"><datalist id="dl-sups-pd">' + sups.map((n) => '<option value="' + esc(n) + '">').join('') + '</datalist>' +
      '<label class="f">Foto</label>' + photoWidget('p', photoBuf.p) +
      '<div class="row wrap" style="margin-top:14px"><button class="btn primary grow" data-action="prod-save" data-id="' + (id || '') + '">Guardar</button>' +
      (p ? '<button class="btn danger grow" data-action="prod-delete" data-id="' + id + '">Eliminar</button>' : '') + '</div>' +
      '<button class="btn block" style="margin-top:8px" data-action="close-sheet">Cancelar</button>');
  }
  async function saveProd(id) {
    const g = (x) => ($('#' + x).value || '').trim();
    const name = g('pd-name'), code = g('pd-code').replace(/\s+/g, '');
    if (!name) return toast('Falta el nombre');
    const dup = state.products.find((x) => x.id !== id && ((code && x.code === code) || (!code && !x.code && norm(x.name) === norm(name))));
    if (dup) return toast('Ya existe: ' + dup.name);
    const unit = (document.querySelector('input[name=pd-unit]:checked') || {}).value || 'und';
    const p = id ? prodById(id) : {};
    Object.assign(p, { name: name, code: code, codeType: code ? guessType(code) : '', unit: unit, supplier: g('pd-sup'), photo: photoBuf.p, thumb: photoBuf.p ? thumbBuf.p : '' });
    await put('products', p); await reload(); closeSheet(); render(); toast(id ? 'Producto guardado' : 'Producto agregado');
  }
  async function deleteProd(id) {
    const n = prodLots(id);
    if (n) return toast('No se puede eliminar: tiene ' + n + (n === 1 ? ' lote' : ' lotes') + ' registrados');
    if (!confirm('¿Eliminar este producto del catálogo?')) return;
    await del('products', id); await reload(); closeSheet(); render(); toast('Producto eliminado');
  }

  /* ---------- Lectura de PDF / imagen ---------- */
  const TESS_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
  function loadScript(src) {
    return new Promise((res, rej) => {
      const s = document.createElement('script'); s.src = src; s.onload = res;
      s.onerror = () => { const e = new Error('net'); e.code = 'net'; rej(e); };
      document.head.appendChild(s);
    });
  }
  async function ocrBlobs(blobs, msg) {
    if (!window.Tesseract) await loadScript(TESS_URL);
    msg('Descargando el lector de texto (solo la primera vez)…');
    const w = await window.Tesseract.createWorker('spa', 1, { logger: (m) => { if (m.status === 'recognizing text') msg('Reconociendo texto… ' + Math.round(m.progress * 100) + '%'); } });
    let out = '';
    try { for (const b of blobs) { out += (await w.recognize(b)).data.text + '\n'; } } finally { try { await w.terminate(); } catch (e) { /* ignorar */ } }
    return out;
  }
  function imageToBlob(src, max) { // src: File o canvas
    return new Promise((res, rej) => {
      const draw = (img, w, h) => {
        const sc = Math.min(1, max / Math.max(w, h)), c = document.createElement('canvas');
        c.width = Math.round(w * sc); c.height = Math.round(h * sc);
        const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
        c.toBlob((b) => b ? res(b) : rej(new Error('blob')), 'image/jpeg', 0.92);
      };
      if (src instanceof HTMLCanvasElement) return draw(src, src.width, src.height);
      const url = URL.createObjectURL(src), img = new Image();
      img.onload = () => { draw(img, img.width, img.height); URL.revokeObjectURL(url); };
      img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('img')); };
      img.src = url;
    });
  }
  async function readPdf(file, msg) {
    msg('Abriendo PDF…');
    const pdfjs = await import('./lib/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('./lib/pdf.worker.min.mjs', location.href).href;
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    const n = Math.min(pdf.numPages, 80);
    let text = '';
    for (let i = 1; i <= n; i++) {
      msg('Leyendo página ' + i + ' de ' + n + '…');
      const page = await pdf.getPage(i);
      text += Cat.itemsToLines((await page.getTextContent()).items) + '\n';
    }
    if (text.replace(/\s/g, '').length >= 30 * Math.min(n, 3)) return text;
    // PDF escaneado (sin texto): se pasa cada página por el lector de texto.
    const m = Math.min(pdf.numPages, 12), blobs = [];
    for (let i = 1; i <= m; i++) {
      msg('Preparando página ' + i + ' de ' + m + '…');
      const page = await pdf.getPage(i), vp = page.getViewport({ scale: 2 });
      const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
      await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
      blobs.push(await imageToBlob(c, 2400));
    }
    return await ocrBlobs(blobs, msg);
  }
  // Abre la hoja de progreso, lee un PDF / imagen / texto y devuelve el texto (o null si falló o se canceló).
  async function readFileText(file, title) {
    const nm = (file.name || '').toLowerCase();
    openSheet('<h2>' + title + '</h2><p class="muted small" id="impMsg">Preparando…</p><button class="btn block" data-action="close-sheet">Cancelar</button>');
    const msg = (t) => { const e = $('#impMsg'); if (e) e.textContent = t; };
    let text = '';
    try {
      if (file.type === 'application/pdf' || /\.pdf$/.test(nm)) text = await readPdf(file, msg);
      else if (/^image\//.test(file.type) || /\.(jpe?g|png|webp|heic)$/.test(nm)) text = await ocrBlobs([await imageToBlob(file, 2400)], msg);
      else text = await file.text();
    } catch (e) {
      closeSheet();
      toast(e && e.code === 'net' ? 'Para leer imágenes necesitas internet (solo la primera vez)' : 'No se pudo leer el archivo');
      return null;
    }
    return $('#sheet').classList.contains('hidden') ? null : text; // null si el usuario canceló
  }
  async function importCatalogFile(file) {
    const text = await readFileText(file, 'Leyendo catálogo…'); if (text === null) return;
    const rows = Cat.parseText(text);
    if (!rows.length) { closeSheet(); return toast('No encontré productos en el archivo'); }
    importSheet(rows);
  }
  function importSheet(rows) {
    const sups = supplierList();
    const nOk = rows.filter((r) => r.checked).length;
    openSheet('<h2>Revisar catálogo</h2><p class="small muted" style="margin:0 0 8px">Encontré ' + rows.length + (rows.length === 1 ? ' fila' : ' filas') + '. Corrige nombres y códigos, y desmarca lo que no sea un producto. La lectura de imágenes puede equivocarse en los números.</p>' +
      '<label class="f" style="margin-top:0" for="imp-sup">Proveedor para los productos marcados (opcional)</label><input id="imp-sup" list="dl-sups-imp"><datalist id="dl-sups-imp">' + sups.map((n) => '<option value="' + esc(n) + '">').join('') + '</datalist>' +
      '<div class="row wrap" style="margin:10px 0"><button class="btn-mini" data-action="imp-all" data-v="1">Marcar todos</button><button class="btn-mini" data-action="imp-all" data-v="0">Desmarcar todos</button><span class="small muted" id="impCount"></span></div>' +
      rows.map((r) => '<div class="irow"><div class="row"><input type="checkbox" class="ir-on" style="width:auto"' + (r.checked ? ' checked' : '') + '><input class="ir-name grow" value="' + esc(r.name) + '"></div>' +
        '<div class="row" style="margin-top:6px"><input class="ir-code grow" inputmode="numeric" placeholder="Código (EAN/PLU)" value="' + esc(r.code) + '">' +
        '<select class="ir-unit" style="width:auto"><option value="und"' + (r.unit === 'kg' ? '' : ' selected') + '>und</option><option value="kg"' + (r.unit === 'kg' ? ' selected' : '') + '>kg</option></select></div></div>').join('') +
      '<div class="sticky-bar"><div class="row wrap"><button class="btn primary grow" data-action="imp-confirm" id="impGo">Importar</button><button class="btn grow" data-action="close-sheet">Cancelar</button></div></div>');
    const bg = $('.sheet-bg'); if (bg) bg.removeAttribute('data-action'); // evita perder la revisión por un toque accidental
    updateImpCount();
  }
  function updateImpCount() {
    const n = document.querySelectorAll('#sheet .ir-on:checked').length;
    const c = $('#impCount'); if (c) c.textContent = n + ' marcados';
    const b = $('#impGo'); if (b) b.textContent = 'Importar (' + n + ')';
  }
  async function confirmImport() {
    const sup = ($('#imp-sup').value || '').trim();
    const rows = Array.from(document.querySelectorAll('#sheet .irow')).map((e) => ({
      on: e.querySelector('.ir-on').checked, name: e.querySelector('.ir-name').value.trim(),
      code: e.querySelector('.ir-code').value.replace(/\s+/g, ''), unit: e.querySelector('.ir-unit').value
    })).filter((r) => r.on && r.name);
    if (!rows.length) return toast('No hay productos marcados');
    const byCode = new Map(), byNm = new Map();
    state.products.forEach((p) => { if (p.code) byCode.set(p.code, p); byNm.set(norm(p.name), p); });
    let nNew = 0, nUpd = 0; const out = [];
    rows.forEach((r) => {
      const ex = (r.code && byCode.get(r.code)) || byNm.get(norm(r.name));
      if (ex) {
        if (r.code && !ex.code) { ex.code = r.code; ex.codeType = guessType(r.code); }
        if (sup) ex.supplier = sup;
        if (r.unit === 'kg') ex.unit = 'kg'; // solo se cambia a kg; no se pisa con el valor por defecto
        out.push(ex); nUpd++;
      } else {
        const p = { name: r.name, code: r.code, codeType: r.code ? guessType(r.code) : '', unit: r.unit, supplier: sup, photo: '' };
        out.push(p); nNew++;
        if (p.code) byCode.set(p.code, p); byNm.set(norm(p.name), p);
      }
    });
    await putMany('products', out); await reload(); closeSheet(); render();
    toast(nNew + (nNew === 1 ? ' producto nuevo' : ' productos nuevos') + (nUpd ? ' · ' + nUpd + ' actualizados' : ''));
  }

  /* ===================== Códigos de balanzas (extra) ===================== */
  const scaleCount = (a) => state.scales.filter((s) => s.area === a).length;
  const SCATS = { res: 'Res', bufalo: 'Búfalo', cerdo: 'Cerdo', pollo: 'Pollo', pescado: 'Pescado' };
  const scatOf = (s) => s.area === 'atendida' ? (SCATS[s.cat] ? s.cat : 'res') : '';
  const scaleLabel = (s) => AREAS[s.area].name + (s.area === 'atendida' ? ' · ' + SCATS[scatOf(s)] : '');
  // Datos efectivos de una balanza: si está vinculada a un producto del catálogo, nombre/PLU/proveedor salen de ahí.
  function sv(s) {
    const p = s.productId ? prodById(s.productId) : null;
    if (!p) return { name: s.name || '', plu: s.plu || '', supplier: s.supplier || '', linked: false };
    return { name: p.name || '', plu: p.codeType === 'PLU' ? p.code : (s.plu || ''), supplier: p.supplier || '', linked: true };
  }
  const scaleMatch = (s, q) => { if (!q) return true; const v = sv(s); return [v.name, s.code, v.plu, v.supplier].some((x) => norm(x).includes(q)); };
  function scaleRow(s, showTag) {
    const v = sv(s);
    return '<div class="plot ar-' + s.area + ' scrow" data-action="scale-edit" data-id="' + s.id + '"><div class="row"><div class="grow"><b>' + esc(v.name) + '</b>' + (v.linked ? ' <span title="Vinculado al catálogo">🔗</span>' : '') +
      '<div class="lot-sub">' + (v.plu ? 'PLU ' + esc(v.plu) + ' · ' : '') + esc(v.supplier || 'Sin proveedor') + '</div>' +
      (showTag ? '<span class="atag ' + s.area + '" style="margin-top:4px">' + esc(scaleLabel(s)) + '</span>' : '') + '</div>' +
      '<div class="sccode-wrap"><span class="sclbl">Balanza</span><div class="sccode">' + esc(s.code) + '</div></div></div></div>';
  }
  const scaleSort = (a, b) => byName(sv(a), sv(b));
  function viewScales() {
    const ar = state.scaleArea, q = norm(state.sq), cat = state.scaleCat, sup = state.scaleSup, searching = !!q;
    const tab = (a) => '<button class="' + a + (ar === a && !searching ? ' on' : '') + '" data-action="scale-area" data-a="' + a + '">' + AREAS[a].name + ' (' + scaleCount(a) + ')</button>';
    const sups = Array.from(new Set(state.scales.map((s) => sv(s).supplier).filter(Boolean))).sort();
    const list = state.scales.filter((s) => (searching || s.area === ar) && scaleMatch(s, q) && (!sup || sv(s).supplier === sup) &&
      (searching || ar !== 'atendida' || !cat || scatOf(s) === cat));
    const catOrder = Object.keys(SCATS);
    list.sort((a, b) => (searching ? a.area.localeCompare(b.area) || catOrder.indexOf(scatOf(a)) - catOrder.indexOf(scatOf(b)) : 0) || scaleSort(a, b));
    let h = '<h2>⚖️ Códigos de balanzas</h2>' +
      '<div class="row"><input type="search" id="sq" class="grow" placeholder="Buscar nombre, PLU o código (todas las secciones)" value="' + esc(state.sq) + '">' +
      '<button type="button" class="btn" data-action="scan-search" data-k="sq" aria-label="Escanear">📷</button></div>' +
      '<div class="subtabs" style="margin-top:10px">' + tab('autoservicio') + tab('atendida') + '</div>';
    if (!searching && ar === 'atendida') {
      const n = state.scales.filter((s) => s.area === 'atendida').length;
      const cc = (k, t, c) => '<button class="chip ' + (cat === k ? 'on' : '') + '" data-action="scale-cat" data-c="' + k + '">' + t + ' (' + c + ')</button>';
      h += '<div class="chips">' + cc('', 'Todas', n) + catOrder.map((k) => cc(k, SCATS[k], state.scales.filter((s) => s.area === 'atendida' && scatOf(s) === k).length)).join('') + '</div>';
    }
    if (sups.length) h += '<select id="scSup" style="margin-bottom:10px"><option value="">Todos los proveedores</option>' + sups.map((x) => '<option ' + (sup === x ? 'selected' : '') + '>' + esc(x) + '</option>').join('') + '</select>';
    h += '<button class="btn primary block" data-action="scale-new">➕ Agregar' + (searching ? '' : ' a ' + esc(AREAS[ar].name) + (ar === 'atendida' && cat ? ' · ' + SCATS[cat] : '')) + '</button>';
    if (searching) h += '<div class="small muted" style="margin:10px 2px 6px">' + list.length + (list.length === 1 ? ' resultado' : ' resultados') + ' en Autoservicio y Atendida</div>';
    if (!list.length) {
      h += '<div class="empty">' + (searching ? 'Nada coincide con la búsqueda.' : (scaleCount(ar) ? 'Nada coincide con el filtro.' : 'Aún no hay códigos en ' + esc(AREAS[ar].name) + '.<br>Toca <b>Agregar</b> o <b>Importar</b> una lista.')) + '</div>';
    } else if (!searching && ar === 'atendida' && !cat) {
      catOrder.forEach((k) => {
        const g = list.filter((s) => scatOf(s) === k); if (!g.length) return;
        h += '<div class="cathead">' + esc(SCATS[k]) + ' · ' + g.length + '</div>' + g.map((s) => scaleRow(s, false)).join('');
      });
    } else h += list.map((s) => scaleRow(s, searching)).join('');
    return h + '<input type="file" id="scFile" class="hidden" accept="application/pdf,image/*,.csv,.txt,text/plain,text/csv">' +
      '<div class="row wrap" style="margin-top:12px"><button class="btn grow" data-action="scale-import">📥 Importar</button>' +
      (state.scales.length ? '<button class="btn grow" data-action="scale-pdf">📄 PDF</button><button class="btn grow" data-action="scale-csv">CSV</button>' : '') + '</div>';
  }

  /* ---------- Hoja: agregar / editar (con vínculo opcional al catálogo) ---------- */
  let scLink = null;
  function applyScLink() {
    const inp = $('#sc-prod'); if (!inp) return;
    const val = norm(inp.value), p = val ? state.products.find((x) => norm(x.name) === val) : null;
    scLink = p ? p.id : null;
    const hasPlu = !!(p && p.codeType === 'PLU');
    $('#sc-name').disabled = !!p; $('#sc-sup').disabled = !!p; $('#sc-plu').disabled = hasPlu;
    if (p) { $('#sc-name').value = p.name; $('#sc-sup').value = p.supplier || ''; if (hasPlu) $('#sc-plu').value = p.code; }
    $('#sc-linknote').innerHTML = p ? 'Vinculado: nombre, PLU y proveedor se toman del catálogo y se actualizan solos. <button type="button" class="btn-mini" data-action="sc-unlink">Desvincular</button>'
      : (inp.value.trim() ? 'No hay un producto con ese nombre en el catálogo.' : '');
  }
  function openScaleSheet(id) {
    const s = id ? state.scales.find((x) => x.id === id) : null; if (id && !s) return;
    const d = s || { area: state.scaleArea, cat: state.scaleCat || state.lastScaleCat || 'res', code: '' };
    const lp = s && s.productId ? prodById(s.productId) : null, v = s ? sv(s) : { name: '', plu: '', supplier: '' };
    const dc = scatOf(d) || 'res';
    const sups = supplierList(state.scales.map((x) => sv(x).supplier));
    const seg = (a) => '<label><input type="radio" name="sc-area" value="' + a + '" hidden' + (d.area === a ? ' checked' : '') + '><span class="segopt ' + a + '">' + AREAS[a].name + '</span></label>';
    openSheet('<h2>' + (s ? 'Editar código' : 'Nuevo código de balanza') + '</h2>' +
      '<label class="f" style="margin-top:0">Sección</label><div class="seg">' + seg('autoservicio') + seg('atendida') + '</div>' +
      '<div id="sc-catwrap"' + (d.area === 'atendida' ? '' : ' class="hidden"') + '><label class="f" for="sc-cat">Categoría</label><select id="sc-cat">' +
      Object.keys(SCATS).map((k) => '<option value="' + k + '"' + (dc === k ? ' selected' : '') + '>' + SCATS[k] + '</option>').join('') + '</select></div>' +
      '<label class="f" for="sc-prod">Vincular con el catálogo (opcional)</label><input id="sc-prod" list="dl-prods" autocomplete="off" placeholder="Escribe el nombre de un producto del catálogo" value="' + esc(lp ? lp.name : '') + '">' +
      '<datalist id="dl-prods">' + state.products.slice().sort(byName).map((p) => '<option value="' + esc(p.name) + '">').join('') + '</datalist><div class="small muted" id="sc-linknote" style="margin-top:4px"></div>' +
      '<label class="f" for="sc-name">Nombre</label><input id="sc-name" value="' + esc(v.name) + '" autocomplete="off">' +
      '<div class="row"><div class="grow"><label class="f" for="sc-plu">PLU</label><input id="sc-plu" value="' + esc(v.plu) + '" autocomplete="off"></div>' +
      '<div class="grow"><label class="f" for="sc-code">Código de balanza</label><input id="sc-code" value="' + esc(d.code) + '" autocomplete="off"></div></div>' +
      '<label class="f" for="sc-sup">Proveedor</label><input id="sc-sup" list="dl-sups-sc" value="' + esc(v.supplier) + '" autocomplete="off"><datalist id="dl-sups-sc">' + sups.map((n) => '<option value="' + esc(n) + '">').join('') + '</datalist>' +
      '<div class="row wrap" style="margin-top:14px"><button class="btn primary grow" data-action="scale-save" data-id="' + (id || '') + '">Guardar</button>' +
      (s ? '<button class="btn danger grow" data-action="scale-delete" data-id="' + id + '">Eliminar</button>' : '<button class="btn grow" data-action="scale-save" data-again="1">Guardar y agregar otro</button>') + '</div>' +
      '<button class="btn block" style="margin-top:8px" data-action="close-sheet">Cancelar</button>');
    scLink = lp ? lp.id : null;
    if (lp) applyScLink();
  }
  async function saveScale(id, again) {
    const g = (x) => ($('#' + x).value || '').trim();
    const area = (document.querySelector('input[name=sc-area]:checked') || {}).value || state.scaleArea;
    const cat = area === 'atendida' ? (g('sc-cat') || 'res') : '';
    const name = g('sc-name'), code = g('sc-code'), plu = g('sc-plu'), supplier = g('sc-sup');
    if (!name) return toast('Falta el nombre');
    if (!code) return toast('Falta el código de balanza');
    const dup = state.scales.find((x) => x.id !== id && x.area === area && scatOf(x) === cat && norm(x.code) === norm(code));
    if (dup) return toast('Ese código ya existe en ' + scaleLabel(dup) + ': ' + sv(dup).name);
    const o = id ? state.scales.find((x) => x.id === id) : { createdAt: Date.now() };
    Object.assign(o, { area: area, cat: cat, name: name, code: code, plu: plu, supplier: supplier, productId: scLink || null });
    await put('scales', o); state.scaleArea = area; if (cat) state.lastScaleCat = cat;
    if (area === 'atendida' && state.scaleCat && state.scaleCat !== cat) state.scaleCat = '';
    await reload();
    if (again) { openScaleSheet(null); toast('Guardado. Agrega el siguiente'); }
    else { closeSheet(); toast(id ? 'Cambios guardados' : 'Código guardado'); }
    render();
  }

  /* ---------- Importar lista de balanzas (PDF, imagen, CSV/TXT) ---------- */
  async function importScalesFile(file) {
    const text = await readFileText(file, 'Leyendo lista de balanzas…'); if (text === null) return;
    const rows = Cat.parseScales(text, state.scaleArea === 'atendida' ? state.scaleCat : '');
    if (!rows.length) { closeSheet(); return toast('No encontré códigos en el archivo'); }
    scaleImportSheet(rows);
  }
  function scaleImportSheet(rows) {
    const ar = state.scaleArea, dflt = state.scaleCat || state.lastScaleCat || 'res';
    const catOpts = (cur) => Object.keys(SCATS).map((k) => '<option value="' + k + '"' + (cur === k ? ' selected' : '') + '>' + SCATS[k] + '</option>').join('');
    const seg = (a) => '<label><input type="radio" name="si-area" value="' + a + '" hidden' + (ar === a ? ' checked' : '') + '><span class="segopt ' + a + '">' + AREAS[a].name + '</span></label>';
    openSheet('<h2>Revisar códigos de balanza</h2><p class="small muted" style="margin:0 0 8px">Encontré ' + rows.length + (rows.length === 1 ? ' fila' : ' filas') + '. Revisa que el <b>PLU</b> y el <b>código de balanza</b> estén en su casilla (si salieron al revés, usa “Intercambiar”). Los encabezados Res, Cerdo, Pollo… del documento se usan como categoría.</p>' +
      '<label class="f" style="margin-top:0">Sección</label><div class="seg">' + seg('autoservicio') + seg('atendida') + '</div>' +
      '<div id="si-catwrap"' + (ar === 'atendida' ? '' : ' class="hidden"') + '><label class="f" for="si-allcat">Poner la misma categoría a todos</label><select id="si-allcat"><option value="">— Elegir —</option>' + catOpts('') + '</select></div>' +
      '<label class="f" for="si-sup">Proveedor para todos los marcados (opcional; si lo llenas, reemplaza el de cada fila)</label><input id="si-sup" list="dl-sups-si"><datalist id="dl-sups-si">' + supplierList(state.scales.map((x) => sv(x).supplier)).map((n) => '<option value="' + esc(n) + '">').join('') + '</datalist>' +
      '<div class="row wrap" style="margin:10px 0"><button class="btn-mini" data-action="imp-all" data-v="1">Marcar todos</button><button class="btn-mini" data-action="imp-all" data-v="0">Desmarcar todos</button><button class="btn-mini" data-action="si-swap">⇄ Intercambiar PLU y código</button><span class="small muted" id="impCount"></span></div>' +
      rows.map((r) => '<div class="irow"><div class="row"><input type="checkbox" class="ir-on" style="width:auto" checked><input class="ir-name grow" value="' + esc(r.name) + '"></div>' +
        '<div class="row" style="margin-top:6px"><input class="ir-plu grow" inputmode="numeric" placeholder="PLU" value="' + esc(r.plu) + '"><input class="ir-code grow" inputmode="numeric" placeholder="Código de balanza" value="' + esc(r.code) + '"></div>' +
        '<input class="ir-sup" style="margin-top:6px" placeholder="Proveedor" value="' + esc(r.supplier || '') + '">' +
        '<select class="ir-cat' + (ar === 'atendida' ? '' : ' hidden') + '" style="margin-top:6px">' + catOpts(r.cat || dflt) + '</select></div>').join('') +
      '<div class="sticky-bar"><div class="row wrap"><button class="btn primary grow" data-action="si-confirm" id="impGo">Importar</button><button class="btn grow" data-action="close-sheet">Cancelar</button></div></div>');
    const bg = $('.sheet-bg'); if (bg) bg.removeAttribute('data-action');
    updateImpCount();
  }
  async function confirmScaleImport() {
    const area = (document.querySelector('input[name=si-area]:checked') || {}).value || state.scaleArea, sup = ($('#si-sup').value || '').trim();
    const rows = Array.from(document.querySelectorAll('#sheet .irow')).map((e) => ({
      on: e.querySelector('.ir-on').checked, name: e.querySelector('.ir-name').value.trim(), plu: e.querySelector('.ir-plu').value.replace(/\s+/g, ''),
      code: e.querySelector('.ir-code').value.replace(/\s+/g, ''), cat: area === 'atendida' ? e.querySelector('.ir-cat').value : '', sup: e.querySelector('.ir-sup').value.trim()
    })).filter((r) => r.on);
    if (!rows.length) return toast('No hay filas marcadas');
    if (rows.some((r) => !r.name || !r.code)) return toast('Hay filas marcadas sin nombre o sin código de balanza');
    const idx = new Map();
    state.scales.forEach((x) => { idx.set(x.area + '|' + scatOf(x) + '|' + norm(x.code), x); });
    let nNew = 0, nUpd = 0; const out = [];
    rows.forEach((r) => {
      const k = area + '|' + r.cat + '|' + norm(r.code), ex = idx.get(k);
      if (ex) { Object.assign(ex, { name: r.name, plu: r.plu || ex.plu || '' }); if (sup || r.sup) ex.supplier = sup || r.sup; out.push(ex); nUpd++; }
      else { const o = { area: area, cat: r.cat, name: r.name, code: r.code, plu: r.plu, supplier: sup || r.sup, productId: null, createdAt: Date.now() }; idx.set(k, o); out.push(o); nNew++; }
    });
    await putMany('scales', out); state.scaleArea = area; state.sq = ''; await reload(); closeSheet(); render();
    toast(nNew + (nNew === 1 ? ' código nuevo' : ' códigos nuevos') + (nUpd ? ' · ' + nUpd + ' actualizados' : ''));
  }

  /* ---------- PDF imprimible ---------- */
  function buildScalesPDF(scope) {
    const J = window.jspdf.jsPDF, doc = new J({ unit: 'mm', format: 'letter' });
    const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight(), M = 12, LH = 3.8;
    const cols = [{ t: 'Balanza', w: 24 }, { t: 'PLU', w: 26 }, { t: 'Nombre', w: W - 2 * M - 24 - 26 - 54 }, { t: 'Proveedor', w: 54 }];
    const groups = [];
    ['autoservicio', 'atendida'].forEach((a) => {
      if (scope !== 'all' && scope !== a) return;
      const inArea = state.scales.filter((s) => s.area === a);
      if (a === 'atendida') Object.keys(SCATS).forEach((k) => { const g = inArea.filter((s) => scatOf(s) === k); if (g.length) groups.push({ area: a, label: 'ATENDIDA · ' + SCATS[k].toUpperCase(), items: g }); });
      else if (inArea.length) groups.push({ area: a, label: 'AUTOSERVICIO', items: inArea });
    });
    let y = M;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(16); doc.setTextColor(0); doc.text('Rotador · Códigos de balanza', M, y + 5); y += 9;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10);
    doc.text('Fecha: ' + D.fmtFull(T()) + '   ·   ' + (scope === 'all' ? 'Autoservicio y Atendida' : AREAS[scope].name), M, y + 3); y += 10;
    groups.forEach((gr) => {
      const ac = AREA_COL[gr.area], items = gr.items.slice().sort(scaleSort);
      const band = (cont) => {
        doc.setFillColor(ac[0], ac[1], ac[2]); doc.rect(M, y, W - 2 * M, 8, 'F');
        doc.setTextColor(255); doc.setFont('helvetica', 'bold'); doc.setFontSize(12);
        doc.text(gr.label + '  ·  ' + items.length + (items.length === 1 ? ' código' : ' códigos') + (cont ? '  (continuación)' : ''), M + 3, y + 5.7);
        y += 10; doc.setTextColor(0);
        doc.setFillColor(229, 236, 233); doc.rect(M, y, W - 2 * M, 6, 'F'); doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5); doc.setTextColor(30);
        let x = M; cols.forEach((c) => { doc.text(c.t, x + 1.5, y + 4.2); x += c.w; }); y += 6.5; doc.setTextColor(0);
      };
      if (y + 10 + 6.5 + 12 > H - 14) { doc.addPage(); y = M; }
      band(false);
      items.forEach((s) => {
        const v = sv(s);
        doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5);
        const nl = doc.splitTextToSize(v.name, cols[2].w - 3), sl = doc.splitTextToSize(v.supplier || '—', cols[3].w - 3);
        const rh = Math.max(nl.length, sl.length, 1) * LH + 3.6;
        if (y + rh > H - 14) { doc.addPage(); y = M; band(true); }
        let x = M;
        doc.setFont('helvetica', 'bold'); doc.setFontSize(13); doc.text(String(s.code), x + 1.5, y + 5.3); x += cols[0].w;
        doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5);
        doc.text(String(v.plu || '—'), x + 1.5, y + 4.6); x += cols[1].w;
        doc.setFont('helvetica', 'bold'); doc.text(nl, x + 1.5, y + 4.6); x += cols[2].w;
        doc.setFont('helvetica', 'normal'); doc.text(sl, x + 1.5, y + 4.6);
        doc.setDrawColor(220); doc.setLineWidth(0.2); doc.line(M, y + rh, W - M, y + rh);
        y += rh + 0.3;
      });
      y += 7;
    });
    pdfFooters(doc, W, H, M);
    return doc;
  }
  const scalesPdfName = () => 'Balanzas_' + D.toISO(T()) + '.pdf';
  function scalesPdfSheet() {
    const sc = (v, t, c) => '<label><input type="radio" name="sp-scope" value="' + v + '" hidden' + (c ? ' checked' : '') + '><span class="segopt">' + t + '</span></label>';
    openSheet('<h2>📄 PDF de balanzas</h2><p class="muted small">Qué incluir · ' + esc(scalesPdfName()) + '</p>' +
      '<div class="seg" style="margin-bottom:12px">' + sc('all', 'Todo', true) + sc('atendida', 'Atendida') + sc('autoservicio', 'Autoservicio') + '</div>' +
      '<div class="row wrap"><button class="btn primary grow" data-action="scpdf-share">Compartir</button><button class="btn grow" data-action="scpdf-download">Descargar</button></div>' +
      '<button class="btn block" style="margin-top:8px" data-action="close-sheet">Cerrar</button>');
  }
  const scalesPdfScope = () => (document.querySelector('input[name=sp-scope]:checked') || {}).value || 'all';
  async function deleteScale(id) {
    if (!confirm('¿Eliminar este código de balanza?')) return;
    await del('scales', id); await reload(); closeSheet(); render(); toast('Código eliminado');
  }
  async function exportScalesCSV() {
    const rows = [['Sección', 'Categoría', 'Nombre', 'PLU', 'Proveedor', 'Código de balanza']];
    ['autoservicio', 'atendida'].forEach((a) => (a === 'atendida' ? Object.keys(SCATS) : ['']).forEach((k) => state.scales.filter((s) => s.area === a && scatOf(s) === k).sort(scaleSort).forEach((s) => {
      const v = sv(s); rows.push([AREAS[a].name, k ? SCATS[k] : '', v.name, v.plu, v.supplier, s.code]);
    })));
    await shareOrDownload(csvBlob(rows), 'balanzas_' + D.toISO(T()) + '.csv', 'text/csv', 'Códigos de balanzas');
  }

  /* ===================== Respaldo ===================== */
  async function exportData() {
    const data = { app: 'rotador', version: 2, exportedAt: new Date().toISOString(), products: state.products, lots: state.lots, rounds: state.rounds, removals: state.removals, scales: state.scales, settings: state.settings };
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    await shareOrDownload(blob, 'rotador-respaldo_' + D.toISO(T()) + '.json', 'application/json', 'Respaldo de Rotador');
  }
  async function importData(file) {
    try {
      const data = JSON.parse(await file.text());
      if (data.app !== 'rotador' || !Array.isArray(data.lots) || !Array.isArray(data.products)) throw new Error('formato');
      data.scales = Array.isArray(data.scales) ? data.scales : [];
      if (!confirm('Esto reemplaza todos los datos actuales por los de la copia (' + data.lots.length + ' lotes). ¿Continuar?')) return;
      await replaceAll(data); await reload(); render(); toast('Copia importada');
    } catch (e) { toast('Ese archivo no es una copia válida de Rotador'); }
  }
  async function updatePersistInfo() {
    const e = $('#persistInfo'); if (!e) return;
    try {
      const ok = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : false;
      e.textContent = ok ? 'Almacenamiento protegido: el navegador no borrará tus datos automáticamente.' : 'Instala la app en la pantalla de inicio para proteger tus datos del borrado automático.';
    } catch (x) { /* ignorar */ }
  }

  /* ===================== Eventos ===================== */
  const handlers = {
    'open-alerts': () => openSheet('<h2>🔔 Avisos</h2>' + alertsHTML() + '<button class="btn block" data-action="close-sheet">Cerrar</button>'),
    'close-sheet': () => closeSheet(),
    'alert-go': (el) => {
      const a = computeAlerts().find((x) => x.key === el.dataset.key); if (!a) return;
      closeSheet(); state.area = ''; state.pedirArea = ''; if (a.go.filter) state.filter = a.go.filter; if (a.go.pedirTab) state.pedirTab = a.go.pedirTab; setTab(a.go.tab);
    },
    'alert-snooze': async (el) => {
      state.settings.snooze[el.dataset.key] = D.toISO(D.addDays(T(), 1)); await saveSettings();
      const sheetOpen = !$('#sheet').classList.contains('hidden');
      if (sheetOpen) openSheet('<h2>🔔 Avisos</h2>' + alertsHTML() + '<button class="btn block" data-action="close-sheet">Cerrar</button>');
      render();
    },
    'filter': (el) => { state.filter = el.dataset.f; render(); },
    'area-filter': (el) => { state.area = el.dataset.a; render(); },
    'pedir-area': (el) => { state.pedirArea = el.dataset.a; render(); },
    'open-lot': (el) => {
      const l = activeLots().find((x) => x.id === Number(el.dataset.id)); if (!l) return;
      openSheet((l.photoFull ? '<img class="pbig" src="' + esc(l.photoFull) + '" alt="" data-action="zoom-photo" data-pid="' + l.productId + '">' : '') + '<h2>' + esc(l.name) + '</h2><dl class="kv"><dt>Área</dt><dd>' + areaTag(l.area) + '</dd><dt>Código</dt><dd>' + esc(l.code ? l.codeType + ' ' + l.code : '—') + '</dd>' +
        '<dt>Lote</dt><dd>' + esc(l.lot || '—') + '</dd><dt>Cantidad</dt><dd>' + esc(qtyText(l.qty, l.unit)) + '</dd><dt>Proveedor</dt><dd>' + esc(l.supplier) + '</dd>' +
        '<dt>Vence</dt><dd>' + D.fmtFull(D.fromISO(l.expiry)) + '</dd><dt>Retirar</dt><dd>' + D.fmtFull(D.addDays(D.fromISO(l.expiry), -state.settings.removeBefore)) + '</dd>' +
        '<dt>Estado</dt><dd>' + (l.saleOn ? 'En rebaja (' + esc(l.sale.type) + ')' + (l.sale.end ? ' hasta ' + esc(saleEndText(l)) : '') : l.saleEnded ? 'Rebaja terminada el ' + esc(saleEndText(l)) : 'Sin rebaja') + '</dd></dl>' +
        '<div class="row wrap"><button class="btn primary grow" data-action="remove-lot" data-id="' + l.id + '">Retirar</button>' +
        '<button class="btn grow" data-action="edit-lot" data-id="' + l.id + '">Editar</button></div>' +
        '<button class="btn block" style="margin-top:8px" data-action="sale-edit" data-id="' + l.id + '">🏷️ ' + (l.sale ? 'Editar rebaja / fecha fin' : 'Registrar rebaja') + '</button>' +
        '<div class="row wrap" style="margin-top:8px"><button class="btn danger grow" data-action="delete-lot" data-id="' + l.id + '">Eliminar</button>' +
        '<button class="btn grow" data-action="close-sheet">Cerrar</button></div>');
    },
    'remove-lot': (el) => openRemoveSheet(Number(el.dataset.id)),
    'delete-lot': (el) => deleteLot(Number(el.dataset.id)),
    'rm-confirm': (el) => confirmRemove(Number(el.dataset.id)),
    'rm-all': (el) => { $('#rm-qty').value = el.dataset.q; },
    'rep-tab': (el) => { state.repTab = el.dataset.t; render(); },
    'retiro-days': (el) => { state.retiroDays = Number(el.dataset.d); render(); },
    'retiro-area': (el) => { state.retiroArea = el.dataset.a; render(); },
    'period': (el) => { state.period = el.dataset.p; render(); },
    'retiro-pdf': () => retiroSheet(),
    'retiro-share': async () => { const doc = buildRetiroPDF(retiroList()); await shareOrDownload(doc.output('blob'), retiroName(), 'application/pdf', 'Lista de retiro'); },
    'retiro-download': () => downloadBlob(buildRetiroPDF(retiroList()).output('blob'), retiroName()),
    'export-csv': () => exportCSV(),
    'edit-lot': (el) => { closeSheet(); state.editingLotId = Number(el.dataset.id); state.tab = 'add'; render(); $('#view').scrollTop = 0; },
    'cancel-edit': () => { state.editingLotId = null; setTab('home'); },
    'scan': () => openScanner(),
    'save-again': () => saveLot(true),
    'pedir-tab': (el) => { state.pedirTab = el.dataset.t; render(); },
    'set-type': async (el) => { const l = lotById(Number(el.dataset.id)); if (!l) return; l.reqType = el.dataset.type; await put('lots', l); await reload(); render(); },
    'bulk-type': async (el) => {
      const ids = porPedirArea().map((l) => l.id);
      for (const id of ids) { const l = lotById(id); l.reqType = el.dataset.type; await put('lots', l); }
      await reload(); render();
    },
    'gen-pdf': () => generateRound(),
    'round-pdf': (el) => { const r = state.rounds.find((x) => x.id === Number(el.dataset.round)); if (r) reportSheet(r); },
    'pdf-share': async (el) => {
      const r = state.rounds.find((x) => x.id === Number(el.dataset.round)); if (!r) return;
      const doc = buildPDF(r); await shareOrDownload(doc.output('blob'), pdfName(r), 'application/pdf', 'Pedir precios');
    },
    'pdf-download': (el) => { const r = state.rounds.find((x) => x.id === Number(el.dataset.round)); if (r) downloadBlob(buildPDF(r).output('blob'), pdfName(r)); },
    'check': (el) => setCheck(Number(el.dataset.round), Number(el.dataset.lot), el.dataset.val),
    'check-all': async (el) => {
      const r = state.rounds.find((x) => x.id === Number(el.dataset.round)); if (!r) return;
      for (const i of roundPending(r)) { i.check = 'ok'; const l = lotById(i.lotId); l.sale = { type: i.type, note: i.price || i.note || '', date: D.toISO(T()), end: i.saleEnd || '' }; l.lastFail = null; await put('lots', l); }
      await put('rounds', r); await reload(); toast('Ronda completa ✅'); render();
    },
    'sale-edit': (el) => openSaleSheet(Number(el.dataset.id)),
    'sale-save': (el) => saveSale(Number(el.dataset.id)),
    'sale-clear': (el) => clearSale(Number(el.dataset.id)),
    'photo-cam': (el) => $('#ph-cam-' + el.dataset.k).click(),
    'photo-gal': (el) => $('#ph-gal-' + el.dataset.k).click(),
    'zoom-photo': (el) => { const src = el.dataset.k ? photoBuf[el.dataset.k] : ((prodById(Number(el.dataset.pid)) || {}).photo || ''); const nm = el.dataset.k ? ($('#f-name') ? $('#f-name').value : ($('#pd-name') ? $('#pd-name').value : '')) : ((prodById(Number(el.dataset.pid)) || {}).name || ''); if (src) openViewer(src, nm); },
    'photo-clear': (el) => setPhoto(el.dataset.k, '', true),
    'cat-open': () => { closeSheet(); state.tab = 'catalog'; state.editingLotId = null; render(); $('#view').scrollTop = 0; },
    'go-settings': () => setTab('settings'),
    'cat-import': () => $('#catFile').click(),
    'cat-new': () => openProdSheet(null),
    'prod-edit': (el) => openProdSheet(Number(el.dataset.id)),
    'prod-save': (el) => saveProd(el.dataset.id ? Number(el.dataset.id) : null),
    'prod-delete': (el) => deleteProd(Number(el.dataset.id)),
    'imp-all': (el) => { document.querySelectorAll('#sheet .ir-on').forEach((c) => { c.checked = el.dataset.v === '1'; }); updateImpCount(); },
    'imp-confirm': () => confirmImport(),
    'scale-area': (el) => { state.scaleArea = el.dataset.a; state.sq = ''; render(); },
    'scale-cat': (el) => { state.scaleCat = el.dataset.c; render(); },
    'scale-new': () => openScaleSheet(null),
    'scale-edit': (el) => openScaleSheet(Number(el.dataset.id)),
    'scale-save': (el) => saveScale(el.dataset.id ? Number(el.dataset.id) : null, !!el.dataset.again),
    'scale-delete': (el) => deleteScale(Number(el.dataset.id)),
    'scale-csv': () => exportScalesCSV(),
    'scale-import': () => $('#scFile').click(),
    'scale-pdf': () => scalesPdfSheet(),
    'scpdf-share': async () => { await shareOrDownload(buildScalesPDF(scalesPdfScope()).output('blob'), scalesPdfName(), 'application/pdf', 'Códigos de balanza'); },
    'scpdf-download': () => downloadBlob(buildScalesPDF(scalesPdfScope()).output('blob'), scalesPdfName()),
    'si-swap': () => { document.querySelectorAll('#sheet .irow').forEach((e) => { const a = e.querySelector('.ir-plu'), b = e.querySelector('.ir-code'), t = a.value; a.value = b.value; b.value = t; }); },
    'si-confirm': () => confirmScaleImport(),
    'sc-unlink': () => { $('#sc-prod').value = ''; applyScLink(); },
    'scan-search': (el) => openScanner((c) => { state[el.dataset.k] = c; render(); }),
    'export': () => exportData(),
    'import': () => $('#importFile').click(),
    'wipe': async () => {
      if (!confirm('¿Borrar TODOS los datos de este teléfono? No se puede deshacer.')) return;
      if (!confirm('¿Seguro? Se perderán productos, lotes y rondas.')) return;
      await replaceAll({}); await reload(); render(); toast('Datos borrados');
    }
  };
  document.addEventListener('click', (e) => {
    const tab = e.target.closest('#tabs [data-tab]');
    if (tab) { setTab(tab.dataset.tab); return; }
    const el = e.target.closest('[data-action]');
    if (el && handlers[el.dataset.action]) handlers[el.dataset.action](el, e);
  });
  document.addEventListener('submit', (e) => { if (e.target.id === 'lotForm') { e.preventDefault(); saveLot(false); } });
  document.addEventListener('input', (e) => {
    const t = e.target;
    if (t.id === 'f-code') onCodeInput();
    else if (t.id === 'sc-prod') applyScLink();
    else if (t.classList && t.classList.contains('ir-on')) updateImpCount();
    else if (t.id === 'cq' || t.id === 'sq') { state[t.id] = t.value; const pos = t.selectionStart, id = t.id; render(); const q = $('#' + id); if (q) { q.focus(); try { q.setSelectionRange(pos, pos); } catch (x) { /* ignorar */ } } }
    else if (t.id === 'q') { state.q = t.value; const pos = t.selectionStart; render(); const q = $('#q'); if (q) { q.focus(); try { q.setSelectionRange(pos, pos); } catch (x) { /* ignorar */ } } }
  });
  document.addEventListener('change', async (e) => {
    const t = e.target;
    if (t.id === 'f-name') onNameChange();
    else if (t.dataset.photo) await onPhotoFile(t);
    else if (t.classList.contains('ir-on')) updateImpCount();
    else if (t.id === 'catFile' && t.files[0]) { const f = t.files[0]; t.value = ''; await importCatalogFile(f); }
    else if (t.name === 'f-unit') updateUnitLbl();
    else if (t.id === 'supSel') { state.supplier = t.value; render(); }
    else if (t.id === 'scSup') { state.scaleSup = t.value; render(); }
    else if (t.id === 'scFile' && t.files[0]) { const f = t.files[0]; t.value = ''; await importScalesFile(f); }
    else if (t.name === 'si-area') { document.querySelectorAll('#sheet .ir-cat').forEach((e) => e.classList.toggle('hidden', t.value !== 'atendida')); $('#si-catwrap').classList.toggle('hidden', t.value !== 'atendida'); }
    else if (t.id === 'si-allcat') { if (t.value) document.querySelectorAll('#sheet .ir-cat').forEach((e) => { e.value = t.value; }); }
    else if (t.name === 'f-area') { const w = $('#sf-catwrap'); if (w) w.classList.toggle('hidden', t.value !== 'atendida'); }
    else if (t.name === 'sc-area') { const w = $('#sc-catwrap'); if (w) w.classList.toggle('hidden', t.value !== 'atendida'); }
    else if (t.dataset.setting) {
      const k = t.dataset.setting;
      if (t.type === 'checkbox') state.settings[k] = t.checked;
      else if (t.type === 'number') { const n = parseInt(t.value, 10); state.settings[k] = isNaN(n) ? DEFAULTS[k] : Math.max(Number(t.min) || 0, Math.min(Number(t.max) || 99, n)); }
      else state.settings[k] = t.value;
      await saveSettings(); render();
    } else if (t.dataset.change === 'req-note') {
      const l = lotById(Number(t.dataset.id)); if (l) { l.reqNote = t.value.trim(); await put('lots', l); await reload(); }
    } else if (t.dataset.change === 'item-end') {
      if (t.value && t.value < D.toISO(T())) { t.value = ''; return toast('La fecha fin debe ser hoy o posterior'); }
      const r = state.rounds.find((x) => x.id === Number(t.dataset.round)); if (!r) return;
      const it = r.items.find((i) => i.lotId === Number(t.dataset.lot)); if (!it) return;
      it.saleEnd = t.value; await put('rounds', r);
      const l = lotById(it.lotId); if (l && l.sale && it.check === 'ok') { l.sale.end = it.saleEnd; await put('lots', l); }
      await reload(); render();
    } else if (t.dataset.change === 'item-price') {
      const r = state.rounds.find((x) => x.id === Number(t.dataset.round)); if (!r) return;
      const it = r.items.find((i) => i.lotId === Number(t.dataset.lot)); if (!it) return;
      it.price = t.value.trim(); await put('rounds', r);
      const l = lotById(it.lotId); if (l && l.sale && it.check === 'ok') { l.sale.note = it.price || it.note || ''; await put('lots', l); }
      await reload();
    } else if (t.id === 'importFile' && t.files[0]) { await importData(t.files[0]); t.value = ''; }
  });
  initViewer();
  // Pantalla fija: sigue la zona realmente visible (teclado abierto, barra del navegador) y oculta las pestañas al escribir.
  (function fitViewport() {
    const vv = window.visualViewport; if (!vv) return;
    const fit = () => {
      document.documentElement.style.setProperty('--app-h', Math.round(vv.height) + 'px');
      document.body.style.transform = vv.offsetTop ? 'translateY(' + Math.round(vv.offsetTop) + 'px)' : '';
      document.body.classList.toggle('kb', window.innerHeight - vv.height > 140);
      if (window.scrollY) window.scrollTo(0, 0);
    };
    vv.addEventListener('resize', fit); vv.addEventListener('scroll', fit); window.addEventListener('orientationchange', () => setTimeout(fit, 300)); fit();
  })();
  $('#scanCancel').addEventListener('click', closeScanner);
  $('#scanTorch').addEventListener('click', toggleTorch);
  $('#scanEngine').addEventListener('click', switchScanEngine);
  $('#scanPhoto').addEventListener('click', () => $('#scanFile').click());
  $('#scanFile').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; scanFromPhoto(f); });

  /* ===================== Arranque ===================== */
  async function refresh() {
    await reload();
    const typing = state.tab === 'add' || !$('#sheet').classList.contains('hidden');
    if (typing) updateBadges(); else render();
  }
  async function init() {
    try { db = await openDB(); } catch (e) { $('#view').innerHTML = '<div class="empty">Este navegador no permite guardar datos locales.</div>'; return; }
    await reload(); render();
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) { /* ignorar */ }
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
    let lastDay = D.toISO(T());
    setInterval(() => { const d = D.toISO(T()); if (d !== lastDay) { lastDay = d; refresh(); } }, 60000);
    setInterval(refresh, 3600000);
    if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => { /* sin offline */ });
  }
  window.__rotador = { openViewer: openViewer, state: state, Cat: Cat, importScalesFile: importScalesFile, buildScalesPDF: buildScalesPDF, enrich: enrich, importCatalogFile: importCatalogFile, buildPDF: buildPDF, buildRetiroPDF: buildRetiroPDF, retiroList: retiroList, porPedir: porPedir, computeAlerts: computeAlerts, generateRound: generateRound, setCheck: setCheck, reload: reload, render: render, ready: null };
  window.__rotador.ready = init();
})();

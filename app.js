/* Rotador · control de vencimientos y pedido de precios (PWA, offline) */
(function () {
  'use strict';
  const D = window.RotDates;
  const $ = (s, r) => (r || document).querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const norm = (s) => String(s || '').trim().toLowerCase();

  /* ===================== Estado ===================== */
  const DEFAULTS = { windowDays: 7, removeBefore: 1, promoManual: false, promoFrom: '', promoTo: '', snooze: {} };
  const state = {
    products: [], lots: [], rounds: [], settings: Object.assign({}, DEFAULTS),
    tab: 'home', filter: 'all', q: '', supplier: '', pedirTab: 'pedir',
    editingLotId: null, draft: {}
  };

  /* ===================== Base de datos local (IndexedDB) ===================== */
  let db;
  function openDB() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('rotador', 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        d.createObjectStore('products', { keyPath: 'id', autoIncrement: true });
        d.createObjectStore('lots', { keyPath: 'id', autoIncrement: true });
        d.createObjectStore('rounds', { keyPath: 'id', autoIncrement: true });
        d.createObjectStore('kv', { keyPath: 'key' });
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
  const del = (s, id) => tx(s, 'readwrite', (st) => st.delete(id));
  function replaceAll(data) {
    return new Promise((res, rej) => {
      const t = db.transaction(['products', 'lots', 'rounds', 'kv'], 'readwrite');
      ['products', 'lots', 'rounds'].forEach((n) => {
        const s = t.objectStore(n); s.clear();
        (data[n] || []).forEach((o) => s.put(o));
      });
      const kv = t.objectStore('kv'); kv.clear();
      if (data.settings) kv.put({ key: 'settings', value: data.settings });
      t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
    });
  }
  async function reload() {
    const r = await Promise.all([getAll('products'), getAll('lots'), getAll('rounds'), tx('kv', 'readonly', (s) => s.get('settings'))]);
    state.products = r[0]; state.lots = r[1]; state.rounds = r[2];
    state.settings = Object.assign({}, DEFAULTS, r[3] ? r[3].value : {});
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
    return Object.assign({}, l, {
      name: p.name || '(sin nombre)', code: p.code || '', codeType: p.codeType || '', unit: p.unit || 'und',
      supplier: p.supplier || 'Sin proveedor', dExp: dExp, dRem: dRem, urg: D.urgency(dRem)
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
    return activeLots().filter((l) => !l.sale && !pend.has(l.id) && l.dExp >= 0 && l.dExp <= w)
      .sort((a, b) => a.dExp - b.dExp || a.name.localeCompare(b.name));
  }
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
  function lotCard(l) {
    const tags = [];
    if (l.sale) tags.push('<span class="tag">En rebaja · ' + esc(l.sale.type === '2x1' ? '2x1' : 'precio') + (l.sale.note ? ' · ' + esc(l.sale.note) : '') + '</span>');
    return '<article class="lot ' + l.urg + '"><div class="lot-main" data-action="open-lot" data-id="' + l.id + '">' +
      '<div class="lot-name">' + esc(l.name) + '</div>' +
      '<div class="lot-sub">' + (l.lot ? 'Lote ' + esc(l.lot) + ' · ' : '') + esc(qtyText(l.qty, l.unit)) + ' · ' + esc(l.supplier) + '</div>' +
      '<div class="lot-dates">Vence ' + D.fmt(D.fromISO(l.expiry)) + ' · <span class="when">' + whenText(l) + '</span></div>' +
      (tags.length ? '<div>' + tags.join('') + '</div>' : '') + '</div>' +
      '<button class="btn-mini" data-action="remove-lot" data-id="' + l.id + '">Retirado</button></article>';
  }

  function viewHome() {
    const w = state.settings.windowDays;
    let lots = activeLots();
    const red = lots.filter((l) => l.dRem <= 0).length;
    const near = lots.filter((l) => l.dRem > 0 && l.dExp <= w).length;
    const suppliers = Array.from(new Set(state.products.map((p) => p.supplier).filter(Boolean))).sort();
    const f = state.filter;
    if (f === 'red') lots = lots.filter((l) => l.dRem <= 0);
    else if (f === 'soon') lots = lots.filter((l) => l.dRem <= 3);
    else if (f === 'week') lots = lots.filter((l) => l.dExp <= w);
    else if (f === 'sale') lots = lots.filter((l) => l.sale);
    if (state.supplier) lots = lots.filter((l) => l.supplier === state.supplier);
    const q = norm(state.q);
    if (q) lots = lots.filter((l) => norm(l.name).includes(q) || norm(l.code).includes(q) || norm(l.lot).includes(q));
    lots.sort((a, b) => a.dExp - b.dExp || a.name.localeCompare(b.name));
    const chip = (k, t) => '<button class="chip ' + (f === k ? 'on' : '') + '" data-action="filter" data-f="' + k + '">' + t + '</button>';
    const total = state.lots.filter((l) => l.status === 'active').length;
    return alertsHTML() +
      '<div class="stats"><div class="stat red"><b>' + red + '</b><span>Retirar hoy o atrasados</span></div>' +
      '<div class="stat orange"><b>' + near + '</b><span>Vencen en ≤ ' + w + ' días</span></div></div>' +
      '<input type="search" id="q" placeholder="Buscar producto, código o lote" value="' + esc(state.q) + '">' +
      '<div class="chips">' + chip('all', 'Todos') + chip('red', '🔴 Retirar hoy') + chip('soon', '🟠 ≤ 3 días') + chip('week', '≤ ' + w + ' días') + chip('sale', 'En rebaja') + '</div>' +
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
    const names = Array.from(new Set(state.products.map((x) => x.name))).sort();
    const sups = Array.from(new Set(state.products.map((x) => x.supplier).filter(Boolean))).sort();
    return '<h2>' + (edit ? 'Editar lote' : 'Agregar producto') + '</h2>' +
      '<form id="lotForm" autocomplete="off">' +
      '<label class="f" for="f-code">Código (EAN o PLU)</label>' +
      '<div class="row"><input id="f-code" inputmode="numeric" placeholder="Escanea o escribe" value="' + esc(d.code || '') + '" class="grow">' +
      '<button type="button" class="btn" data-action="scan" aria-label="Escanear">📷</button></div>' +
      '<div class="row" style="margin-top:6px"><select id="f-ctype" style="width:auto"><option value="EAN"' + ((d.codeType || 'EAN') === 'EAN' ? ' selected' : '') + '>EAN</option><option value="PLU"' + (d.codeType === 'PLU' ? ' selected' : '') + '>PLU</option></select>' +
      '<span class="muted small" id="codeHint"></span></div>' +
      '<label class="f" for="f-name">Nombre</label><input id="f-name" list="dl-names" required value="' + esc(d.name || '') + '">' +
      '<datalist id="dl-names">' + names.map((n) => '<option value="' + esc(n) + '">').join('') + '</datalist>' +
      '<label class="f">Se cuenta en</label><div class="seg"><label><input type="radio" name="f-unit" value="und" hidden' + (unit === 'und' ? ' checked' : '') + '><span class="segopt">Unidades</span></label>' +
      '<label><input type="radio" name="f-unit" value="kg" hidden' + (unit === 'kg' ? ' checked' : '') + '><span class="segopt">Kilos</span></label></div>' +
      '<label class="f" for="f-supplier">Proveedor</label><input id="f-supplier" list="dl-sups" value="' + esc(d.supplier || '') + '">' +
      '<datalist id="dl-sups">' + sups.map((n) => '<option value="' + esc(n) + '">').join('') + '</datalist>' +
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
    const list = porPedir();
    const nx = D.isRequestDay(T(), state.settings) ? null : nextRequest();
    if (!list.length) return '<div class="empty">No hay lotes por pedir 👌<br><span class="small">Aparecen cuando vencen en ' + state.settings.windowDays + ' días o menos.</span></div>';
    const groups = {};
    list.forEach((l) => { (groups[l.supplier] = groups[l.supplier] || []).push(l); });
    let h = '<div class="row wrap" style="margin-bottom:6px"><span class="small muted">Todos a:</span>' +
      '<button class="btn-mini" data-action="bulk-type" data-type="precio">Precio</button><button class="btn-mini" data-action="bulk-type" data-type="2x1">2x1</button></div>';
    Object.keys(groups).sort().forEach((sup) => {
      h += '<div class="supplier">' + esc(sup) + '</div>';
      groups[sup].forEach((l) => {
        const type = l.reqType || 'precio';
        const tags = [];
        if (nx && D.diffDays(T(), nx) >= l.dRem) tags.push('<span class="tag warn">⚠️ Pedir ya</span>');
        if (l.lastFail) tags.push('<span class="tag bad">Sin precio el ' + D.fmt(D.fromISO(l.lastFail)) + '</span>');
        h += '<div class="plot ' + (l.urg === 'green' ? '' : l.urg) + '"><div class="row"><div class="grow"><b>' + esc(l.name) + '</b><div class="lot-sub">' +
          (l.lot ? 'Lote ' + esc(l.lot) + ' · ' : '') + esc(qtyText(l.qty, l.unit)) + '</div>' +
          '<div class="lot-dates">Vence ' + D.fmt(D.fromISO(l.expiry)) + ' (en ' + l.dExp + ' d) · <span class="when">' + whenText(l) + '</span></div>' +
          (tags.length ? '<div>' + tags.join('') + '</div>' : '') + '</div></div>' +
          '<div class="row" style="margin-top:8px"><div class="seg">' +
          '<button class="' + (type === 'precio' ? 'on' : '') + '" data-action="set-type" data-id="' + l.id + '" data-type="precio">Precio</button>' +
          '<button class="' + (type === '2x1' ? 'on' : '') + '" data-action="set-type" data-id="' + l.id + '" data-type="2x1">2x1</button></div></div>' +
          '<input class="note" placeholder="Nota (opcional)" value="' + esc(l.reqNote || '') + '" data-change="req-note" data-id="' + l.id + '"></div>';
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
    const sorted = items.slice().sort((a, b) => (a.snap.supplier || '').localeCompare(b.snap.supplier || '') || a.snap.name.localeCompare(b.snap.name));
    let h = '<section class="card"><div class="row wrap"><div class="grow"><b>Ronda del ' + D.fmt(D.fromISO(r.date)) + '</b><div class="small muted">Verificar: ' + D.fmt(D.fromISO(r.verifyDate)) + '</div></div>' + status + '</div>' +
      '<div class="row wrap" style="margin:8px 0">' + (pend ? '<button class="btn-mini" data-action="check-all" data-round="' + r.id + '">✅ Marcar todos</button>' : '') +
      '<button class="btn-mini" data-action="round-pdf" data-round="' + r.id + '">📄 PDF</button></div>';
    sorted.forEach((i) => {
      const cur = i.check;
      const b = (v, label) => '<button class="ck ' + v + ' ' + (cur === v ? 'on' : '') + '" data-action="check" data-round="' + r.id + '" data-lot="' + i.lotId + '" data-val="' + v + '">' + label + '</button>';
      h += '<div class="plot" style="border-left-color:var(--line)"><b>' + esc(i.snap.name) + '</b> <span class="tag">' + esc(i.type === '2x1' ? '2x1' : 'Precio') + '</span>' +
        '<div class="lot-sub">' + (i.snap.lot ? 'Lote ' + esc(i.snap.lot) + ' · ' : '') + esc(qtyText(i.snap.qty, i.snap.unit)) + ' · ' + esc(i.snap.supplier || '') + '</div>' +
        '<div class="checks">' + b('pending', '⬜ Pendiente') + b('ok', '✅ Sí') + b('no', '❌ No') + '</div>' +
        '<input class="note" placeholder="Precio nuevo o nota" value="' + esc(i.price || '') + '" data-change="item-price" data-round="' + r.id + '" data-lot="' + i.lotId + '"></div>';
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
      (state.pedirTab === 'pedir' ? pedirList() : viewVerificar());
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
      '<div class="card"><b>Copia de seguridad</b><p class="small muted" style="margin:4px 0 10px">Tus datos viven solo en este teléfono. Exporta una copia de vez en cuando.</p>' +
      '<div class="row wrap"><button class="btn grow" data-action="export">Exportar copia</button><button class="btn grow" data-action="import">Importar copia</button></div>' +
      '<input type="file" id="importFile" accept=".json,application/json" class="hidden"><p class="small muted" id="persistInfo" style="margin:10px 0 0"></p></div>' +
      '<div class="card"><b>Instalar en el teléfono</b><p class="small muted" style="margin:4px 0 0">iPhone: Safari → Compartir → “Agregar a pantalla de inicio”.<br>Android: Chrome → menú ⋮ → “Instalar app”.<br>Ábrela una vez con internet para que funcione sin conexión.</p></div>' +
      '<button class="btn danger block" data-action="wipe">Borrar todos los datos</button>';
  }

  function render() {
    const y = window.scrollY;
    const v = $('#view');
    v.innerHTML = state.tab === 'home' ? viewHome() : state.tab === 'add' ? viewAdd() : state.tab === 'pedir' ? viewPedir() : viewSettings();
    document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === state.tab));
    updateBadges();
    window.scrollTo(0, y);
    if (state.tab === 'settings') updatePersistInfo();
  }
  function setTab(t) { state.tab = t; if (t !== 'add') { state.editingLotId = null; } render(); window.scrollTo(0, 0); }

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
    const qty = parseFloat(g('f-qty').replace(',', '.'));
    const codeType = code ? (g('f-ctype') || guessType(code)) : '';
    if (!name) return toast('Falta el nombre');
    if (!expiry) return toast('Falta la fecha de vencimiento');
    if (!(qty > 0)) return toast('Falta la cantidad');
    const edit = state.editingLotId ? lotById(state.editingLotId) : null;
    let prod = edit ? prodById(edit.productId)
      : (code ? state.products.find((p) => p.code === code) : state.products.find((p) => norm(p.name) === norm(name)));
    const data = { name: name, code: code, codeType: codeType, unit: unit, supplier: supplier };
    if (prod) { Object.assign(prod, data); await put('products', prod); }
    else { prod = Object.assign({}, data); prod.id = await put('products', prod); }
    if (edit) { Object.assign(edit, { lot: lotNo, expiry: expiry, qty: qty }); await put('lots', edit); }
    else await put('lots', { productId: prod.id, lot: lotNo, expiry: expiry, qty: qty, status: 'active', reqType: 'precio', reqNote: '', sale: null, lastFail: null, createdAt: Date.now() });
    await reload();
    if (edit) { state.editingLotId = null; state.tab = 'home'; toast('Cambios guardados'); }
    else if (again) { state.draft = { supplier: supplier }; toast('Guardado. Agrega el siguiente'); }
    else { state.draft = {}; state.tab = 'home'; toast('Lote guardado'); }
    render(); window.scrollTo(0, 0);
  }

  async function removeLot(id) {
    const l = lotById(id); if (!l) return;
    l.status = 'removed'; l.removedAt = D.toISO(T());
    await put('lots', l); await reload(); closeSheet(); render();
    toast('Lote retirado', 'Deshacer', async () => { const x = lotById(id); x.status = 'active'; x.removedAt = null; await put('lots', x); await reload(); render(); });
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
      if (val === 'ok') { lot.sale = { type: it.type, note: it.price || it.note || '', date: D.toISO(T()) }; lot.lastFail = null; }
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
  function buildPDF(round) {
    const J = window.jspdf.jsPDF;
    const doc = new J({ unit: 'mm', format: 'letter' });
    const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight(), M = 12;
    const cols = [{ t: 'Producto', w: 60 }, { t: 'Código', w: 28 }, { t: 'Lote', w: 20 }, { t: 'Vence', w: 23 }, { t: 'Retirar el', w: 25 }, { t: 'Cant.', w: 16 }, { t: 'Solicitud', w: 19.9 }];
    const rd = D.fromISO(round.date), before = state.settings.removeBefore, items = round.items;
    const COLORS = { red: [220, 38, 38], orange: [234, 88, 12], yellow: [202, 138, 4], green: [22, 163, 74] };
    let y = M;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(16); doc.text('Rotador · Pedir precios', M, y + 5); y += 9;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10);
    doc.text('Fecha: ' + D.fmtFull(rd) + '   ·   Verificar: ' + D.fmtFull(D.fromISO(round.verifyDate)), M, y + 3); y += 6;
    const n2 = items.filter((i) => i.type === '2x1').length;
    doc.text(items.length + (items.length === 1 ? ' lote' : ' lotes') + ': ' + (items.length - n2) + ' para precio · ' + n2 + ' para 2x1', M, y + 3); y += 9;
    const header = () => {
      doc.setFillColor(229, 236, 233); doc.rect(M, y, W - 2 * M, 6, 'F');
      doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5); doc.setTextColor(30);
      let x = M; cols.forEach((c) => { doc.text(c.t, x + 1.5, y + 4.2); x += c.w; }); y += 6.5;
      doc.setFont('helvetica', 'normal');
    };
    const groups = {};
    items.forEach((i) => { const k = i.snap.supplier || 'Sin proveedor'; (groups[k] = groups[k] || []).push(i); });
    Object.keys(groups).sort().forEach((sup) => {
      if (y + 24 > H - 14) { doc.addPage(); y = M; }
      doc.setFillColor(15, 118, 110); doc.rect(M, y, W - 2 * M, 7, 'F');
      doc.setTextColor(255); doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.text(sup, M + 2, y + 5); y += 10; doc.setTextColor(0);
      [['precio', 'Pedir precio'], ['2x1', 'Pedir 2x1']].forEach((tp) => {
        const arr = groups[sup].filter((i) => (i.type === '2x1' ? '2x1' : 'precio') === tp[0]).sort((a, b) => a.snap.expiry < b.snap.expiry ? -1 : 1);
        if (!arr.length) return;
        if (y + 22 > H - 14) { doc.addPage(); y = M; }
        doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(0); doc.text(tp[1] + ' (' + arr.length + ')', M, y + 4); y += 6;
        header();
        arr.forEach((i) => {
          const s = i.snap;
          doc.setFontSize(9);
          const nameLines = doc.splitTextToSize(s.name || '', cols[0].w - 3);
          const noteLines = i.note ? doc.splitTextToSize('Nota: ' + i.note, cols[0].w - 3) : [];
          const rowH = Math.max(nameLines.length * 4, 4) + noteLines.length * 3.4 + 2.5;
          if (y + rowH > H - 14) { doc.addPage(); y = M; header(); }
          const dExp = D.diffDays(rd, D.fromISO(s.expiry)), dRem = dExp - before;
          let x = M;
          doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(0);
          doc.text(nameLines, x + 1.5, y + 4); x += cols[0].w;
          if (noteLines.length) { doc.setFontSize(8); doc.setTextColor(110); doc.text(noteLines, M + 1.5, y + 4 + nameLines.length * 4 - 0.4); doc.setFontSize(9); doc.setTextColor(0); }
          doc.text(String(s.code || '—'), x + 1.5, y + 4); x += cols[1].w;
          doc.text(String(s.lot || '—'), x + 1.5, y + 4); x += cols[2].w;
          doc.text(D.fmt(D.fromISO(s.expiry)), x + 1.5, y + 4); x += cols[3].w;
          const c = COLORS[D.urgency(dRem)]; doc.setFillColor(c[0], c[1], c[2]); doc.circle(x + 2.6, y + 3.2, 1.3, 'F');
          doc.text(D.fmt(D.addDays(D.fromISO(s.expiry), -before)), x + 5.4, y + 4); x += cols[4].w;
          doc.text(qtyText(s.qty, s.unit), x + 1.5, y + 4); x += cols[5].w;
          doc.setFont('helvetica', 'bold'); doc.text(i.type === '2x1' ? '2x1' : 'Precio', x + 1.5, y + 4);
          doc.setDrawColor(220); doc.line(M, y + rowH, W - M, y + rowH);
          y += rowH + 0.4;
        });
        y += 4;
      });
      y += 2;
    });
    const n = doc.getNumberOfPages();
    for (let p = 1; p <= n; p++) {
      doc.setPage(p); doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(120);
      doc.text('Página ' + p + ' de ' + n, W - M, H - 6, { align: 'right' });
      doc.text('Generado con Rotador', M, H - 6);
    }
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
    const list = porPedir();
    if (!list.length) return toast('No hay lotes por pedir');
    const t = T(), iso = D.toISO(t);
    const items = list.map((l) => ({
      lotId: l.id, type: l.reqType === '2x1' ? '2x1' : 'precio', note: l.reqNote || '', check: 'pending', price: '',
      snap: { name: l.name, code: l.code, codeType: l.codeType, supplier: l.supplier, lot: l.lot, expiry: l.expiry, qty: l.qty, unit: l.unit }
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
  async function openScanner() {
    if (!window.Html5Qrcode) return toast('El escáner no está disponible. Escribe el código.');
    $('#scanner').classList.remove('hidden');
    try {
      const F = window.Html5QrcodeSupportedFormats;
      scanner = new window.Html5Qrcode('reader', { formatsToSupport: [F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E, F.CODE_128, F.CODE_39], useBarCodeDetectorIfSupported: true, verbose: false });
      await scanner.start({ facingMode: 'environment' }, { fps: 10, qrbox: { width: 260, height: 140 } },
        (text) => { const c = String(text).trim(); closeScanner().then(() => { const i = $('#f-code'); if (i) { i.value = c; onCodeInput(); } if (navigator.vibrate) navigator.vibrate(60); }); },
        () => { /* sin lectura en este cuadro */ });
    } catch (e) {
      await closeScanner();
      toast('No se pudo abrir la cámara. Revisa el permiso o escribe el código.');
    }
  }
  async function closeScanner() {
    $('#scanner').classList.add('hidden');
    if (scanner) { try { await scanner.stop(); scanner.clear(); } catch (e) { /* ya detenido */ } scanner = null; }
  }

  /* ===================== Formulario: autocompletado ===================== */
  function fillFromProduct(p, force) {
    if (!p) return;
    if (force || !$('#f-name').value.trim()) $('#f-name').value = p.name || '';
    if (!$('#f-supplier').value.trim()) $('#f-supplier').value = p.supplier || '';
    const r = document.querySelector('input[name=f-unit][value="' + (p.unit || 'und') + '"]'); if (r) r.checked = true;
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

  /* ===================== Respaldo ===================== */
  async function exportData() {
    const data = { app: 'rotador', version: 1, exportedAt: new Date().toISOString(), products: state.products, lots: state.lots, rounds: state.rounds, settings: state.settings };
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    await shareOrDownload(blob, 'rotador-respaldo_' + D.toISO(T()) + '.json', 'application/json', 'Respaldo de Rotador');
  }
  async function importData(file) {
    try {
      const data = JSON.parse(await file.text());
      if (data.app !== 'rotador' || !Array.isArray(data.lots) || !Array.isArray(data.products)) throw new Error('formato');
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
      closeSheet(); if (a.go.filter) state.filter = a.go.filter; if (a.go.pedirTab) state.pedirTab = a.go.pedirTab; setTab(a.go.tab);
    },
    'alert-snooze': async (el) => {
      state.settings.snooze[el.dataset.key] = D.toISO(D.addDays(T(), 1)); await saveSettings();
      const sheetOpen = !$('#sheet').classList.contains('hidden');
      if (sheetOpen) openSheet('<h2>🔔 Avisos</h2>' + alertsHTML() + '<button class="btn block" data-action="close-sheet">Cerrar</button>');
      render();
    },
    'filter': (el) => { state.filter = el.dataset.f; render(); },
    'open-lot': (el) => {
      const l = activeLots().find((x) => x.id === Number(el.dataset.id)); if (!l) return;
      openSheet('<h2>' + esc(l.name) + '</h2><dl class="kv"><dt>Código</dt><dd>' + esc(l.code ? l.codeType + ' ' + l.code : '—') + '</dd>' +
        '<dt>Lote</dt><dd>' + esc(l.lot || '—') + '</dd><dt>Cantidad</dt><dd>' + esc(qtyText(l.qty, l.unit)) + '</dd><dt>Proveedor</dt><dd>' + esc(l.supplier) + '</dd>' +
        '<dt>Vence</dt><dd>' + D.fmtFull(D.fromISO(l.expiry)) + '</dd><dt>Retirar</dt><dd>' + D.fmtFull(D.addDays(D.fromISO(l.expiry), -state.settings.removeBefore)) + '</dd>' +
        '<dt>Estado</dt><dd>' + (l.sale ? 'En rebaja (' + esc(l.sale.type) + ')' : 'Sin rebaja') + '</dd></dl>' +
        '<div class="row wrap"><button class="btn primary grow" data-action="remove-lot" data-id="' + l.id + '">Retirado</button>' +
        '<button class="btn grow" data-action="edit-lot" data-id="' + l.id + '">Editar</button></div>' +
        '<div class="row wrap" style="margin-top:8px"><button class="btn danger grow" data-action="delete-lot" data-id="' + l.id + '">Eliminar</button>' +
        '<button class="btn grow" data-action="close-sheet">Cerrar</button></div>');
    },
    'remove-lot': (el) => removeLot(Number(el.dataset.id)),
    'delete-lot': (el) => deleteLot(Number(el.dataset.id)),
    'edit-lot': (el) => { closeSheet(); state.editingLotId = Number(el.dataset.id); state.tab = 'add'; render(); window.scrollTo(0, 0); },
    'cancel-edit': () => { state.editingLotId = null; setTab('home'); },
    'scan': () => openScanner(),
    'save-again': () => saveLot(true),
    'pedir-tab': (el) => { state.pedirTab = el.dataset.t; render(); },
    'set-type': async (el) => { const l = lotById(Number(el.dataset.id)); if (!l) return; l.reqType = el.dataset.type; await put('lots', l); await reload(); render(); },
    'bulk-type': async (el) => {
      const ids = porPedir().map((l) => l.id);
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
      for (const i of roundPending(r)) { i.check = 'ok'; const l = lotById(i.lotId); l.sale = { type: i.type, note: i.price || i.note || '', date: D.toISO(T()) }; l.lastFail = null; await put('lots', l); }
      await put('rounds', r); await reload(); toast('Ronda completa ✅'); render();
    },
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
    else if (t.id === 'q') { state.q = t.value; const pos = t.selectionStart; render(); const q = $('#q'); if (q) { q.focus(); try { q.setSelectionRange(pos, pos); } catch (x) { /* ignorar */ } } }
  });
  document.addEventListener('change', async (e) => {
    const t = e.target;
    if (t.id === 'f-name') onNameChange();
    else if (t.name === 'f-unit') updateUnitLbl();
    else if (t.id === 'supSel') { state.supplier = t.value; render(); }
    else if (t.dataset.setting) {
      const k = t.dataset.setting;
      if (t.type === 'checkbox') state.settings[k] = t.checked;
      else if (t.type === 'number') { const n = parseInt(t.value, 10); state.settings[k] = isNaN(n) ? DEFAULTS[k] : Math.max(Number(t.min) || 0, Math.min(Number(t.max) || 99, n)); }
      else state.settings[k] = t.value;
      await saveSettings(); render();
    } else if (t.dataset.change === 'req-note') {
      const l = lotById(Number(t.dataset.id)); if (l) { l.reqNote = t.value.trim(); await put('lots', l); await reload(); }
    } else if (t.dataset.change === 'item-price') {
      const r = state.rounds.find((x) => x.id === Number(t.dataset.round)); if (!r) return;
      const it = r.items.find((i) => i.lotId === Number(t.dataset.lot)); if (!it) return;
      it.price = t.value.trim(); await put('rounds', r);
      const l = lotById(it.lotId); if (l && l.sale && it.check === 'ok') { l.sale.note = it.price || it.note || ''; await put('lots', l); }
      await reload();
    } else if (t.id === 'importFile' && t.files[0]) { await importData(t.files[0]); t.value = ''; }
  });
  $('#scanCancel').addEventListener('click', closeScanner);

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
  window.__rotador = { state: state, buildPDF: buildPDF, porPedir: porPedir, computeAlerts: computeAlerts, generateRound: generateRound, setCheck: setCheck, reload: reload, render: render, ready: null };
  window.__rotador.ready = init();
})();

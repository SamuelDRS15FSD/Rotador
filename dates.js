/* Rotador · lógica de fechas (sin dependencias, funciona offline) */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RotDates = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const pad = (n) => String(n).padStart(2, '0');
  const DOW = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
  const MON = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

  function toISO(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function fromISO(s) { const p = s.split('-').map(Number); return new Date(p[0], p[1] - 1, p[2]); }
  function addDays(d, n) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }
  function diffDays(a, b) { // b - a, en días calendario
    return Math.round((Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) - Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) / 86400000);
  }
  function today() { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate()); }
  function fmt(d) { return DOW[d.getDay()] + ' ' + d.getDate() + ' ' + MON[d.getMonth()]; }
  function fmtFull(d) { return fmt(d) + ' ' + d.getFullYear(); }

  /* ---------- Festivos de Colombia (ley Emiliani) ---------- */
  function easter(y) {
    const a = y % 19, b = Math.floor(y / 100), c = y % 100;
    const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
    const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
    const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
    const m = Math.floor((a + 11 * h + 22 * l) / 451);
    const month = Math.floor((h + l - 7 * m + 114) / 31);
    const day = ((h + l - 7 * m + 114) % 31) + 1;
    return new Date(y, month - 1, day);
  }
  function nextMonday(d) { // si no es lunes, pasa al lunes siguiente
    const dow = d.getDay();
    if (dow === 1) return d;
    return addDays(d, (8 - dow) % 7);
  }
  const cache = {};
  function holidays(y) {
    if (cache[y]) return cache[y];
    const h = {};
    const add = (d, name) => { h[toISO(d)] = name; };
    [[1, 1, 'Año Nuevo'], [5, 1, 'Día del Trabajo'], [7, 20, 'Día de la Independencia'],
      [8, 7, 'Batalla de Boyacá'], [12, 8, 'Inmaculada Concepción'], [12, 25, 'Navidad']]
      .forEach((x) => add(new Date(y, x[0] - 1, x[1]), x[2]));
    [[1, 6, 'Reyes Magos'], [3, 19, 'San José'], [6, 29, 'San Pedro y San Pablo'],
      [8, 15, 'Asunción de la Virgen'], [10, 12, 'Día de la Raza'], [11, 1, 'Todos los Santos'],
      [11, 11, 'Independencia de Cartagena']]
      .forEach((x) => add(nextMonday(new Date(y, x[0] - 1, x[1])), x[2]));
    const e = easter(y);
    add(addDays(e, -3), 'Jueves Santo');
    add(addDays(e, -2), 'Viernes Santo');
    add(nextMonday(addDays(e, 39)), 'Ascensión del Señor');
    add(nextMonday(addDays(e, 60)), 'Corpus Christi');
    add(nextMonday(addDays(e, 68)), 'Sagrado Corazón');
    cache[y] = h;
    return h;
  }
  function isHoliday(d) { return holidays(d.getFullYear())[toISO(d)] || null; }

  /* ---------- Días de pedir precios ---------- */
  // Normal: lunes y jueves. Si el lunes de esa semana es festivo
  // o hay promoción: martes y viernes. (El festivo solo aplica al lunes.)
  function mondayOf(d) { return addDays(d, -((d.getDay() + 6) % 7)); }
  function isPromo(d, s) {
    if (!s) return false;
    if (s.promoManual) return true;
    if (s.promoFrom && s.promoTo) { const iso = toISO(d); return iso >= s.promoFrom && iso <= s.promoTo; }
    return false;
  }
  function shiftReason(d, s) {
    const mon = mondayOf(d);
    const h = isHoliday(mon);
    if (h) return { type: 'festivo', name: h };
    if (isPromo(mon, s)) return { type: 'promo' };
    return null;
  }
  function requestDaysOfWeek(d, s) { return shiftReason(d, s) ? [2, 5] : [1, 4]; }
  function isRequestDay(d, s) { return requestDaysOfWeek(d, s).indexOf(d.getDay()) >= 0; }
  function nextRequestDay(from, s) { // primer día >= from que sea de pedir precios
    for (let i = 0; i < 30; i++) { const d = addDays(from, i); if (isRequestDay(d, s)) return d; }
    return null;
  }
  function verifyDay(requestDate) { return addDays(requestDate, 1); } // siempre el día siguiente

  /* ---------- Urgencia (fecha de retiro = vencimiento - N días) ---------- */
  function urgency(dRem) { return dRem <= 0 ? 'red' : dRem <= 3 ? 'orange' : dRem <= 6 ? 'yellow' : 'green'; }

  return { toISO, fromISO, addDays, diffDays, today, fmt, fmtFull, holidays, isHoliday, easter,
    mondayOf, isPromo, shiftReason, requestDaysOfWeek, isRequestDay, nextRequestDay, verifyDay, urgency };
});

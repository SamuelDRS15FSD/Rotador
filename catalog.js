/* Rotador · interpretación de catálogos (texto de PDF / imagen / CSV). Sin dependencias, probable en Node. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RotCatalog = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const norm = (s) => String(s || '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

  /* Convierte los fragmentos de texto de pdf.js en líneas (de arriba abajo, de izquierda a derecha).
     Dos espacios entre fragmentos = salto de columna. */
  function itemsToLines(items) {
    const rows = [];
    items.forEach((it) => {
      if (!it || !it.str || !it.str.trim()) return;
      const x = it.transform[4], y = it.transform[5];
      let row = rows.find((r) => Math.abs(r.y - y) <= 3);
      if (!row) { row = { y: y, parts: [] }; rows.push(row); }
      row.parts.push({ x: x, w: it.width || 0, s: it.str });
    });
    rows.sort((a, b) => b.y - a.y);
    return rows.map((r) => {
      r.parts.sort((a, b) => a.x - b.x);
      let out = '', end = null;
      r.parts.forEach((p) => {
        if (end !== null) { const gap = p.x - end; out += gap > 12 ? '  ' : gap > 1.2 ? ' ' : ''; }
        out += p.s.trim(); end = p.x + p.w;
      });
      return out;
    }).join('\n');
  }

  const CODE_RE = /(?<![\d.,$])\d{3,14}(?![\d]|[.,]\d)/g;
  const MONEY_RE = /\$\s?[\d.,]+|\b\d{1,3}(?:[.,]\d{3})+(?:[.,]\d+)?\b|\b\d+[.,]\d{1,2}\b/g;
  const HEADER_RE = /^(c[oó]digo|codigo|nombre|producto|descripci[oó]n|descripcion|proveedor|precio|p[aá]gina|page|cat[aá]logo|plu|ean|item|art[ií]culo)\b/i;

  function pickCode(line) {
    const toks = line.match(CODE_RE) || [];
    if (!toks.length) return '';
    const long = toks.find((t) => t.length >= 8);
    return long || toks.find((t) => t.length <= 7) || toks[0];
  }

  function cleanName(line, code) {
    let s = line.replace(/[;|\t]+/g, '  ');
    if (code) s = s.replace(code, ' ');
    s = s.replace(MONEY_RE, ' ');
    s = s.replace(/\s{2,}\d+\s*$/, ' ');                    // última columna solo numérica (precio sin formato)
    s = s.replace(/^\s*\d{1,3}\s*[.)\-]\s+/, ' ');         // numeración "12. " o "12) "
    s = s.replace(/(^|\s)[$€]+(?=\s|$)/g, ' ');
    s = s.replace(/\s{2,}/g, ' ').replace(/^[\s\-–—.,:]+|[\s\-–—.,:]+$/g, '');
    return s.trim();
  }

  function parseText(text) {
    const lines = String(text || '').split(/\r?\n/);
    const rows = [], seenCode = new Set(), seenName = new Set();
    lines.forEach((raw) => {
      const line = raw.replace(/ /g, ' ').trim();
      if (line.length < 3) return;
      const code = pickCode(line);
      const name = cleanName(line, code);
      const letters = (name.match(/[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/g) || []).length;
      if (letters < 3) return;
      if (HEADER_RE.test(name) && !code) return;
      if (HEADER_RE.test(name) && /^(c[oó]digo|nombre|producto|descripci)/i.test(name) && name.split(/\s+/).length <= 4) return;
      const nk = norm(name);
      if (code) { if (seenCode.has(code)) return; seenCode.add(code); }
      else { if (seenName.has(nk)) return; seenName.add(nk); }
      const unit = /\b(kg|kilo|kilos|granel)\b/i.test(name) ? 'kg' : 'und';
      rows.push({ code: code, name: name, unit: unit, checked: true });
    });
    // Si el documento sí trae códigos, las líneas sin código suelen ser títulos o ruido: quedan desmarcadas.
    const anyCode = rows.some((r) => r.code);
    if (anyCode) rows.forEach((r) => { if (!r.code) r.checked = false; });
    return rows;
  }

  /* Lista de balanzas: cada línea trae un nombre y uno o dos números (código de balanza y PLU).
     Las líneas sin números que dicen "Res", "Cerdo"… cambian la categoría de las filas siguientes. */
  const SCALE_CATS = ['res', 'bufalo', 'cerdo', 'pollo', 'pescado'];
  function parseScales(text, defCat) {
    let cat = defCat || '';
    const rows = [], seen = new Set();
    String(text || '').split(/\r?\n/).forEach((raw) => {
      let line = raw.replace(/ /g, ' ').trim();
      if (line.length < 2 || /^(p[aá]gina|page|hoja|fecha|rotador|generado)\b/i.test(line) || /\d+\s+c[oó]digos?\b/i.test(line)) return;
      if (!/\d/.test(line)) {
        const words = norm(line.replace(/[^\p{L}\s]/gu, ' ')).replace(/\s+/g, ' ').trim();
        const k = SCALE_CATS.find((c) => words === c || words.startsWith(c + ' '));
        if (k && words.split(' ').length <= 3) cat = k;
        return;
      }
      line = line.replace(/^\s*\d{1,3}\s*[.)\-]\s+/, '').replace(/[;|\t]+/g, '  ').replace(MONEY_RE, ' ');
      const nums = (line.match(/(?<![\d.,$])\d{1,14}(?![\d]|[.,]\d)/g) || []).slice(0, 2);
      if (!nums.length) return;
      let name = line;
      nums.forEach((n) => { name = name.replace(n, ' '); });
      // Varias columnas de texto separadas por 2+ espacios: la primera es el nombre, el resto el proveedor.
      const cells = name.split(/\s{2,}/).map((c) => c.replace(/^[\s\-–—.,:]+|[\s\-–—.,:]+$/g, '').trim()).filter(Boolean);
      name = cells[0] || ''; const supplier = cells.slice(1).join(' ');
      if ((name.match(/[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/g) || []).length < 3) return;
      let code = nums[0], plu = '';
      if (nums.length === 2) {
        if (nums[1].length < nums[0].length) { code = nums[1]; plu = nums[0]; }
        else if (nums[1].length > nums[0].length) { plu = nums[1]; }
        else { plu = nums[1]; }
      }
      const key = cat + '|' + code;
      if (seen.has(key)) return; seen.add(key);
      rows.push({ name: name, code: code, plu: plu, cat: cat, supplier: supplier, checked: true });
    });
    return rows;
  }

  /* Contenido de un QR / DataMatrix de producto → { code, lot, expiry (ISO), raw }.
     Reconoce GS1 (con paréntesis, en cadena o como enlace Digital Link), JSON y texto libre ("Lote: X  Vence: 31/12/2027"). */
  function toISODate(v) {
    v = String(v || '').trim(); let m;
    const pad = (n) => String(n).padStart(2, '0');
    if ((m = v.match(/^(\d{2})(\d{2})(\d{2})$/))) {                       // YYMMDD (GS1)
      let d = Number(m[3]); const mo = Number(m[2]), y = 2000 + Number(m[1]);
      if (d === 0) d = new Date(y, mo, 0).getDate();                       // día 00 = fin de mes
      return mo >= 1 && mo <= 12 && d >= 1 && d <= 31 ? y + '-' + pad(mo) + '-' + pad(d) : '';
    }
    if ((m = v.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/))) return m[1] + '-' + pad(m[2]) + '-' + pad(m[3]);
    if ((m = v.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2}|\d{4})$/))) return (m[3].length === 2 ? '20' + m[3] : m[3]) + '-' + pad(m[2]) + '-' + pad(m[1]); // día/mes/año
    return '';
  }
  const gtin = (v) => { v = String(v || '').replace(/\D/g, ''); return v.length === 14 && v[0] === '0' ? v.slice(1) : v; };
  const GS1_FIXED = { '00': 18, '01': 14, '02': 14, '11': 6, '13': 6, '15': 6, '17': 6, '20': 2 };
  const GS1_VAR = ['10', '21', '22', '30', '37', '91', '92', '93', '94', '95', '96', '97', '98', '99'];
  function parseScan(text) {
    const raw = String(text == null ? '' : text).trim(), out = { code: '', lot: '', expiry: '', raw: raw }; if (!raw) return out;
    const ai = {}; let m;
    // 1) Enlace GS1 Digital Link: https://sitio/01/<gtin>/10/<lote>/17/<aammdd>
    try {
      const u = new URL(raw); const seg = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      for (let i = 0; i < seg.length - 1; i++) if (/^\d{2,3}$/.test(seg[i])) { ai[seg[i]] = seg[i + 1]; i++; }
      u.searchParams.forEach((v, k) => { if (/^\d{2,3}$/.test(k)) ai[k] = v; });
    } catch (e) { /* no es un enlace */ }
    // 2) Con paréntesis: (01)0770...(17)271231(10)ABC
    if (!ai['01'] && /\(\d{2,4}\)/.test(raw)) { const re = /\((\d{2,4})\)([^(]*)/g; while ((m = re.exec(raw))) ai[m[1]] = m[2].trim(); }
    // 3) Cadena GS1 sin paréntesis (separador FNC1 = carácter 29)
    if (!ai['01'] && /^01\d{14}/.test(raw)) {
      let i = 0; const t = raw;
      while (i < t.length) {
        if (t[i] === '\u001d') { i++; continue; }
        const k2 = t.substr(i, 2);
        if (GS1_FIXED[k2]) { ai[k2] = t.substr(i + 2, GS1_FIXED[k2]); i += 2 + GS1_FIXED[k2]; }
        else if (GS1_VAR.includes(k2)) { let j = i + 2; while (j < t.length && t[j] !== '\u001d' && t[j] !== 'è') j++; ai[k2] = t.slice(i + 2, j); i = j + 1; }
        else break;
      }
    }
    if (ai['01']) {
      out.code = gtin(ai['01']); out.lot = ai['10'] || '';
      out.expiry = toISODate(ai['17']) || toISODate(ai['15']) || toISODate(ai['16']) || '';
      return out;
    }
    // 4) JSON
    if (/^\s*\{/.test(raw)) {
      try {
        const o = JSON.parse(raw), g = (...ks) => { for (const k of Object.keys(o)) if (ks.includes(norm(k))) return o[k]; return ''; };
        out.code = String(g('code', 'codigo', 'ean', 'gtin', 'plu', 'sku') || '').trim();
        out.lot = String(g('lote', 'lot', 'batch') || '').trim();
        out.expiry = toISODate(g('vence', 'vencimiento', 'expiry', 'exp', 'expira', 'caducidad', 'bestbefore', 'fecha')) || '';
        if (out.code || out.lot || out.expiry) return out;
      } catch (e) { /* no es JSON válido */ }
    }
    // 5) Texto libre
    const lot = raw.match(/(?:lote|lot|batch)\s*[:#=\-]?\s*([A-Za-z0-9][A-Za-z0-9\-\/]*)/i);
    const exp = raw.match(/(?:vence|venc\w*|vto|exp\w*|best\s*before|cad\w*|consumir\s+antes\s+de)\s*[:=\-]?\s*(\d{1,4}[\/\-.]\d{1,2}[\/\-.]\d{1,4}|\d{6})/i);
    const cod = raw.match(/(?:ean|gtin|c[oó]digo|plu|sku)\s*[:=#\-]?\s*(\d{3,14})/i);
    if (lot) out.lot = lot[1]; if (exp) out.expiry = toISODate(exp[1]); if (cod) out.code = gtin(cod[1]);
    if (out.code || out.lot || out.expiry) return out;
    // 6) Solo un número (o texto corto): se usa como código
    out.code = /^\d{14}$/.test(raw) ? gtin(raw) : raw;
    return out;
  }

  return { itemsToLines, parseText, parseScales, parseScan, toISODate, pickCode, cleanName };
});

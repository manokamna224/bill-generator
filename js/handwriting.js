/* ===========================================================================
   handwriting.js — realistic handwriting renderer for the Bill Generator.
   Exposes a single global: window.Handwriting
   - renderComputerized(container, bill, paperSize, calc) -> HTML receipt
   - renderHandwritten(container, bill, paperSize, calc) -> inline <svg>
   Per-character variation is SEEDED by (bill.renderSeed ^ hash(text)) so the
   same bill renders identically across reloads, while different bills differ.
   =========================================================================== */
(function () {
  "use strict";

  /* ----- Font roster ------------------------------------------------------- */
  // Six are SIL OFL; Homemade Apple + Just Another Hand are Apache 2.0.
  // License texts are bundled next to the .ttf files in assets/fonts/.
  var PRIMARY = "Patrick Hand";
  var ALTERNATES = [
    "Caveat", "Kalam", "Indie Flower", "Gaegu",
    "Shadows Into Light", "Homemade Apple", "Just Another Hand"
  ];
  var ALL_FAMILIES = [PRIMARY].concat(ALTERNATES);

  /* ----- PRNG (mulberry32) + FNV-1a hash ----------------------------------- */
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hash32(str) {
    var h = 2166136261 >>> 0;
    str = String(str);
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }
  function rngFor(bill, text) {
    var seed = ((bill && typeof bill.renderSeed === "number" ? bill.renderSeed : 0) ^ hash32(text)) >>> 0;
    return mulberry32(seed);
  }
  function lerp(a, b, t) { return a + (b - a) * t; }

  /* ----- Ink colours ------------------------------------------------------- */
  // 70% dark blue, 20% blue-black, 10% blue — pen-in-blue range.
  function pickColor(rnd) {
    var r = rnd();
    if (r < 0.70) return "#1f2a6b";
    if (r < 0.90) return "#13305c";
    return "#102a8a";
  }

  /* ----- Text measurement (offscreen Canvas 2D) --------------------------- */
  var _ctx = null;
  function ctx() {
    if (!_ctx) {
      var c = document.createElement("canvas");
      _ctx = c.getContext("2d");
    }
    return _ctx;
  }
  function charWidth(ch, family, size) {
    try {
      var c = ctx();
      c.font = size + 'px "' + family + '"';
      var w = c.measureText(ch).width;
      return w || size * 0.55;
    } catch (e) {
      return size * 0.55;
    }
  }
  function measureLine(text, family, size) {
    var w = 0;
    text = String(text);
    for (var i = 0; i < text.length; i++) {
      var ch = text.charAt(i);
      if (ch === " ") { w += size * 0.3; continue; }
      w += charWidth(ch, family || PRIMARY, size);
    }
    return w;
  }

  /* ----- Font load status -------------------------------------------------- */
  var _loaded = null; // null = not yet checked; array otherwise
  var _loadingPromise = null;
  function fontsReady() {
    if (!document.fonts || !document.fonts.load) {
      if (_loaded === null) _loaded = [];
      return Promise.resolve(false);
    }
    if (_loaded !== null) return Promise.resolve(_loaded.indexOf(PRIMARY) >= 0);
    if (_loadingPromise) return _loadingPromise; // single-flight: don't recompute concurrently
    _loadingPromise = Promise.all(ALL_FAMILIES.map(function (fam) {
      return document.fonts.load('16px "' + fam + '"').then(function () {
        return document.fonts.check('16px "' + fam + '"') ? fam : null;
      }, function () { return null; /* family unavailable */ });
    })).then(function (results) {
      // Deterministic order (ALL_FAMILIES order) so the same bill renders
      // identically across reloads and the alternate-substitution list is stable.
      _loaded = ALL_FAMILIES.filter(function (f) { return results.indexOf(f) >= 0; });
      _loadingPromise = null;
      return _loaded.indexOf(PRIMARY) >= 0;
    });
    return _loadingPromise;
  }
  function loadedFontFamilies() {
    return _loaded ? _loaded.slice() : [];
  }
  function loadedAlts() {
    var loaded = loadedFontFamilies();
    var alts = loaded.filter(function (f) { return f !== PRIMARY; });
    return alts.length ? alts : ALTERNATES.slice(); // if not yet checked, assume all (browser falls back per font)
  }
  function effectivePrimary() {
    var loaded = loadedFontFamilies();
    return loaded.length ? (loaded.indexOf(PRIMARY) >= 0 ? PRIMARY : loaded[0]) : PRIMARY;
  }

  /* ----- SVG element helper ----------------------------------------------- */
  var SVGNS = "http://www.w3.org/2000/svg";
  function el(tag, attrs, parent) {
    var n = document.createElementNS(SVGNS, tag);
    if (attrs) for (var k in attrs) if (Object.prototype.hasOwnProperty.call(attrs, k)) {
      n.setAttribute(k, attrs[k]);
    }
    if (parent) parent.appendChild(n);
    return n;
  }

  /* ----- Per-character placement ----------------------------------------- */
  function pickFont(rnd, primary, alts) {
    if (alts.length && rnd() < 0.12) {
      return alts[Math.floor(rnd() * alts.length) % alts.length];
    }
    return primary;
  }

  // Draw a run of text with per-char seeded variation. Returns new x.
  function drawChars(parent, text, x, baselineY, size, rnd, opts) {
    opts = opts || {};
    var primary = opts.primary || effectivePrimary();
    var alts = opts.alternates || loadedAlts();
    text = String(text);
    for (var i = 0; i < text.length; i++) {
      var ch = text.charAt(i);
      if (ch === " " || ch === "\n") {
        x += charWidth(" ", primary, size) * 0.6;
        continue;
      }
      // consume params in fixed order (matches design §7.3)
      var r = lerp(-4.5, 4.5, rnd());
      var dx = lerp(-1.5, 1.5, rnd());
      var dy = lerp(-1.5, 1.5, rnd());
      var s = lerp(0.93, 1.07, rnd());
      var op = lerp(0.80, 1.00, rnd());
      var lsf = lerp(0.94, 1.12, rnd());
      var color = pickColor(rnd);
      var family = pickFont(rnd, primary, alts);
      var w = charWidth(ch, family, size) || size * 0.55;
      var tx = x + dx;
      var ty = baselineY + dy;
      var t = "translate(" + tx.toFixed(2) + " " + ty.toFixed(2) + ") rotate(" +
              r.toFixed(2) + ") scale(" + s.toFixed(3) + ")";
      var tnode = el("text", {
        "font-family": '"' + family + '"',
        "font-size": size,
        fill: color,
        "fill-opacity": op.toFixed(2),
        transform: t
      }, parent);
      tnode.textContent = ch;
      x += w * lsf;
    }
    return x;
  }

  function drawLeft(parent, text, x, baselineY, size, rnd, opts) {
    return drawChars(parent, text, x, baselineY, size, rnd, opts);
  }
  function drawCentered(parent, text, centerX, baselineY, size, rnd, opts) {
    opts = opts || {};
    var fam = opts.primary || effectivePrimary();
    var w = measureLine(text, fam, size);
    return drawChars(parent, text, centerX - w / 2, baselineY, size, rnd, opts);
  }
  function drawRight(parent, text, rightX, baselineY, size, rnd, opts) {
    opts = opts || {};
    var fam = opts.primary || effectivePrimary();
    var w = measureLine(text, fam, size);
    return drawChars(parent, text, rightX - w, baselineY, size, rnd, opts);
  }
  // Word-wrap a paragraph; returns the new y (below the last line).
  function drawWrapped(parent, text, x, baselineY, maxWidth, size, rnd, opts) {
    opts = opts || {};
    var fam = opts.primary || effectivePrimary();
    var lineHeight = size * 1.5;
    var words = String(text).split(/\s+/).filter(Boolean);
    var line = "";
    var y = baselineY;
    for (var i = 0; i < words.length; i++) {
      var trial = line ? line + " " + words[i] : words[i];
      if (measureLine(trial, fam, size) > maxWidth && line) {
        drawLeft(parent, line, x, y, size, rnd, opts);
        y += lineHeight;
        line = words[i];
      } else {
        line = trial;
      }
    }
    if (line) drawLeft(parent, line, x, y, size, rnd, opts);
    return y + lineHeight * 0.3;
  }

  /* ----- Stamp + signature ----------------------------------------------- */
  function drawStamp(g, bill, cx, cy) {
    var rnd = mulberry32(((bill && bill.renderSeed) || 0) ^ 0x51A0C42E >>> 0);
    var angle = lerp(-12, -4, rnd());
    var op = lerp(0.72, 0.86, rnd());
    var w = 122, h = 56;
    var grp = el("g", { transform: "translate(" + cx + " " + cy + ") rotate(" + angle.toFixed(2) + ")", opacity: op.toFixed(2) }, g);
    el("rect", { x: -w / 2, y: -h / 2, width: w, height: h, rx: 8, ry: 8, fill: "none", stroke: "#b02a2a", "stroke-width": 3 }, grp);
    el("rect", { x: -w / 2 + 5, y: -h / 2 + 5, width: w - 10, height: h - 10, rx: 5, ry: 5, fill: "none", stroke: "#b02a2a", "stroke-width": 1 }, grp);
    var t = el("text", { x: 0, y: 7, "font-family": '"Patrick Hand"', "font-size": 27, fill: "#b02a2a", "text-anchor": "middle", "font-weight": "700" }, grp);
    t.textContent = "PAID";
    // uneven inking — small paper-coloured gaps
    el("rect", { x: lerp(-42, -22, rnd()), y: lerp(-20, -8, rnd()), width: lerp(8, 16, rnd()), height: lerp(3, 7, rnd()), fill: "#fbf6e9", opacity: 0.55 }, grp);
    el("rect", { x: lerp(8, 30, rnd()), y: lerp(2, 16, rnd()), width: lerp(6, 14, rnd()), height: lerp(3, 6, rnd()), fill: "#fbf6e9", opacity: 0.55 }, grp);
  }

  function drawSignature(g, bill, rightX, baseY, width) {
    var rnd = mulberry32(((bill && bill.renderSeed) || 0) ^ 0x7A35C0DE >>> 0);
    var n = 14;
    var left = rightX - width;
    var cx = left;
    var pts = [];
    var phase = rnd() * 6;
    for (var i = 0; i < n; i++) {
      var py = baseY + Math.sin(i * 0.9 + phase) * lerp(5, 11, rnd()) + lerp(-3, 3, rnd());
      pts.push([cx, py]);
      cx += (width / (n - 1)) * lerp(0.82, 1.18, rnd());
    }
    var d = "M " + pts[0][0].toFixed(1) + " " + pts[0][1].toFixed(1);
    for (var j = 1; j < pts.length; j++) {
      var mx = (pts[j - 1][0] + pts[j][0]) / 2, my = (pts[j - 1][1] + pts[j][1]) / 2;
      d += " Q " + pts[j - 1][0].toFixed(1) + " " + pts[j - 1][1].toFixed(1) + " " + mx.toFixed(1) + " " + my.toFixed(1);
    }
    d += " T " + pts[pts.length - 1][0].toFixed(1) + " " + pts[pts.length - 1][1].toFixed(1);
    el("path", { d: d, fill: "none", stroke: "#1f2a6b", "stroke-width": 1.4, "stroke-linecap": "round", "stroke-linejoin": "round" }, g);
    el("path", { d: d, fill: "none", stroke: "#1f2a6b", "stroke-width": 0.7, opacity: "0.5", "stroke-linecap": "round" }, g);
  }

  /* ----- Number formatting ------------------------------------------------ */
  function formatINR(n) {
    if (!isFinite(n)) n = 0;
    var neg = n < 0; n = Math.abs(n);
    var parts = n.toFixed(2).split(".");
    var intp = parts[0];
    var last3 = intp.slice(-3);
    var rest = intp.slice(0, -3);
    if (rest) {
      rest = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",");
      intp = rest + "," + last3;
    } else {
      intp = last3;
    }
    return (neg ? "-" : "") + intp + "." + parts[1];
  }

  /* ----- Totals fallback (canonical math lives in app.js) ------------------ */
  function fallbackCalc(bill) {
    var subtotal = 0;
    (bill.items || []).forEach(function (it) {
      if (it && it.name && isFinite(+it.qty) && +it.qty > 0 && isFinite(+it.rate) && +it.rate >= 0) {
        subtotal += (+it.qty) * (+it.rate);
      }
    });
    subtotal = Math.round((subtotal + Number.EPSILON) * 100) / 100;
    var discount = Math.min(isFinite(+bill.discount) ? +bill.discount : 0, subtotal);
    if (discount < 0) discount = 0;
    var taxable = Math.round((subtotal - discount + Number.EPSILON) * 100) / 100;
    var tp = isFinite(+bill.taxPercent) ? +bill.taxPercent : 0;
    if (tp < 0) tp = 0; if (tp > 100) tp = 100;
    var taxAmount = Math.round((taxable * tp / 100 + Number.EPSILON) * 100) / 100;
    var grandTotal = Math.round((taxable + taxAmount + Number.EPSILON) * 100) / 100;
    return { subtotal: subtotal, discount: discount, taxable: taxable, taxAmount: taxAmount, grandTotal: grandTotal, words: "" };
  }
  function calcOf(bill, calc) {
    return calc && typeof calc.grandTotal === "number" ? calc : fallbackCalc(bill);
  }

  /* ----- Paper geometry --------------------------------------------------- */
  function paperSize(s) {
    return s === "A4" ? { W: 794, H: 1123 } : { W: 559, H: 794 };
  }

  /* ----- Handwritten renderer -------------------------------------------- */
  function renderHandwritten(container, bill, paperSz, calc) {
    container.innerHTML = "";
    var c = calcOf(bill, calc);
    var P = paperSize(paperSz);
    var W = P.W, H = P.H;
    var M = 38, top = 46, bottom = 46;
    var contentW = W - M * 2;
    var rightX = W - M;
    var fam = effectivePrimary();

    var svg = el("svg", {
      viewBox: "0 0 " + W + " " + H, class: "hw-bill",
      preserveAspectRatio: "xMidYMid meet", xmlns: SVGNS
    }, container);

    // defs: grain filter
    var defs = el("defs", null, svg);
    var grainSeed = ((bill && bill.renderSeed) || 0) % 1000;
    var filt = el("filter", { id: "grain" + grainSeed, x: "0", y: "0", width: "100%", height: "100%" }, defs);
    el("feTurbulence", { type: "fractalNoise", baseFrequency: "0.9", numOctaves: "2", seed: String(grainSeed), stitchTiles: "stitch", result: "n" }, filt);
    el("feColorMatrix", { type: "saturate", values: "0", in: "n", result: "g" }, filt);

    // background (not tilted)
    el("rect", { x: 0, y: 0, width: W, height: H, fill: "#fbf6e9" }, svg);
    el("rect", { x: 0, y: 0, width: W, height: H, filter: "url(#grain" + grainSeed + ")", opacity: "0.05" }, svg);

    // content group (tilted + scale-to-fit)
    var g = el("g", null, svg);

    // paper ruled lines + margin rule (tilt with content)
    var mr = el("g", { opacity: "1" }, g);
    el("line", { x1: M + 4, y1: top - 6, x2: M + 4, y2: H - bottom + 6, stroke: "#e3c9c0", "stroke-width": 1, opacity: "0.35" }, mr);
    for (var ry = 150; ry < H - bottom - 30; ry += 34) {
      el("line", { x1: M, y1: ry, x2: W - M, y2: ry, stroke: "#ece4cf", "stroke-width": 1, opacity: "0.4" }, mr);
    }

    var y = top;
    var rnd;

    // Shop name (centered, larger)
    var shopName = (bill.shop && bill.shop.name) || "Your Shop Name";
    rnd = rngFor(bill, "shopname:" + shopName);
    drawCentered(g, shopName, W / 2, y + 28, 29, rnd, { primary: fam });
    y += 42;

    // Address lines
    var addr = (bill.shop && bill.shop.address) || "";
    if (addr) {
      var alines = addr.split("\n");
      alines.forEach(function (ln) {
        if (!ln) return;
        rnd = rngFor(bill, "addr:" + ln);
        drawCentered(g, ln, W / 2, y + 13, 14, rnd, { primary: fam });
        y += 19;
      });
    }
    if (bill.shop && bill.shop.phone) {
      rnd = rngFor(bill, "phone:" + bill.shop.phone);
      drawCentered(g, "Ph: " + bill.shop.phone, W / 2, y + 13, 14, rnd, { primary: fam });
      y += 19;
    }
    if (bill.shop && bill.shop.gstOrReg) {
      rnd = rngFor(bill, "gst:" + bill.shop.gstOrReg);
      drawCentered(g, bill.shop.gstOrReg, W / 2, y + 13, 14, rnd, { primary: fam });
      y += 19;
    }

    // rule under header
    el("line", { x1: M, y1: y, x2: rightX, y2: y, stroke: "#1f2a6b", "stroke-width": 1.2, opacity: "0.8" }, g);
    y += 14;

    // CASH MEMO title (centered, underscored)
    rnd = rngFor(bill, "title:CASH MEMO");
    drawCentered(g, "CASH MEMO", W / 2, y + 22, 25, rnd, { primary: fam });
    el("line", { x1: W / 2 - 70, y1: y + 30, x2: W / 2 + 70, y2: y + 30, stroke: "#1f2a6b", "stroke-width": 1, opacity: "0.7" }, g);
    y += 40;

    // Meta block (left aligned)
    var bn = (bill.meta && bill.meta.billNumber) || "—";
    var dt = formatDate((bill.meta && bill.meta.date) || "");
    var cust = (bill.meta && bill.meta.customerName) || "";
    rnd = rngFor(bill, "meta1:bill:" + bn);
    drawLeft(g, "Bill No: " + bn, M + 8, y + 13, 15, rnd, { primary: fam });
    y += 21;
    rnd = rngFor(bill, "meta2:date:" + dt);
    drawLeft(g, "Date: " + dt, M + 8, y + 13, 15, rnd, { primary: fam });
    y += 21;
    rnd = rngFor(bill, "meta3:cust:" + cust);
    drawLeft(g, "Customer: " + (cust || "—"), M + 8, y + 13, 15, rnd, { primary: fam });
    y += 22;

    // Item table
    // columns: Name (flex), Qty(36), Unit(44), Rate(64), Amount(78)
    var colQty = 36, colUnit = 44, colRate = 64, colAmt = 78;
    var nameW = contentW - (colQty + colUnit + colRate + colAmt);
    var xName = M, xQty = xName + nameW, xUnit = xQty + colQty, xRate = xUnit + colUnit, xAmt = xRate + colRate;

    // header row
    rnd = rngFor(bill, "thead");
    el("line", { x1: M, y1: y - 4, x2: rightX, y2: y - 4, stroke: "#1f2a6b", "stroke-width": 0.8, opacity: "0.5" }, g);
    drawLeft(g, "Item", xName, y + 12, 13, rnd, { primary: fam });
    drawRight(g, "Qty", xQty + colQty, y + 12, 13, rnd, { primary: fam });
    drawLeft(g, "Unit", xUnit, y + 12, 13, rnd, { primary: fam });
    drawRight(g, "Rate", xRate + colRate, y + 12, 13, rnd, { primary: fam });
    drawRight(g, "Amount", xAmt + colAmt, y + 12, 13, rnd, { primary: fam });
    y += 20;
    el("line", { x1: M, y1: y - 6, x2: rightX, y2: y - 6, stroke: "#1f2a6b", "stroke-width": 0.8, opacity: "0.5" }, g);

    // item rows
    var validItems = (bill.items || []).filter(function (it) {
      return it && it.name && it.name.trim() && isFinite(+it.qty) && +it.qty > 0 && isFinite(+it.rate) && +it.rate >= 0;
    });
    if (!validItems.length) {
      rnd = rngFor(bill, "noitems");
      drawLeft(g, "(no items)", M, y + 14, 14, rnd, { primary: fam });
      y += 24;
    } else {
      validItems.forEach(function (it, idx) {
        var rowTop = y;
        var amount = Math.round((+it.qty * +it.rate + Number.EPSILON) * 100) / 100;
        // name (wrapped)
        rnd = rngFor(bill, "iname" + idx + ":" + it.name);
        var afterY = drawWrapped(g, it.name, xName, y + 14, nameW, 15, rnd, { primary: fam });
        var linesUsed = Math.max(1, Math.round((afterY - (y + 14)) / (15 * 1.5)) + 1);
        var rowH = Math.max(26, linesUsed * 21);
        // qty / unit / rate / amount aligned to first line baseline
        var baseY = rowTop + 14;
        rnd = rngFor(bill, "iqty" + idx + ":" + it.qty);
        drawRight(g, String(+it.qty), xQty + colQty, baseY, 15, rnd, { primary: fam });
        rnd = rngFor(bill, "iunit" + idx + ":" + (it.unit || ""));
        drawLeft(g, it.unit || "", xUnit, baseY, 15, rnd, { primary: fam });
        rnd = rngFor(bill, "irate" + idx + ":" + it.rate);
        drawRight(g, formatINR(+it.rate), xRate + colRate, baseY, 15, rnd, { primary: fam });
        rnd = rngFor(bill, "iamt" + idx + ":" + amount);
        drawRight(g, formatINR(amount), xAmt + colAmt, baseY, 15, rnd, { primary: fam });
        el("line", { x1: M, y1: rowTop + rowH - 6, x2: rightX, y2: rowTop + rowH - 6, stroke: "#cbb88a", "stroke-width": 0.7, opacity: "0.5" }, g);
        y = rowTop + rowH;
      });
    }

    // Totals (right-aligned)
    y += 6;
    rnd = rngFor(bill, "tot:sub");
    drawRight(g, "Subtotal: Rs " + formatINR(c.subtotal), rightX, y + 13, 14, rnd, { primary: fam });
    y += 20;
    if (c.discount > 0) {
      rnd = rngFor(bill, "tot:disc");
      drawRight(g, "Discount: -Rs " + formatINR(c.discount), rightX, y + 13, 14, rnd, { primary: fam });
      y += 20;
    }
    if (c.taxAmount > 0) {
      rnd = rngFor(bill, "tot:tax");
      var tp = isFinite(+bill.taxPercent) ? +bill.taxPercent : 0;
      drawRight(g, "Tax (" + tp + "%): Rs " + formatINR(c.taxAmount), rightX, y + 13, 14, rnd, { primary: fam });
      y += 20;
    }
    el("line", { x1: rightX - 150, y1: y, x2: rightX, y2: y, stroke: "#1f2a6b", "stroke-width": 1, opacity: "0.7" }, g);
    rnd = rngFor(bill, "tot:grand");
    drawRight(g, "Grand Total: Rs " + formatINR(c.grandTotal), rightX, y + 18, 20, rnd, { primary: fam });
    y += 28;

    // Amount in words (left, wrapped)
    var words = c.words || "";
    if (words) {
      rnd = rngFor(bill, "words:" + words);
      y = drawWrapped(g, "Amount in words: " + words, M + 8, y + 14, contentW - 16, 14, rnd, { primary: fam });
      y += 6;
    }

    // Footer (centered) — placed a bit lower
    var footY = Math.max(y + 14, H - 200);
    rnd = rngFor(bill, "foot:thanks");
    drawCentered(g, "Thank you! Visit again.", W / 2, footY + 13, 14, rnd, { primary: fam });
    rnd = rngFor(bill, "foot:goods");
    drawCentered(g, "Goods once sold will not be taken back.", W / 2, footY + 33, 12, rnd, { primary: fam });

    // Signature (bottom-right) + label
    var sigBaseY = H - 92;
    drawSignature(g, bill, rightX - 4, sigBaseY, 150);
    rnd = rngFor(bill, "siglabel");
    drawRight(g, "Authorised Signature", rightX - 4, sigBaseY + 18, 12, rnd, { primary: fam });

    // Faux PAID stamp (bottom-right, a touch left of signature)
    drawStamp(g, bill, rightX - 150, H - 70);

    // ----- tilt + scale-to-fit -----
    var contentBottom = H - 40; // stamp/signature already near bottom
    var contentHeight = contentBottom - top;
    var avail = H - top - bottom;
    var scale = contentHeight > avail ? Math.min(1, avail / contentHeight) : 1;
    var tiltRnd = mulberry32(((bill && bill.renderSeed) || 0) ^ 0x9E3779B9 >>> 0);
    var angle = lerp(-0.8, 0.8, tiltRnd());
    var cx = W / 2, cy = H / 2;
    g.setAttribute("transform",
      "translate(" + cx + " " + cy + ") rotate(" + angle.toFixed(3) + ") scale(" + scale.toFixed(4) + ") translate(" + (-cx) + " " + (-cy) + ")");

    return svg;
  }

  function formatDate(iso) {
    if (!iso) return "";
    var m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return String(iso);
    return m[3] + "/" + m[2] + "/" + m[1];
  }

  /* ----- Computerized renderer (clean HTML receipt) ---------------------- */
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }
  function renderComputerized(container, bill, paperSz, calc) {
    container.innerHTML = "";
    var c = calcOf(bill, calc);
    var shop = bill.shop || {};
    var meta = bill.meta || {};
    var dt = formatDate(meta.date || "");

    var validItems = (bill.items || []).filter(function (it) {
      return it && it.name && it.name.trim() && isFinite(+it.qty) && +it.qty > 0 && isFinite(+it.rate) && +it.rate >= 0;
    });

    var rows = validItems.map(function (it) {
      var amt = Math.round((+it.qty * +it.rate + Number.EPSILON) * 100) / 100;
      return '<tr><td>' + esc(it.name) + '</td>' +
        '<td class="num">' + esc(String(+it.qty)) + '</td>' +
        '<td>' + esc(it.unit || '') + '</td>' +
        '<td class="num">' + formatINR(+it.rate) + '</td>' +
        '<td class="num">' + formatINR(amt) + '</td></tr>';
    }).join("");

    if (!rows) rows = '<tr><td colspan="5" style="text-align:center;color:#999">(no items)</td></tr>';

    var taxLine = "";
    if (c.taxAmount > 0) {
      taxLine = '<div class="r-trow"><span>Tax (' + esc(String(isFinite(+bill.taxPercent) ? +bill.taxPercent : 0)) + '%)</span><span>&#8377;' + formatINR(c.taxAmount) + '</span></div>';
    }
    var discLine = "";
    if (c.discount > 0) {
      discLine = '<div class="r-trow"><span>Discount</span><span>-&#8377;' + formatINR(c.discount) + '</span></div>';
    }

    var wordsHtml = c.words ? '<div class="r-words"><b>Amount in words</b><br>' + esc(capitalize(c.words)) + '</div>' : "";

    var html =
      '<div class="receipt">' +
        '<div class="r-shop">' +
          '<div class="r-name">' + esc(shop.name || "Your Shop Name") + '</div>' +
          (shop.address ? '<div class="r-addr">' + esc(shop.address) + '</div>' : '') +
          (shop.phone || shop.gstOrReg ? '<div class="r-meta">' + esc([shop.phone ? 'Ph: ' + shop.phone : '', shop.gstOrReg].filter(Boolean).join('  |  ')) + '</div>' : '') +
        '</div>' +
        '<div class="r-title">CASH MEMO</div>' +
        '<div class="r-info">' +
          '<div class="col"><span>Bill No.</span><strong>' + esc(meta.billNumber || '—') + '</strong></div>' +
          '<div class="col right"><span>Date</span><strong>' + esc(dt || '—') + '</strong></div>' +
        '</div>' +
        (meta.customerName ? '<div class="r-info"><div class="col"><span>Customer</span><strong>' + esc(meta.customerName) + '</strong></div></div>' : '') +
        '<table>' +
          '<thead><tr><th>Item</th><th class="num">Qty</th><th>Unit</th><th class="num">Rate</th><th class="num">Amount</th></tr></thead>' +
          '<tbody>' + rows + '</tbody>' +
        '</table>' +
        '<div class="r-totals">' +
          '<div class="r-trow"><span>Subtotal</span><span>&#8377;' + formatINR(c.subtotal) + '</span></div>' +
          discLine + taxLine +
          '<div class="r-trow grand"><span>Grand Total</span><span>&#8377;' + formatINR(c.grandTotal) + '</span></div>' +
        '</div>' +
        wordsHtml +
        '<div class="r-foot">' +
          '<div class="r-thanks">Thank you! Visit again.</div>' +
          '<div class="r-sig"><div class="r-line"></div><div class="r-label">Authorised Signature</div></div>' +
        '</div>' +
      '</div>';
    container.innerHTML = html;
    var receipt = container.firstChild;

    // Scale-to-fit: if content overflows the paper height, shrink proportionally.
    // Runs after layout settles so scrollHeight is accurate.
    if (receipt && typeof requestAnimationFrame === "function") {
      requestAnimationFrame(function () {
        try {
          var paperH = receipt.offsetHeight; // CSS aspect-ratio drives this
          var contentH = receipt.scrollHeight;
          if (contentH > paperH && paperH > 0) {
            var scale = Math.max(0.5, paperH / contentH);
            receipt.style.transformOrigin = "top center";
            receipt.style.transform = "scale(" + scale.toFixed(4) + ")";
            receipt.style.marginBottom = ((scale - 1) * paperH).toFixed(0) + "px";
          } else {
            receipt.style.transform = "";
            receipt.style.marginBottom = "";
          }
        } catch (err) { /* non-fatal */ }
      });
    }

    return receipt;
  }

  function capitalize(s) {
    s = String(s);
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
  }

  /* ----- Export ----------------------------------------------------------- */
  window.Handwriting = {
    fontsReady: fontsReady,
    loadedFontFamilies: loadedFontFamilies,
    renderComputerized: renderComputerized,
    renderHandwritten: renderHandwritten,
    fonts: { primary: PRIMARY, alternates: ALTERNATES.slice() },
    // test helpers (exposed for verification harness)
    _rngFor: rngFor,
    _formatINR: formatINR,
    _mulberry32: mulberry32,
    _hash32: hash32
  };
})();

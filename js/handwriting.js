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

  /* ----- Language label sets ---------------------------------------------- */
  var LABELS_EN = {
    cashMemo: 'CASH MEMO',
    billNo: 'Bill No: ',
    date: 'Date: ',
    customer: 'Customer: ',
    item: 'Item',
    qty: 'Qty',
    unit: 'Unit',
    rate: 'Rate',
    amount: 'Amount',
    subtotal: 'Subtotal: Rs ',
    discount: 'Discount: -Rs ',
    tax: 'Tax',
    taxCurrency: 'Rs ',
    grandTotal: 'Grand Total: Rs ',
    amountInWords: 'Amount in words: ',
    thanks: 'Thank you! Visit again.',
    goods: 'Goods once sold will not be taken back.',
    authSig: 'Authorised Signature'
  };
  var LABELS_HI = {
    cashMemo: 'नकद रसीद',
    billNo: 'बिल नं.: ',
    date: 'दिनांक: ',
    customer: 'ग्राहक: ',
    item: 'वस्तु',
    qty: 'मात्रा',
    unit: 'इकाई',
    rate: 'दर',
    amount: 'राशि',
    subtotal: 'उप-योग: ₹',
    discount: 'छूट: -₹',
    tax: 'कर',
    taxCurrency: '₹',
    grandTotal: 'महायोग: ₹',
    amountInWords: 'शब्दों में: ',
    thanks: 'धन्यवाद! पुनः पधारें।',
    goods: 'बेचा गया माल वापस नहीं होगा।',
    authSig: 'अधिकृत हस्ताक्षर'
  };
  var HINDI_FONTS = ['Hind', 'Tiro Devanagari Hindi'];

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

  /* ----- Smooth baseline wobble ------------------------------------------ */
  function seedWobble(seed, x, lineWidth) {
    var PI2 = Math.PI * 2;
    var phase1 = (seed * 0.00173) % PI2;
    var freq1 = 0.008 + (seed % 7) * 0.0005;
    var phase2 = (seed * 0.00391) % PI2;
    var freq2 = 0.013 + (seed % 5) * 0.0006;
    return Math.sin(x * freq1 + phase1) * 2.5 + Math.sin(x * freq2 + phase2) * 1.5;
  }

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
    text = String(text);
    // For Devanagari / complex scripts, use Canvas for accurate measurement
    if (/[\u0900-\u097F]/.test(text)) {
      try {
        var _cvs = document.createElement('canvas');
        var _ctx = _cvs.getContext('2d');
        if (_ctx) {
          _ctx.font = '400 ' + size + 'px "' + (family || PRIMARY) + '", Hind, sans-serif';
          return _ctx.measureText(text).width;
        }
      } catch(e) { /* fallback below */ }
      return text.length * size * 0.6; // heuristic fallback
    }
    var w = 0;
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
  // KEPT AS DEAD CODE — replaced by drawWords() for all call sites.
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

  // Word-level rendering — tighter inter-character spacing within words,
  // smooth baseline wobble via seedWobble(), word-level ink/font variation.
  // Returns new x after the rendered text.
  function drawWords(parent, text, x, baselineY, size, rnd, opts) {
    opts = opts || {};
    var primary = opts.primary || effectivePrimary();
    // For Hindi mode, prefer Hind font
    if (opts.hindiMode) primary = HINDI_FONTS[0];
    var alts = opts.alternates || loadedAlts();
    var tight = !!opts.tight; // heading mode: less jitter
    var numRow = !!opts.numberRow; // numbers: more upright
    var wobbleSeed = ((opts.wobbleSeed || 0) ^ hash32(String(text))) >>> 0;
    var lineWidth = opts.lineWidth || 400;
    var words = String(text).split(/(\s+)/);
    var _filtCount = 0;

    for (var wi = 0; wi < words.length; wi++) {
      var token = words[wi];
      if (/^\s+$/.test(token)) {
        // whitespace between words
        x += size * lerp(0.28, 0.42, rnd());
        continue;
      }
      if (!token) continue;

      // Word-level PRNG parameters (consume in fixed order)
      var wordSize      = size * (tight ? lerp(0.97, 1.02, rnd()) : lerp(0.92, 1.08, rnd()));
      var wordSkewX     = numRow ? lerp(-1, 1, rnd()) : (tight ? lerp(-2, 1, rnd()) : lerp(-6, 2, rnd()));
      var wordBaseShift = tight ? lerp(-1.5, 1.5, rnd()) : lerp(-3, 3, rnd());
      var wordOpacity   = lerp(0.82, 1.0, rnd());
      var wColorR       = rnd();
      var wordColor     = wColorR < 0.6 ? '#1a1a6e' : (wColorR < 0.85 ? '#1f2a6b' : '#2244cc');
      var hasBlur       = (!tight) && rnd() < 0.15;
      var blurStd       = lerp(0.3, 0.5, rnd());
      var wordFamily    = primary;
      if (!opts.hindiMode && rnd() < 0.08 && alts.length) {
        wordFamily = alts[Math.floor(rnd() * alts.length) % alts.length];
      } else if (opts.hindiMode) {
        rnd(); // consume slot to keep seed stable
      } else {
        rnd(); // consume slot
      }
      // font-weight variation for Caveat (variable font)
      var wordWeight = (wordFamily === 'Caveat' && rnd() < 0.5) ? '700' : '400';

      // Smooth wobble for this word's horizontal position
      var wobbleY = seedWobble(wobbleSeed, x, lineWidth);

      // ---- HINDI / DEVANAGARI: render whole word as one <text> element ----
      // Devanagari matras and conjuncts must NOT be split per-character —
      // doing so detaches vowel signs from their consonants and destroys the script.
      // Apply only word-level variation (skew, baseline, color, opacity).
      if (opts.hindiMode) {
        var ty = baselineY + wordBaseShift + wobbleY;
        var wgH = el('g', {
          transform: 'translate(' + x.toFixed(2) + ' ' + ty.toFixed(2) + ') skewX(' + wordSkewX.toFixed(1) + ')',
          opacity: wordOpacity.toFixed(2)
        }, parent);
        var tnode = el('text', {
          'font-family': '"' + wordFamily + '", "Hind", sans-serif',
          'font-size': wordSize,
          'font-weight': wordWeight,
          fill: wordColor,
          'fill-opacity': '1',
          x: '0',
          y: '0'
        }, wgH);
        tnode.textContent = token;
        // Advance x by estimated word width (use canvas measure if available, else heuristic)
        var estW = token.length * wordSize * 0.6;
        if (typeof document !== 'undefined' && document.createElement) {
          try {
            var _cvs = document.createElement('canvas');
            var _ctx = _cvs.getContext('2d');
            if (_ctx) {
              _ctx.font = wordWeight + ' ' + wordSize + 'px "' + wordFamily + '", Hind, sans-serif';
              estW = _ctx.measureText(token).width;
            }
          } catch(e) { /* fallback to heuristic */ }
        }
        x += estW + size * lerp(0.05, 0.12, rnd()); // small extra gap after word
        continue; // skip per-character loop
      }

      // ---- LATIN / NUMERIC: per-character variation (original logic) ----
      // Build word group
      var wgAttrs = {
        transform: 'skewX(' + wordSkewX.toFixed(1) + ')',
        opacity: wordOpacity.toFixed(2)
      };
      if (hasBlur && parent.ownerDocument) {
        var svg = parent;
        while (svg && svg.tagName !== 'svg') svg = svg.parentNode;
        var defs = svg ? svg.querySelector('defs') : null;
        if (defs) {
          _filtCount++;
          var fId = 'wblur_' + wobbleSeed + '_' + _filtCount;
          var fNode = el('filter', { id: fId, x: '-5%', y: '-5%', width: '110%', height: '110%' }, defs);
          el('feGaussianBlur', { stdDeviation: blurStd.toFixed(2) }, fNode);
          wgAttrs.filter = 'url(#' + fId + ')';
        }
      }
      var wg = el('g', wgAttrs, parent);

      // Per-character within word
      for (var ci = 0; ci < token.length; ci++) {
        var ch = token.charAt(ci);
        var isNum = /\d/.test(ch);
        var charR  = tight ? lerp(-1, 1, rnd()) : (isNum ? lerp(-0.5, 0.5, rnd()) : lerp(-2, 2, rnd()));
        var charDx = lerp(-0.8, 0.8, rnd());
        var charDy = lerp(-0.8, 0.8, rnd());
        var charS  = lerp(0.97, 1.03, rnd());
        var lsf    = lerp(0.88, 0.98, rnd());
        var w = charWidth(ch, wordFamily, wordSize) || wordSize * 0.55;
        var tx = x + charDx;
        var ty = baselineY + wordBaseShift + wobbleY + charDy;
        var t = 'translate(' + tx.toFixed(2) + ' ' + ty.toFixed(2) + ') rotate(' + charR.toFixed(2) + ') scale(' + charS.toFixed(3) + ')';
        var tnode = el('text', {
          'font-family': '"' + wordFamily + '"',
          'font-size': wordSize,
          'font-weight': wordWeight,
          fill: wordColor,
          'fill-opacity': '1',
          transform: t
        }, wg);
        tnode.textContent = ch;
        x += w * lsf;
      }
    }
    return x;
  }

  function drawLeft(parent, text, x, baselineY, size, rnd, opts) {
    return drawWords(parent, text, x, baselineY, size, rnd, opts);
  }
  function drawCentered(parent, text, centerX, baselineY, size, rnd, opts) {
    opts = opts || {};
    var fam = opts.primary || effectivePrimary();
    var w = measureLine(text, fam, size);
    return drawWords(parent, text, centerX - w / 2, baselineY, size, rnd, opts);
  }
  function drawRight(parent, text, rightX, baselineY, size, rnd, opts) {
    opts = opts || {};
    var fam = opts.primary || effectivePrimary();
    var w = measureLine(text, fam, size);
    return drawWords(parent, text, rightX - w, baselineY, size, rnd, opts);
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
    el("rect", { x: lerp(-42, -22, rnd()), y: lerp(-20, -8, rnd()), width: lerp(8, 16, rnd()), height: lerp(3, 7, rnd()), fill: "#f5f0e8", opacity: 0.55 }, grp);
    el("rect", { x: lerp(8, 30, rnd()), y: lerp(2, 16, rnd()), width: lerp(6, 14, rnd()), height: lerp(3, 6, rnd()), fill: "#f5f0e8", opacity: 0.55 }, grp);
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

    // Language / label selection
    var lang = (bill && bill.language) || 'en';
    var hindiMode = (lang === 'hi' || lang === 'mixed');

    var c = calcOf(bill, calc);
    var P = paperSize(paperSz);
    var W = P.W, H = P.H;
    var M = 28;
    var contentW = W - M * 2;
    var fam = effectivePrimary();

    // Short date helper — strips year to 2 digits: DD/MM/YY
    var shortDate = function (iso) {
      var d = formatDate(iso); // returns DD/MM/YYYY
      if (d.length === 10) return d.slice(0, 6) + d.slice(8); // DD/MM/YY
      return d;
    };

    // Helper: build opts object for all draw calls
    function dOpts(extra) {
      var base = { primary: fam, wobbleSeed: (bill && bill.renderSeed) || 0, lineWidth: contentW };
      var merged = extra || {};
      var o = {};
      for (var k in base) if (Object.prototype.hasOwnProperty.call(base, k)) o[k] = base[k];
      for (var k2 in merged) if (Object.prototype.hasOwnProperty.call(merged, k2)) o[k2] = merged[k2];
      if (hindiMode) o.hindiMode = true;
      return o;
    }

    var svg = el("svg", {
      viewBox: "0 0 " + W + " " + H, "class": "hw-bill",
      preserveAspectRatio: "xMidYMid meet", xmlns: SVGNS
    }, container);

    // --- 2a: defs — grain filter ---
    var defs = el("defs", null, svg);
    var grainSeed = ((bill && bill.renderSeed) || 0) % 1000;
    var filt = el("filter", { id: "grain" + grainSeed, x: "0", y: "0", width: "100%", height: "100%" }, defs);
    el("feTurbulence", { type: "fractalNoise", baseFrequency: "0.9", numOctaves: "2", seed: String(grainSeed), stitchTiles: "stitch", result: "n" }, filt);
    el("feColorMatrix", { type: "saturate", values: "0", in: "n", result: "g_cm" }, filt);

    // Paper background #fafaf5 (nearly white, like a real Indian cash memo pad)
    el("rect", { x: 0, y: 0, width: W, height: H, fill: "#fafaf5" }, svg);
    el("rect", { x: 0, y: 0, width: W, height: H, filter: "url(#grain" + grainSeed + ")", opacity: "0.05" }, svg);

    // Main content group — NO tilt transform
    var g = el("g", null, svg);

    // --- 2b: Decorative double border ---
    el("rect", { x: 10, y: 10, width: W - 20, height: H - 20, fill: "none", stroke: "#1a1a5e", "stroke-width": "0.8" }, g);
    el("rect", { x: 18, y: 18, width: W - 36, height: H - 36, fill: "none", stroke: "#1a1a5e", "stroke-width": "0.6", "stroke-dasharray": "3 4" }, g);

    var y = 32;
    var rnd;

    // --- 2c: Shop name header (printed SVG text, centered) ---
    var shopName = (bill.shop && bill.shop.name) || "";
    if (shopName) {
      var tShop = el("text", {
        x: W / 2, y: y + 13,
        "font-family": "sans-serif", "font-size": "13", fill: "#1a1a5e",
        "font-weight": "600", "text-anchor": "middle"
      }, g);
      tShop.textContent = shopName;
      y += 18;
    }
    var addr = (bill.shop && bill.shop.address) || "";
    if (addr) {
      var alines = addr.split("\n");
      alines.forEach(function (ln) {
        if (!ln.trim()) return;
        var ta = el("text", {
          x: W / 2, y: y + 11,
          "font-family": "sans-serif", "font-size": "11", fill: "#1a1a5e",
          "font-weight": "400", "text-anchor": "middle"
        }, g);
        ta.textContent = ln;
        y += 14;
      });
    }
    if (bill.shop && bill.shop.phone) {
      var tph = el("text", {
        x: W / 2, y: y + 11,
        "font-family": "sans-serif", "font-size": "11", fill: "#1a1a5e",
        "font-weight": "400", "text-anchor": "middle"
      }, g);
      tph.textContent = "Ph: " + bill.shop.phone;
      y += 14;
    }

    // --- 2d: CASH MEMO box ---
    el("rect", {
      x: W / 2 - 80, y: y, width: 160, height: 26,
      fill: "none", stroke: "#1a1a5e", "stroke-width": "1.2"
    }, g);
    var tCM = el("text", {
      x: W / 2, y: y + 18,
      "font-family": "sans-serif", "font-size": "13", fill: "#1a1a5e",
      "font-weight": "700", "text-anchor": "middle", "letter-spacing": "2"
    }, g);
    tCM.textContent = "CASH MEMO";
    y += 34;

    // --- 2e: "Bought of" and "Sold to" rows ---
    // Row 1 — vendor row (decoration only)
    var tBought = el("text", {
      x: M, y: y + 14,
      "font-family": "sans-serif", "font-size": "11", fill: "#1a1a5e"
    }, g);
    tBought.textContent = "Bought of \u0935\u093f\u0915\u094d\u0930\u0947\u0924\u093e"; // विक्रेता
    el("line", { x1: M + 115, y1: y + 15, x2: W - M, y2: y + 15, stroke: "#1a1a5e", "stroke-width": "0.6" }, g);
    y += 22;

    // Row 2 — customer row
    var tSold = el("text", {
      x: M, y: y + 14,
      "font-family": "sans-serif", "font-size": "11", fill: "#1a1a5e"
    }, g);
    tSold.textContent = "Sold to \u0915\u094d\u0930\u0947\u0924\u093e"; // क्रेता
    el("line", { x1: M + 95, y1: y + 15, x2: W - M, y2: y + 15, stroke: "#1a1a5e", "stroke-width": "0.6" }, g);
    var customerName = (bill.meta && bill.meta.customerName) || "";
    if (customerName) {
      rnd = rngFor(bill, "cust:" + customerName);
      drawLeft(g, customerName, M + 98, y + 13, 13, rnd, dOpts());
    }
    y += 22;

    // --- 2f: Bill No / Date header row ---
    var halfBoxW = Math.floor(W * 0.4);
    var fullBoxW = (W - 2 * M);
    el("rect", { x: M, y: y, width: halfBoxW, height: 24, fill: "none", stroke: "#1a1a5e", "stroke-width": "0.8" }, g);
    el("rect", { x: M + halfBoxW, y: y, width: fullBoxW - halfBoxW, height: 24, fill: "none", stroke: "#1a1a5e", "stroke-width": "0.8" }, g);

    var tBillNoLbl = el("text", {
      x: M + 4, y: y + 16,
      "font-family": "sans-serif", "font-size": "10", fill: "#1a1a5e"
    }, g);
    tBillNoLbl.textContent = "\u0915\u094d\u0930\u092e\u093e\u0902\u0915 / No."; // क्रमांक / No.
    var tDateLbl = el("text", {
      x: M + halfBoxW + 4, y: y + 16,
      "font-family": "sans-serif", "font-size": "10", fill: "#1a1a5e"
    }, g);
    tDateLbl.textContent = "\u0924\u093f\u0925\u093f / Date"; // तिथि / Date

    var bn = (bill.meta && bill.meta.billNumber) || "\u2014";
    rnd = rngFor(bill, "meta:bn:" + bn);
    drawRight(g, bn, M + halfBoxW - 4, y + 17, 13, rnd, dOpts({ numberRow: true }));

    var dateStr = shortDate((bill.meta && bill.meta.date) || "");
    rnd = rngFor(bill, "meta:date:" + dateStr);
    drawRight(g, dateStr, W - M - 4, y + 17, 13, rnd, dOpts({ numberRow: true }));

    y += 28;

    // --- 2g: Column header row ---
    var xQnty        = M;
    var wQnty        = Math.floor(W * 0.10);
    var xParticulars = M + wQnty;
    var wParticulars = Math.floor(W * 0.43);
    var xRate        = xParticulars + wParticulars;
    var wRate        = Math.floor(W * 0.15);
    var xAmtRs       = xRate + wRate;
    var wAmtRs       = Math.floor(W * 0.18);
    var xAmtP        = xAmtRs + wAmtRs;
    var wAmtP        = (W - M) - xAmtP;

    var dividers = [xParticulars, xRate, xAmtRs, xAmtP];

    el("rect", {
      x: M, y: y, width: W - 2 * M, height: 22,
      fill: "#e8e8f0", stroke: "#1a1a5e", "stroke-width": "0.8"
    }, g);

    // Column header texts
    var hdrY = y + 15;
    var hdrStyle = { "font-family": "sans-serif", "font-size": "9", fill: "#1a1a5e", "font-weight": "700", "text-anchor": "middle" };

    var tQ = el("text", Object.assign({}, hdrStyle, { x: xQnty + wQnty / 2, y: hdrY }), g);
    tQ.textContent = "\u0938\u0902\u0916\u094d\u092f\u093e / QNTY."; // संख्या / QNTY.

    var tP = el("text", Object.assign({}, hdrStyle, { x: xParticulars + wParticulars / 2, y: hdrY }), g);
    tP.textContent = "\u0935\u093f\u0935\u0930\u0923 / PARTICULARS"; // विवरण / PARTICULARS

    var tR = el("text", Object.assign({}, hdrStyle, { x: xRate + wRate / 2, y: hdrY }), g);
    tR.textContent = "\u0926\u0930 / RATE"; // दर / RATE

    // Amount Rs. — two stacked lines
    var tAR1 = el("text", Object.assign({}, hdrStyle, { x: xAmtRs + wAmtRs / 2, y: y + 10 }), g);
    tAR1.textContent = "\u0930\u0915\u092e"; // रकम
    var tAR2 = el("text", Object.assign({}, hdrStyle, { x: xAmtRs + wAmtRs / 2, y: y + 20 }), g);
    tAR2.textContent = "Rs.";

    var tAP = el("text", Object.assign({}, hdrStyle, { x: xAmtP + wAmtP / 2, y: hdrY }), g);
    tAP.textContent = "P.";

    y += 26;
    var gridTop = y;

    // --- 2h: Item rows ---
    var rowH = 22;
    var emptyRowCount = 8;

    var validItems = (bill.items || []).filter(function (it) {
      return it && it.name && it.name.trim() && isFinite(+it.qty) && +it.qty > 0 && isFinite(+it.rate) && +it.rate >= 0;
    });

    if (!validItems.length) {
      // Draw at least one blank row placeholder line
      el("line", { x1: M, y1: y + rowH, x2: W - M, y2: y + rowH, stroke: "#1a1a5e", "stroke-width": "0.5", opacity: "0.5" }, g);
      y += rowH;
    } else {
      validItems.forEach(function (it, idx) {
        var amount = Math.round((+it.qty * +it.rate + Number.EPSILON) * 100) / 100;
        // horizontal bottom rule
        el("line", { x1: M, y1: y + rowH, x2: W - M, y2: y + rowH, stroke: "#1a1a5e", "stroke-width": "0.5", opacity: "0.5" }, g);
        // handwritten qty
        rnd = rngFor(bill, "iqty" + idx + ":" + it.qty);
        drawCentered(g, String(+it.qty), xQnty + wQnty / 2, y + 16, 13, rnd, dOpts({ numberRow: true }));
        // handwritten item name
        rnd = rngFor(bill, "iname" + idx + ":" + it.name);
        drawLeft(g, it.name, xParticulars + 3, y + 16, 13, rnd, dOpts());
        // handwritten rate
        rnd = rngFor(bill, "irate" + idx + ":" + it.rate);
        drawRight(g, formatINR(+it.rate), xRate + wRate - 3, y + 16, 13, rnd, dOpts({ numberRow: true }));
        // handwritten amount Rs. part
        var amtStr = formatINR(amount).split(".")[0];
        rnd = rngFor(bill, "iamt" + idx + ":" + amount);
        drawRight(g, amtStr, xAmtRs + wAmtRs - 3, y + 16, 13, rnd, dOpts({ numberRow: true }));
        // paise cell
        rnd = rngFor(bill, "ipaise" + idx);
        drawCentered(g, "-", xAmtP + wAmtP / 2, y + 16, 12, rnd, dOpts({ tight: true }));
        y += rowH;
      });
    }

    // 8 blank ruled rows after items
    for (var er = 0; er < emptyRowCount; er++) {
      el("line", { x1: M, y1: y + rowH, x2: W - M, y2: y + rowH, stroke: "#1a1a5e", "stroke-width": "0.5", opacity: "0.4" }, g);
      y += rowH;
    }

    var emptyRowsBottom = y;

    // --- 2i: Vertical column dividers (full height, gridTop to emptyRowsBottom) ---
    dividers.forEach(function (xd) {
      el("line", { x1: xd, y1: gridTop, x2: xd, y2: emptyRowsBottom, stroke: "#1a1a5e", "stroke-width": "0.6", opacity: "0.8" }, g);
    });
    // Left and right outer vertical borders of grid
    el("line", { x1: M, y1: gridTop, x2: M, y2: emptyRowsBottom, stroke: "#1a1a5e", "stroke-width": "0.8" }, g);
    el("line", { x1: W - M, y1: gridTop, x2: W - M, y2: emptyRowsBottom, stroke: "#1a1a5e", "stroke-width": "0.8" }, g);
    // Top border of grid
    el("line", { x1: M, y1: gridTop, x2: W - M, y2: gridTop, stroke: "#1a1a5e", "stroke-width": "0.8" }, g);

    // --- 2j: Diagonal signature scrawl in empty rows area ---
    var scrawlCX = M + (W - 2 * M) * 0.55;
    var scrawlCY = gridTop + (validItems.length * rowH) + (emptyRowCount * rowH * 0.5);
    var scrawlW  = Math.min(W - 2 * M - 30, 220);
    var sigG = el("g", {
      transform: "rotate(-18 " + scrawlCX.toFixed(1) + " " + scrawlCY.toFixed(1) + ")",
      opacity: "0.55"
    }, g);
    drawSignature(sigG, bill, scrawlCX + scrawlW / 2, scrawlCY, scrawlW);
    drawSignature(sigG, bill, scrawlCX + scrawlW / 2 + 8, scrawlCY + 6, scrawlW * 0.7);

    // --- 2k: Footer separator and footer row ---
    el("line", { x1: M, y1: emptyRowsBottom, x2: W - M, y2: emptyRowsBottom, stroke: "#1a1a5e", "stroke-width": "1.2" }, g);

    el("rect", {
      x: M, y: emptyRowsBottom, width: W - 2 * M, height: 34,
      fill: "none", stroke: "#1a1a5e", "stroke-width": "0.8"
    }, g);

    // Left zone — printed labels
    var tThanks = el("text", {
      x: M + 4, y: emptyRowsBottom + 13,
      "font-family": "sans-serif", "font-size": "9", fill: "#1a1a5e"
    }, g);
    tThanks.textContent = "\u0927\u0928\u094d\u092f\u0935\u093e\u062a / Thank you"; // धन्यवाद / Thank you
    var tEOE = el("text", {
      x: M + 4, y: emptyRowsBottom + 24,
      "font-family": "sans-serif", "font-size": "8", fill: "#1a1a5e"
    }, g);
    tEOE.textContent = "\u092d\u0942\u0932-\u091a\u0942\u0915 \u0932\u0947\u0928\u0940 \u0926\u0947\u0928\u0940 E.&O.E."; // भूल-चूक लेनी देनी E.&O.E.

    // Middle zone — printed TOTAL label and divider
    el("line", { x1: xRate, y1: emptyRowsBottom, x2: xRate, y2: emptyRowsBottom + 34, stroke: "#1a1a5e", "stroke-width": "0.6" }, g);
    var tTotal = el("text", {
      x: xRate + 4, y: emptyRowsBottom + 20,
      "font-family": "sans-serif", "font-size": "10", fill: "#1a1a5e", "font-weight": "700"
    }, g);
    tTotal.textContent = "\u091c\u094b\u0921\u093c / TOTAL"; // जोड़ / TOTAL

    // Right zone divider at xAmtRs
    el("line", { x1: xAmtRs, y1: emptyRowsBottom, x2: xAmtRs, y2: emptyRowsBottom + 34, stroke: "#1a1a5e", "stroke-width": "0.6" }, g);

    // Handwritten total (large, prominent)
    var totalStr = formatINR(c.grandTotal).split(".")[0] + ".-";
    rnd = rngFor(bill, "footer:total:" + c.grandTotal);
    drawRight(g, totalStr, W - M - 4, emptyRowsBottom + 24, 18, rnd, dOpts({ numberRow: true, tight: true }));

    y = emptyRowsBottom + 38;

    // --- 2l: "Goods once sold" printed line and bottom signature ---
    var tGoods = el("text", {
      x: W / 2, y: y + 12,
      "font-family": "sans-serif", "font-size": "9", fill: "#1a1a5e",
      "text-anchor": "middle", "font-style": "italic"
    }, g);
    tGoods.textContent = "Goods once sold will not be taken back.";

    var sigBaseY = y + 32;
    el("text", {
      x: W - M - 4, y: sigBaseY + 16,
      "font-size": "9", fill: "#1a1a5e",
      "font-family": "sans-serif", "text-anchor": "end"
    }, g).textContent = "Signature";
    el("line", {
      x1: W - M - 130, y1: sigBaseY + 2, x2: W - M - 4, y2: sigBaseY + 2,
      stroke: "#1a1a5e", "stroke-width": "0.6"
    }, g);
    drawSignature(g, bill, W - M - 4, sigBaseY - 2, 120);

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

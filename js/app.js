/* ===========================================================================
   app.js — Bill Generator application logic.
   Owns: form binding, totals, amount-in-words (INR), localStorage persistence,
   print/PDF/PNG export, and mode/paper-size wiring. Depends on window.Handwriting
   (loaded first from handwriting.js).
   =========================================================================== */
(function () {
  "use strict";

  /* ----- Storage keys ----------------------------------------------------- */
  var KEYS = { shop: "billgen.shop", settings: "billgen.settings", current: "billgen.current" };

  var ls = {
    get: function (k) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch (e) { console.warn("localStorage read failed:", e); return null; } },
    set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { console.warn("localStorage write failed:", e); return false; } },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }
  };

  /* ----- Defaults -------------------------------------------------------- */
  var DEFAULT_SETTINGS = {
    mode: "handwritten", paperSize: "A5", autoIncrement: true,
    defaultUnit: "pcs", defaultTaxPercent: 0, defaultDiscount: 0, lastBillNumber: ""
  };

  var settings = Object.assign({}, DEFAULT_SETTINGS);
  var bill = freshBill(null);
  var currentCalc = null;

  /* ----- Math helpers ---------------------------------------------------- */
  function round2(x) { return Math.round((x + Number.EPSILON) * 100) / 100; }
  function randSeed() { return (Math.floor(Math.random() * 0xFFFFFFFF)) >>> 0; }
  function fmt(n) { return window.Handwriting && window.Handwriting._formatINR ? window.Handwriting._formatINR(n) : n.toFixed(2); }

  /* ----- Amount in words (Indian numbering, INR) — design §8 ----------- */
  var ONES = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
    "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
  var TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
  var SCALE = ["", "thousand", "lakh", "crore"];

  function twoDigits(n) {
    if (n < 20) return ONES[n];
    var t = Math.floor(n / 10), u = n % 10;
    return TENS[t] + (u ? "-" + ONES[u] : "");
  }
  function threeDigits(n) {
    var h = Math.floor(n / 100), rest = n % 100;
    var s = h ? ONES[h] + " hundred" : "";
    if (rest) s += (h ? " " : "") + twoDigits(rest);
    return s;
  }
  function integerWords(n) {
    if (n === 0) return "zero";
    var groups = [];
    groups.push(n % 1000); n = Math.floor(n / 1000);
    while (n > 0) { groups.push(n % 100); n = Math.floor(n / 100); }
    var words = threeDigits(groups[0]);
    for (var i = 1; i < groups.length; i++) {
      if (groups[i]) words = twoDigits(groups[i]) + " " + SCALE[i] + (words ? " " + words : "");
    }
    return words.trim();
  }
  function amountToWords(num) {
    var neg = num < 0; num = Math.abs(num);
    var rupees = Math.floor(num + 1e-9);
    var paise = Math.round((num - rupees) * 100);
    var s = "Rupees " + integerWords(rupees);
    if (paise > 0) s += " and " + twoDigits(paise) + " paise";
    s += " Only";
    return (neg ? "Minus " : "") + s.replace(/\s+/g, " ").trim();
  }

  /* ----- Bill number auto-increment — design §4 ------------------------- */
  function nextBillNumber(s) {
    s = String(s == null ? "" : s);
    var m = s.match(/^(.*?)(\d+)(\D*)$/);
    if (!m) return s + "1";
    var pre = m[1], num = m[2], post = m[3];
    var next = String(Number(num) + 1).padStart(num.length, "0");
    return pre + next + post;
  }

  /* ----- Bill construction ---------------------------------------------- */
  function emptyItem() { return { name: "", qty: 1, unit: settings.defaultUnit || "pcs", rate: 0 }; }
  function todayISO() { var d = new Date(); var m = String(d.getMonth() + 1).padStart(2, "0"); var day = String(d.getDate()).padStart(2, "0"); return d.getFullYear() + "-" + m + "-" + day; }
  function freshBill(shop) {
    var bn = "";
    if (settings.autoIncrement) bn = nextBillNumber(settings.lastBillNumber || "");
    else bn = settings.lastBillNumber || "";
    return {
      shop: shop ? { name: shop.name || "", address: shop.address || "", phone: shop.phone || "", gstOrReg: shop.gstOrReg || "" } : { name: "", address: "", phone: "", gstOrReg: "" },
      meta: { billNumber: bn, date: todayISO(), customerName: "" },
      items: [emptyItem()],
      discount: settings.defaultDiscount || 0,
      taxPercent: settings.defaultTaxPercent || 0,
      renderSeed: randSeed()
    };
  }

  /* ----- Totals ---------------------------------------------------------- */
  function computeTotals(b) {
    var subtotal = 0;
    (b.items || []).forEach(function (it) {
      if (!it) return;
      var q = +it.qty, r = +it.rate;
      if (it.name && String(it.name).trim() && isFinite(q) && q > 0 && isFinite(r) && r >= 0) subtotal += q * r;
    });
    subtotal = round2(subtotal);
    var discount = isFinite(+b.discount) ? +b.discount : 0;
    if (discount < 0) discount = 0;
    var discountCapped = false;
    if (discount > subtotal) { discount = subtotal; discountCapped = subtotal > 0; }
    discount = round2(discount);
    var taxable = round2(subtotal - discount);
    var tp = isFinite(+b.taxPercent) ? +b.taxPercent : 0;
    var taxClamped = false;
    if (tp < 0) { tp = 0; taxClamped = true; }
    if (tp > 100) { tp = 100; taxClamped = true; }
    var taxAmount = round2(taxable * tp / 100);
    var grandTotal = round2(taxable + taxAmount);
    return { subtotal: subtotal, discount: discount, taxable: taxable, taxAmount: taxAmount, grandTotal: grandTotal, words: amountToWords(grandTotal), tp: tp, discountCapped: discountCapped, taxClamped: taxClamped };
  }

  /* ----- DOM refs -------------------------------------------------------- */
  var els = {};
  function cacheEls() {
    ["toolbar", "formPane", "previewPane", "preview", "printArea", "fontNotice", "fontNoticeText", "fontNoticeClose",
     "modeHandwritten", "modeComputerized", "paperSize", "autoIncrement", "rerollBtn", "newBtn", "pngBtn", "printBtn", "pdfBtn",
     "shopName", "shopAddress", "shopPhone", "shopGst", "billNumber", "billDate", "customerName", "discount", "taxPercent",
     "subtotalVal", "taxableVal", "taxVal", "grandVal", "discountNote", "taxNote", "items", "addItemBtn", "previewHint"]
      .forEach(function (id) { els[id] = document.getElementById(id); });
  }

  /* ----- Load state ------------------------------------------------------ */
  function loadState() {
    var savedShop = ls.get(KEYS.shop);
    var savedSettings = ls.get(KEYS.settings);
    if (savedSettings) Object.assign(settings, DEFAULT_SETTINGS, savedSettings);
    var savedCurrent = ls.get(KEYS.current);
    if (savedCurrent && savedCurrent && typeof savedCurrent === "object") {
      bill = normalizeBill(savedCurrent, savedShop);
    } else {
      bill = freshBill(savedShop || null);
    }
    if (!settings.lastBillNumber && bill.meta && bill.meta.billNumber) settings.lastBillNumber = bill.meta.billNumber;
  }
  function normalizeBill(raw, savedShop) {
    var shop = raw.shop || savedShop || {};
    var b = {
      shop: { name: shop.name || "", address: shop.address || "", phone: shop.phone || "", gstOrReg: shop.gstOrReg || "" },
      meta: { billNumber: (raw.meta && raw.meta.billNumber) || "", date: (raw.meta && raw.meta.date) || todayISO(), customerName: (raw.meta && raw.meta.customerName) || "" },
      items: Array.isArray(raw.items) && raw.items.length ? raw.items.map(function (it) { return { name: it.name || "", qty: +it.qty || 1, unit: it.unit || "pcs", rate: +it.rate || 0 }; }) : [emptyItem()],
      discount: +raw.discount || 0,
      taxPercent: +raw.taxPercent || 0,
      renderSeed: +raw.renderSeed || randSeed()
    };
    return b;
  }

  /* ----- Populate form from bill ---------------------------------------- */
  function populateForm() {
    els.shopName.value = bill.shop.name || "";
    els.shopAddress.value = bill.shop.address || "";
    els.shopPhone.value = bill.shop.phone || "";
    els.shopGst.value = bill.shop.gstOrReg || "";
    els.billNumber.value = bill.meta.billNumber || "";
    els.billDate.value = bill.meta.date || todayISO();
    els.customerName.value = bill.meta.customerName || "";
    els.discount.value = bill.discount || 0;
    els.taxPercent.value = bill.taxPercent || 0;
    els.paperSize.value = settings.paperSize || "A5";
    els.autoIncrement.checked = !!settings.autoIncrement;
    setModeUI(settings.mode);
  }

  /* ----- Items rendering ------------------------------------------------- */
  function createItemRow(item) {
    var row = document.createElement("div");
    row.className = "item-row";
    row._item = item;
    row.innerHTML =
      '<input class="i-name" type="text" placeholder="Item name" aria-label="Item name">' +
      '<input class="i-qty" type="number" min="0" step="any" placeholder="Qty" aria-label="Quantity">' +
      '<input class="i-unit" type="text" placeholder="Unit" aria-label="Unit">' +
      '<input class="i-rate" type="number" min="0" step="any" placeholder="Rate" aria-label="Rate">' +
      '<div class="amount-cell">0.00</div>' +
      '<button class="rm-btn" type="button" title="Remove item" aria-label="Remove item">&times;</button>';
    row.querySelector(".i-name").value = item.name || "";
    row.querySelector(".i-qty").value = (+item.qty > 0) ? item.qty : "";
    row.querySelector(".i-unit").value = item.unit || "";
    row.querySelector(".i-rate").value = (item.rate != null && +item.rate !== 0) ? item.rate : (item.rate == null ? "" : "0");
    updateRowAmount(row);
    return row;
  }
  function updateRowAmount(row) {
    var it = row._item;
    var q = +it.qty, r = +it.rate;
    var amt = (q > 0 && r >= 0 && isFinite(q) && isFinite(r)) ? round2(q * r) : 0;
    row.querySelector(".amount-cell").textContent = fmt(amt);
  }
  function renderItems() {
    els.items.innerHTML = "";
    bill.items.forEach(function (it) { els.items.appendChild(createItemRow(it)); });
  }
  function addItem() {
    var it = emptyItem();
    bill.items.push(it);
    var row = createItemRow(it);
    els.items.appendChild(row);
    row.querySelector(".i-name").focus();
    scheduleSave();
  }
  function removeItem(row) {
    var it = row._item;
    var idx = bill.items.indexOf(it);
    if (idx >= 0) bill.items.splice(idx, 1);
    row.remove();
    if (bill.items.length === 0) {
      var fresh = emptyItem();
      bill.items.push(fresh);
      els.items.appendChild(createItemRow(fresh));
    }
    updateTotals();
    schedulePreview();
    scheduleSave();
    updatePrintEnabled();
  }

  /* ----- Totals display -------------------------------------------------- */
  function updateTotals() {
    var c = computeTotals(bill);
    currentCalc = c;
    els.subtotalVal.textContent = fmt(c.subtotal);
    els.taxableVal.textContent = fmt(c.taxable);
    els.taxVal.textContent = fmt(c.taxAmount);
    els.grandVal.textContent = fmt(c.grandTotal);
    els.discountNote.hidden = !c.discountCapped;
    els.taxNote.hidden = !c.taxClamped;
    return c;
  }

  /* ----- Preview rendering ---------------------------------------------- */
  function paperClass() { return settings.paperSize === "A4" ? "paper-a4" : "paper-a5"; }
  function applyPaper() {
    document.body.classList.toggle("paper-a4", settings.paperSize === "A4");
    document.body.classList.toggle("paper-a5", settings.paperSize !== "A4");
  }
  function renderPreview() {
    var c = updateTotals();
    els.preview.className = "bill " + paperClass();
    if (settings.mode === "computerized") {
      window.Handwriting.renderComputerized(els.preview, bill, settings.paperSize, c);
    } else {
      window.Handwriting.renderHandwritten(els.preview, bill, settings.paperSize, c);
    }
    updatePrintEnabled();
  }
  var _previewTimer = null;
  function schedulePreview() { if (_previewTimer) clearTimeout(_previewTimer); _previewTimer = setTimeout(renderPreview, 120); }
  var _saveTimer = null;
  function scheduleSave() { if (_saveTimer) clearTimeout(_saveTimer); _saveTimer = setTimeout(saveCurrent, 250); }

  /* ----- Persistence ----------------------------------------------------- */
  function saveCurrent() {
    var clean = {
      shop: bill.shop,
      meta: bill.meta,
      items: bill.items.map(function (it) { return { name: it.name, qty: it.qty, unit: it.unit, rate: it.rate }; }),
      discount: bill.discount,
      taxPercent: bill.taxPercent,
      renderSeed: bill.renderSeed
    };
    ls.set(KEYS.current, clean);
    ls.set(KEYS.shop, bill.shop);
    if (bill.meta && bill.meta.billNumber) settings.lastBillNumber = bill.meta.billNumber;
    saveSettings();
  }
  function saveSettings() { ls.set(KEYS.settings, settings); }

  /* ----- Print enable / validation -------------------------------------- */
  function canPrint() {
    var shopOk = !!(bill.shop && bill.shop.name && String(bill.shop.name).trim());
    var billOk = !!(bill.meta && bill.meta.billNumber && String(bill.meta.billNumber).trim());
    var itemsOk = (bill.items || []).some(function (it) { return it && it.name && String(it.name).trim() && isFinite(+it.qty) && +it.qty > 0 && isFinite(+it.rate) && +it.rate >= 0; });
    return shopOk && billOk && itemsOk;
  }
  function updatePrintEnabled() {
    var ok = canPrint();
    els.printBtn.disabled = !ok;
    els.pdfBtn.disabled = !ok;
    els.shopName.classList.toggle("invalid", !!(bill.shop && !String(bill.shop.name).trim()) && !ok);
    els.billNumber.classList.toggle("invalid", !!(bill.meta && !String(bill.meta.billNumber).trim()) && !ok);
  }

  /* ----- Mode UI --------------------------------------------------------- */
  function setModeUI(mode) {
    settings.mode = mode;
    var isHW = mode === "handwritten";
    els.modeHandwritten.setAttribute("aria-pressed", String(isHW));
    els.modeComputerized.setAttribute("aria-pressed", String(!isHW));
    // Roving tabindex: active button is tabbable, inactive is not
    els.modeHandwritten.setAttribute("tabindex", isHW ? "0" : "-1");
    els.modeComputerized.setAttribute("tabindex", isHW ? "-1" : "0");
    els.rerollBtn.style.display = isHW ? "" : "none";
    els.previewHint.textContent = mode === "computerized" ? "Computerized" : "Handwritten";
  }

  /* ----- Print / PDF ----------------------------------------------------- */
  function printBill() {
    if (!canPrint()) { return; }
    if (typeof window.print !== "function") { alert("Printing is not available in this browser."); return; }
    var clone = els.preview.cloneNode(true);
    clone.removeAttribute("id");
    clone.removeAttribute("aria-live");
    els.printArea.innerHTML = "";
    els.printArea.appendChild(clone);
    var cleanup = function () { els.printArea.innerHTML = ""; window.onafterprint = null; };
    window.onafterprint = cleanup;
    setTimeout(function () { window.print(); }, 60);
    // Fallback teardown in case onafterprint does not fire.
    setTimeout(cleanup, 60000);
  }

  /* ----- PNG export (nice-to-have) -------------------------------------- */
  function captureCSS() {
    var css = "";
    try {
      for (var i = 0; i < document.styleSheets.length; i++) {
        var ss = document.styleSheets[i];
        try { for (var j = 0; j < ss.cssRules.length; j++) { css += ss.cssRules[j].cssText + "\n"; } } catch (e) { /* cross-origin */ }
      }
    } catch (e) { /* ignore */ }
    return css;
  }
  function rasterize(svgStr, outW, outH, scale) {
    return new Promise(function (resolve, reject) {
      var blob = new Blob([svgStr], { type: "image/svg+xml;charset=utf-8" });
      var url = URL.createObjectURL(blob);
      var img = new Image();
      img.onload = function () {
        var c = document.createElement("canvas");
        c.width = Math.round(outW * scale); c.height = Math.round(outH * scale);
        var cx = c.getContext("2d");
        cx.fillStyle = "#ffffff"; cx.fillRect(0, 0, c.width, c.height);
        cx.drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        c.toBlob(function (b) { b ? resolve(b) : reject(new Error("toBlob failed")); }, "image/png");
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error("image load failed")); };
      img.src = url;
    });
  }
  function saveBlob(blob, name) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
  }
  function safeName(s) { return String(s || "bill").replace(/[^a-z0-9\-_]+/gi, "_").slice(0, 40) || "bill"; }
  function downloadPNG() {
    var P = settings.paperSize === "A4" ? { W: 794, H: 1123 } : { W: 559, H: 794 };
    var svg = els.preview.querySelector("svg.hw-bill");
    var svgStr;
    if (svg) {
      var clone = svg.cloneNode(true);
      clone.setAttribute("width", P.W); clone.setAttribute("height", P.H); clone.removeAttribute("class");
      svgStr = new XMLSerializer().serializeToString(clone);
    } else {
      var receipt = els.preview.querySelector(".receipt");
      if (!receipt) return;
      var css = captureCSS();
      var inner = '<div xmlns="http://www.w3.org/1999/xhtml" class="bill ' + paperClass() + '">' + receipt.outerHTML + "</div>";
      svgStr = '<svg xmlns="http://www.w3.org/2000/svg" width="' + P.W + '" height="' + P.H + '" viewBox="0 0 ' + P.W + " " + P.H +
        '"><foreignObject width="100%" height="100%"><style>' + css + "</style>" + inner + "</foreignObject></svg>";
    }
    rasterize(svgStr, P.W, P.H, 2).then(function (blob) {
      saveBlob(blob, safeName(bill.meta.billNumber) + ".png");
    }, function (e) { alert("Could not export PNG: " + e.message); });
  }

  /* ----- Font fallback --------------------------------------------------- */
  function injectGoogleFonts() {
    if (document.getElementById("gfFallback")) return;
    var link = document.createElement("link");
    link.id = "gfFallback"; link.rel = "stylesheet";
    link.href = "https://fonts.googleapis.com/css2?family=Patrick+Hand&family=Caveat&family=Kalam&family=Indie+Flower&family=Homemade+Apple&family=Gaegu&family=Just+Another+Hand&family=Shadows+Into+Light&display=swap";
    document.head.appendChild(link);
  }
  function showFontNotice() {
    els.fontNoticeText.textContent = "Handwriting fonts weren't found locally. An internet connection is needed this first time to load them. After they load once, you can go offline.";
    els.fontNotice.classList.remove("hidden");
  }

  /* ----- Event wiring ---------------------------------------------------- */
  function wireEvents() {
    // Shop / bill fields
    els.shopName.addEventListener("input", function (e) { bill.shop.name = e.target.value; schedulePreview(); scheduleSave(); updatePrintEnabled(); });
    els.shopAddress.addEventListener("input", function (e) { bill.shop.address = e.target.value; schedulePreview(); scheduleSave(); });
    els.shopPhone.addEventListener("input", function (e) { bill.shop.phone = e.target.value; schedulePreview(); scheduleSave(); });
    els.shopGst.addEventListener("input", function (e) { bill.shop.gstOrReg = e.target.value; schedulePreview(); scheduleSave(); });
    els.billNumber.addEventListener("input", function (e) { bill.meta.billNumber = e.target.value; schedulePreview(); scheduleSave(); updatePrintEnabled(); });
    els.billDate.addEventListener("input", function (e) { bill.meta.date = e.target.value; schedulePreview(); scheduleSave(); });
    els.billDate.addEventListener("change", function (e) { if (!e.target.value || !/^\d{4}-\d{2}-\d{2}$/.test(e.target.value)) { var t = todayISO(); bill.meta.date = t; e.target.value = t; schedulePreview(); scheduleSave(); } });
    els.customerName.addEventListener("input", function (e) { bill.meta.customerName = e.target.value; schedulePreview(); scheduleSave(); });
    els.discount.addEventListener("input", function (e) { bill.discount = isFinite(parseFloat(e.target.value)) ? parseFloat(e.target.value) : 0; updateTotals(); schedulePreview(); scheduleSave(); });
    els.taxPercent.addEventListener("input", function (e) { bill.taxPercent = isFinite(parseFloat(e.target.value)) ? parseFloat(e.target.value) : 0; updateTotals(); schedulePreview(); scheduleSave(); });

    // Items (delegated)
    els.items.addEventListener("input", function (e) {
      var row = e.target.closest(".item-row"); if (!row) return;
      var it = row._item;
      if (e.target.classList.contains("i-name")) it.name = e.target.value;
      else if (e.target.classList.contains("i-qty")) it.qty = isFinite(parseFloat(e.target.value)) ? parseFloat(e.target.value) : 0;
      else if (e.target.classList.contains("i-unit")) it.unit = e.target.value;
      else if (e.target.classList.contains("i-rate")) it.rate = isFinite(parseFloat(e.target.value)) ? parseFloat(e.target.value) : 0;
      updateRowAmount(row);
      updateTotals();
      schedulePreview();
      scheduleSave();
      updatePrintEnabled();
    });
    els.items.addEventListener("click", function (e) {
      if (e.target.closest(".rm-btn")) removeItem(e.target.closest(".item-row"));
    });
    els.addItemBtn.addEventListener("click", addItem);

    // Toolbar
    els.modeHandwritten.addEventListener("click", function () { setModeUI("handwritten"); renderPreview(); saveSettings(); });
    els.modeComputerized.addEventListener("click", function () { setModeUI("computerized"); renderPreview(); saveSettings(); });
    // Arrow-key roving tabindex on the segmented control
    var segBtns = [els.modeHandwritten, els.modeComputerized];
    segBtns.forEach(function (btn, idx) {
      btn.addEventListener("keydown", function (e) {
        var prev = (idx - 1 + segBtns.length) % segBtns.length;
        var next = (idx + 1) % segBtns.length;
        if (e.key === "ArrowRight" || e.key === "ArrowDown") {
          e.preventDefault();
          segBtns[next].focus();
          segBtns[next].click();
        } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
          e.preventDefault();
          segBtns[prev].focus();
          segBtns[prev].click();
        }
      });
    });
    els.paperSize.addEventListener("change", function (e) { settings.paperSize = e.target.value; applyPaper(); renderPreview(); saveSettings(); });
    els.autoIncrement.addEventListener("change", function (e) { settings.autoIncrement = e.target.checked; saveSettings(); });
    els.rerollBtn.addEventListener("click", function () { bill.renderSeed = randSeed(); scheduleSave(); renderPreview(); });
    els.newBtn.addEventListener("click", newBill);
    els.printBtn.addEventListener("click", printBill);
    els.pdfBtn.addEventListener("click", printBill);
    els.pngBtn.addEventListener("click", downloadPNG);
    els.fontNoticeClose.addEventListener("click", function () { els.fontNotice.classList.add("hidden"); });

    // Ctrl+P triggers our print path so the clone is set up.
    window.addEventListener("beforeprint", function () {
      if (!els.printArea.hasChildNodes() && canPrint()) {
        var clone = els.preview.cloneNode(true); clone.removeAttribute("id"); clone.removeAttribute("aria-live");
        els.printArea.appendChild(clone);
      }
    });
    window.addEventListener("afterprint", function () { els.printArea.innerHTML = ""; });
  }

  function newBill() {
    bill = freshBill(bill.shop);
    if (bill.meta.billNumber) settings.lastBillNumber = bill.meta.billNumber;
    populateForm();
    renderItems();
    applyPaper();
    renderPreview();
    saveSettings();
    saveCurrent();
    els.customerName.focus();
  }

  /* ----- Init ------------------------------------------------------------ */
  function init() {
    cacheEls();
    loadState();
    applyPaper();
    populateForm();
    renderItems();
    wireEvents();
    updateTotals();
    updatePrintEnabled();
    renderPreview();
    initFonts();
  }
  function initFonts() {
    if (!window.Handwriting || !window.Handwriting.fontsReady) { renderPreview(); return; }
    window.Handwriting.fontsReady().then(function (primaryOk) {
      if (!primaryOk) { injectGoogleFonts(); showFontNotice(); }
      renderPreview();
      if (document.fonts && document.fonts.ready) { document.fonts.ready.then(renderPreview).catch(function () {}); }
    }, function () { renderPreview(); });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();

  // expose a tiny API for the verification harness / debugging
  window.BillApp = { amountToWords: amountToWords, nextBillNumber: nextBillNumber, computeTotals: computeTotals, round2: round2 };
})();

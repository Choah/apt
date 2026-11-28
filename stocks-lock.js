/* The only stock-page script the site serves in the clear. It asks for the password, decrypts the
   data (window.STOCK_ENC) and the page code (window.STOCK_APP_ENC), both made by
   scripts/encrypt_stocks.mjs, then runs the page code. PBKDF2-HMAC-SHA256 -> AES-256-GCM -> gunzip.
   The crypto part has no DOM; scripts/test_stock_signals.py runs it under node. */
(function (root) {
  "use strict";

  function fromB64(s) {
    var bin = atob(s), u = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
  }
  function toB64(u) {
    var s = "";
    for (var i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
    return btoa(s);
  }

  function supported() {
    return !!(root.crypto && root.crypto.subtle && typeof root.DecompressionStream === "function"
      && typeof root.Response === "function" && typeof root.Blob === "function");
  }

  // password -> raw 32-byte key (Uint8Array). Slow on purpose (enc.iter rounds).
  function deriveKey(password, enc) {
    var subtle = root.crypto.subtle;
    return subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"])
      .then(function (base) {
        return subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: fromB64(enc.salt), iterations: enc.iter }, base, 256);
      })
      .then(function (bits) { return new Uint8Array(bits); });
  }

  // raw key -> text. Rejects (OperationError) if the key is wrong, or if the payload is damaged.
  function decryptText(rawKey, enc) {
    var subtle = root.crypto.subtle;
    return subtle.importKey("raw", rawKey, "AES-GCM", false, ["decrypt"])
      .then(function (key) { return subtle.decrypt({ name: "AES-GCM", iv: fromB64(enc.iv) }, key, fromB64(enc.ct)); })
      .then(function (plain) {
        if (!enc.gz) return new TextDecoder().decode(plain);
        var stream = new root.Blob([plain]).stream().pipeThrough(new root.DecompressionStream("gzip"));
        return new root.Response(stream).text();
      });
  }
  function decrypt(rawKey, enc) { return decryptText(rawKey, enc).then(function (json) { return JSON.parse(json); }); }

  function unlock(password, enc) {
    return deriveKey(password, enc).then(function (raw) {
      return decrypt(raw, enc).then(function (data) { return { data: data, key: raw }; });
    });
  }

  root.StockLock = { supported: supported, deriveKey: deriveKey, decrypt: decrypt, decryptText: decryptText,
    unlock: unlock, toB64: toB64, fromB64: fromB64 };

  if (typeof document === "undefined") return;  // node tests: crypto only

  // ------------------------------------------------------------------ page: lock screen and boot
  // The derived key (not the password) can be kept on this device so the page opens straight away
  // next time; it is tied to the salt and rounds, so a new password makes it fail. 잠그기 forgets it.
  var KEY_STORE = "apt.stocks.key.v1";
  var ENC = root.STOCK_ENC, APP = root.STOCK_APP_ENC;
  var page = document.getElementById("sx-root");
  var lockBtn = document.getElementById("sx-btn-lock");

  function el(tag, attrs) {
    var e = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) return;
      if (k === "class") e.className = v;
      else if (k === "text") e.textContent = v;
      else e.setAttribute(k, v === true ? "" : v);
    });
    for (var i = 2; i < arguments.length; i++) {
      var kid = arguments[i];
      if (kid !== null && kid !== undefined) e.appendChild(typeof kid === "string" ? document.createTextNode(kid) : kid);
    }
    return e;
  }
  function clearPage() { while (page.firstChild) page.removeChild(page.firstChild); }
  function notice(text, cls) { clearPage(); page.appendChild(el("p", { class: cls || "sx-stale", text: text })); }

  function savedKey() {
    try {
      var o = JSON.parse(localStorage.getItem(KEY_STORE));
      return o && o.k && o.salt === ENC.salt && o.iter === ENC.iter ? fromB64(o.k) : null;
    } catch (e) { return null; }
  }
  function saveKey(raw) {
    try { localStorage.setItem(KEY_STORE, JSON.stringify({ salt: ENC.salt, iter: ENC.iter, k: toB64(raw) })); } catch (e) { /* private mode */ }
  }
  function forgetKey() { try { localStorage.removeItem(KEY_STORE); } catch (e) { /* private mode */ } }

  // decrypt data + page code with the key, then run the page code
  function openPage(raw) {
    return Promise.all([decrypt(raw, ENC), decryptText(raw, APP)]).then(function (r) {
      root.STOCK_DATA = r[0];
      clearPage();
      lockBtn.hidden = false;
      return new Promise(function (resolve, reject) {
        var s = document.createElement("script");
        s.src = URL.createObjectURL(new root.Blob([r[1]], { type: "text/javascript" }));
        s.onload = function () { URL.revokeObjectURL(s.src); resolve(); };
        s.onerror = function () { reject(new Error("page code failed to load")); };
        document.body.appendChild(s);
      });
    });
  }

  function showLock() {
    clearPage();
    var input = el("input", { id: "sx-pin", type: "password", inputmode: "numeric", autocomplete: "current-password",
      enterkeyhint: "go", "aria-describedby": "sx-lock-note sx-lock-err" });
    var remember = el("input", { type: "checkbox", checked: true });
    var submit = el("button", { type: "submit", class: "btn btn-primary btn-wide", text: "열기" });
    var err = el("p", { id: "sx-lock-err", class: "sx-lock-err", role: "alert" });
    function busy(on) {
      input.disabled = submit.disabled = remember.disabled = on;
      submit.textContent = on ? "여는 중…" : "열기";
    }
    var form = el("form", { class: "sx-lock-form", novalidate: true },
      el("label", { class: "sx-lock-label", for: "sx-pin", text: "비밀번호" }), input,
      el("label", { class: "sx-lock-remember" }, remember, "이 기기에서 기억하기"),
      submit, err);
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      if (!input.value) { err.textContent = "비밀번호를 입력하세요."; input.focus(); return; }
      err.textContent = "";
      busy(true);
      deriveKey(input.value, ENC).then(function (raw) {
        return openPage(raw).then(function () { if (remember.checked) saveKey(raw); else forgetKey(); });
      }).catch(function (e2) {
        if (!page.querySelector(".sx-lock")) { notice("페이지를 열지 못했습니다. 잠시 뒤 새로고침해 보세요."); if (root.console) console.error(e2); return; }
        busy(false);
        input.value = "";
        // AES-GCM reports a wrong key as OperationError; anything else is a damaged or unreadable file
        var wrong = e2 && e2.name === "OperationError";
        err.textContent = wrong ? "비밀번호가 맞지 않습니다." : "데이터를 열지 못했습니다. 잠시 뒤 새로고침해 보세요.";
        if (!wrong && root.console) console.error(e2);
        input.focus();
      });
    });
    page.appendChild(el("section", { class: "sx-box sx-lock", "aria-labelledby": "sx-lock-title" },
      el("h2", { id: "sx-lock-title", text: "비밀번호를 입력하세요" }),
      el("p", { id: "sx-lock-note", class: "sx-lock-note", text: "주식 신호는 비밀번호를 아는 사람만 볼 수 있습니다." }),
      form));
    input.focus();
  }

  function boot() {
    if (!ENC || !ENC.ct || !APP || !APP.ct) { notice("주식 데이터 파일을 불러오지 못했습니다."); return; }
    if (!supported()) { notice("이 브라우저에서는 열 수 없습니다. 최신 Chrome, Safari, Edge에서 https 주소로 열어 주세요."); return; }
    var k = savedKey();
    if (!k) { showLock(); return; }
    notice("여는 중…", "sx-lock-note");
    openPage(k).catch(function () { forgetKey(); showLock(); });
  }

  lockBtn.addEventListener("click", function () { forgetKey(); location.reload(); });
  boot();
})(typeof window !== "undefined" ? window : globalThis);

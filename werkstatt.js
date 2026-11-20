// Codekoje-Werkstatt – Oberfläche (ehemals Pykoje)
// Daten liegen unter dem Kürzel "pykoje" im Browser – so bleiben Projekte aus der alten Pykoje erhalten.
"use strict";
const $ = (id) => document.getElementById(id);
const LS = {
  get(k, d) { try { const v = localStorage.getItem("pykoje:" + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem("pykoje:" + k, JSON.stringify(v)); } catch (e) { } },
  del(k) { try { localStorage.removeItem("pykoje:" + k); } catch (e) { } },
};

/* =====================================================================
   0) Live-Modus vorbereiten (Cross-Origin-Isolation per Service Worker)
   ===================================================================== */
async function serviceWorkerKlaeren() {
  if (!("serviceWorker" in navigator) || !window.isSecureContext) return false;
  try {
    const reg = await navigator.serviceWorker.register("sw.js");
    if (window.crossOriginIsolated) return false;
    // Einmal neu laden, sobald der Service Worker die Seite kontrolliert → dann ist SharedArrayBuffer da
    if (!sessionStorage.getItem("pykoje-reload")) {
      sessionStorage.setItem("pykoje-reload", "1");
      if (navigator.serviceWorker.controller) { location.reload(); return true; }
      await new Promise((ok) => {
        navigator.serviceWorker.addEventListener("controllerchange", ok, { once: true });
        setTimeout(ok, 4000);
        if (reg.active && !navigator.serviceWorker.controller) reg.active.postMessage("claim");
      });
      location.reload();
      return true;
    }
  } catch (e) { }
  return false;
}

const LIVE = !!(window.crossOriginIsolated && typeof SharedArrayBuffer !== "undefined");
let SAB = null, ctrl, einBuf, intr, sensArr;
if (LIVE) {
  SAB = {
    ctrl: new SharedArrayBuffer(8),
    daten: new SharedArrayBuffer(64 * 1024),
    intr: new SharedArrayBuffer(1),
    sensor: new SharedArrayBuffer(8 * 64),
    schlaf: new SharedArrayBuffer(4),
  };
  ctrl = new Int32Array(SAB.ctrl); einBuf = new Uint8Array(SAB.daten);
  intr = new Uint8Array(SAB.intr); sensArr = new Float64Array(SAB.sensor);
}

/* =====================================================================
   1) Projekte speichern (IndexedDB)
   ===================================================================== */
const DB = {
  db: null, mem: {},
  async open() {
    try {
      this.db = await new Promise((ok, nein) => {
        const r = indexedDB.open("pykoje", 1);
        r.onupgradeneeded = () => r.result.createObjectStore("projekte", { keyPath: "name" });
        r.onsuccess = () => ok(r.result); r.onerror = () => nein(r.error);
      });
    } catch (e) { this.db = null; }
  },
  tx(modus) { return this.db.transaction("projekte", modus).objectStore("projekte"); },
  alle() {
    if (!this.db) return Promise.resolve(Object.values(this.mem));
    return new Promise((ok, nein) => { const r = this.tx("readonly").getAll(); r.onsuccess = () => ok(r.result); r.onerror = () => nein(r.error); });
  },
  put(p) {
    if (!this.db) { this.mem[p.name] = p; return Promise.resolve(); }
    return new Promise((ok, nein) => { const r = this.tx("readwrite").put(p); r.onsuccess = () => ok(); r.onerror = () => nein(r.error); });
  },
  del(name) {
    if (!this.db) { delete this.mem[name]; return Promise.resolve(); }
    return new Promise((ok, nein) => { const r = this.tx("readwrite").delete(name); r.onsuccess = () => ok(); r.onerror = () => nein(r.error); });
  },
};

let projekte = {};   // name → Projekt
let P = null;        // aktuelles Projekt
let aktDatei = null; // aktuell offene Datei

function neuesProjekt(name, dateien, ziel) {
  return { name, ziel: ziel || "", haupt: "main.py", dateien: dateien || { "main.py": "" }, github: { repo: "", branch: "", sha: null, zeit: null }, mentor: [], eingaben: "", offen: null };
}

let speicherTimer = null;
function speichern(sofort) {
  if (!P) return;
  clearTimeout(speicherTimer);
  const tu = () => DB.put(P).catch((e) => schreibe("Speichern fehlgeschlagen: " + e + "\n", "err"));
  if (sofort) return tu();
  speicherTimer = setTimeout(tu, 400);
}

/* =====================================================================
   2) Hilfen: Dialoge, Ausgabe, Status
   ===================================================================== */
function dialog(text, { eingabe = null, knoepfe = [["Abbrechen", null], ["OK", true, "haupt"]] } = {}) {
  return new Promise((ok) => {
    $("dlgText").textContent = text;
    const inp = $("dlgIn");
    inp.style.display = eingabe === null ? "none" : "";
    inp.value = eingabe || "";
    const box = $("dlgKnoepfe"); box.innerHTML = "";
    const zu = (w) => { $("dialog").classList.remove("an"); inp.onkeydown = null; ok(w); };
    knoepfe.forEach(([t, w, kl]) => {
      const b = document.createElement("button"); b.type = "button"; b.textContent = t; b.className = !kl ? "btn ghost small" : kl === "haupt" ? "btn small" : kl;
      b.onclick = () => zu(w === true && eingabe !== null ? inp.value.trim() : w);
      box.appendChild(b);
    });
    inp.onkeydown = (e) => { if (e.key === "Enter") zu(inp.value.trim()); if (e.key === "Escape") zu(null); };
    $("dialog").classList.add("an");
    if (eingabe !== null) setTimeout(() => { inp.focus(); inp.select(); }, 30);
  });
}
const frage = (text, vorgabe) => dialog(text, { eingabe: vorgabe || "" });
const bestaetige = (text, ja = "OK") => dialog(text, { knoepfe: [["Abbrechen", false], [ja, true, "haupt"]] });
const melde = (text) => dialog(text, { knoepfe: [["OK", true, "haupt"]] });

const aus = $("ausgabe");
function schreibe(text, klasse) {
  const unten = aus.scrollHeight - aus.scrollTop - aus.clientHeight < 40;
  const s = document.createElement("span"); if (klasse) s.className = klasse; s.textContent = text; aus.appendChild(s);
  // nicht endlos wachsen lassen
  while (aus.childNodes.length > 3000) aus.removeChild(aus.firstChild);
  if (unten) aus.scrollTop = aus.scrollHeight;
}
function schreibeKnopf(text, fn) {
  const b = document.createElement("button"); b.className = "aktion klein"; b.textContent = text; b.onclick = fn;
  aus.appendChild(b); aus.appendChild(document.createTextNode("\n")); aus.scrollTop = aus.scrollHeight;
}
function status(t, ok) { $("status").textContent = t; $("status").classList.toggle("ok", !!ok); }
function zeigeTab(id) { document.querySelector(`.tabs button[data-tab="${id}"]`).click(); }
document.querySelectorAll(".tabs button").forEach((b) => b.onclick = () => {
  document.querySelectorAll(".tabs button").forEach((x) => x.classList.toggle("an", x === b));
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("an", t.id === b.dataset.tab));
  if (b.dataset.tab === "t-mentor") mentorRender();
  if (window.innerWidth <= 820 && document.body.classList.contains("nur-editor")) setzeLayout("");
});
function herunterladen(name, blob) {
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name.split("/").pop();
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
const istText = (v) => typeof v === "string";
function groesse(n) { return n < 1024 ? n + " B" : n < 1048576 ? (n / 1024).toFixed(1) + " KB" : (n / 1048576).toFixed(1) + " MB"; }

/* Base64 & Text */
function bytesZuB64(bytes) {
  let s = ""; const N = 0x8000;
  for (let i = 0; i < bytes.length; i += N) s += String.fromCharCode.apply(null, bytes.subarray(i, i + N));
  return btoa(s);
}
function b64ZuBytes(b64) {
  const s = atob(b64.replace(/\s/g, "")); const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
  return b;
}
const TEXT_ENDUNGEN = /\.(py|txt|csv|tsv|json|md|html?|css|js|toml|cfg|ini|ya?ml|xml|log|sql|sh|gitignore|pyi)$/i;
function bytesZuInhalt(pfad, bytes) {
  if (TEXT_ENDUNGEN.test(pfad) || !bytes.includes(0)) {
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch (e) { }
  }
  return bytes;
}

/* =====================================================================
   3) Editor (CodeMirror, Ersatz: einfaches Textfeld)
   ===================================================================== */
const E = {
  cm: null, ta: null, aendern: null, fehlerMarke: null,
  init() {
    const wrap = $("edWrap");
    if (window.CodeMirror) {
      this.cm = CodeMirror(wrap, {
        value: "", mode: "python", lineNumbers: true, indentUnit: 4, tabSize: 4, indentWithTabs: false,
        matchBrackets: true, autoCloseBrackets: true, styleActiveLine: true, lineWrapping: false,
        gutters: ["CodeMirror-linenumbers", "fehler"], viewportMargin: 50,
        inputStyle: "contenteditable", spellcheck: false, autocorrect: false, autocapitalize: false,
        extraKeys: {
          "Tab": (cm) => cm.somethingSelected() ? cm.indentSelection("add") : cm.replaceSelection("    ", "end"),
          "Shift-Tab": (cm) => cm.indentSelection("subtract"),
          "Ctrl-Enter": () => ausfuehren(), "Cmd-Enter": () => ausfuehren(),
          "Ctrl-Space": () => E.vorschlag(), "Ctrl-/": "toggleComment", "Cmd-/": "toggleComment",
          "Ctrl-S": () => speichern(true), "Cmd-S": () => speichern(true),
        },
      });
      this.cm.on("change", () => this.aendern && this.aendern());
      this.cm.on("inputRead", (cm, ch) => {
        if (ch.text[0] === "." && cm.getOption("mode") === "python") setTimeout(() => E.vorschlag(), 30);
      });
    } else {
      this.ta = document.createElement("textarea"); this.ta.className = "fallback";
      this.ta.spellcheck = false; this.ta.setAttribute("autocapitalize", "off"); this.ta.setAttribute("autocorrect", "off");
      wrap.appendChild(this.ta);
      this.ta.addEventListener("input", () => this.aendern && this.aendern());
      this.ta.addEventListener("keydown", (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); ausfuehren(); }
        else if (e.key === "Tab") { e.preventDefault(); this.einfuegen("    "); }
        else if (e.key === "Enter") {
          const vor = this.ta.value.slice(0, this.ta.selectionStart);
          const z = vor.slice(vor.lastIndexOf("\n") + 1);
          let einr = z.match(/^\s*/)[0]; if (/:\s*(#.*)?$/.test(z)) einr += "    ";
          e.preventDefault(); this.einfuegen("\n" + einr);
        }
      });
      schreibe("Hinweis: Komfort-Editor nicht geladen (offline?) – einfacher Editor aktiv.\n", "info");
    }
  },
  get() { return this.cm ? this.cm.getValue() : this.ta.value; },
  set(text, pfad) {
    const modus = /\.pyi?$/.test(pfad || "") ? "python" : null;
    if (this.cm) {
      const alt = this.aendern; this.aendern = null;
      this.cm.setOption("mode", modus);
      this.cm.setValue(text); this.cm.clearHistory();
      this.aendern = alt;
    } else { this.ta.value = text; }
    this.fehlerWeg();
  },
  ersetzen(text) { // Inhalt tauschen, Cursor behalten
    if (this.cm) { const c = this.cm.getCursor(); const alt = this.aendern; this.aendern = null; this.cm.setValue(text); this.cm.setCursor(c); this.aendern = alt; }
    else this.ta.value = text;
  },
  einfuegen(t) {
    if (this.cm) { this.cm.replaceSelection(t, "end"); this.cm.focus(); }
    else { const a = this.ta.selectionStart, b = this.ta.selectionEnd; this.ta.setRangeText(t, a, b, "end"); this.ta.dispatchEvent(new Event("input")); this.ta.focus(); }
  },
  zeileLoeschen() {
    if (this.cm) { this.cm.execCommand("deleteLine"); this.cm.focus(); return; }
    const v = this.ta.value, p = this.ta.selectionStart;
    const s = v.lastIndexOf("\n", p - 1) + 1; let en = v.indexOf("\n", p); en = en < 0 ? v.length : en + 1;
    this.ta.setRangeText("", s, en, "start"); this.ta.dispatchEvent(new Event("input")); this.ta.focus();
  },
  rueck() { if (this.cm) { this.cm.undo(); this.cm.focus(); } else document.execCommand("undo"); },
  einruecken(minus) { if (this.cm) { this.cm.indentSelection(minus ? "subtract" : "add"); this.cm.focus(); } else if (!minus) this.einfuegen("    "); },
  lesen(nur) { if (this.cm) this.cm.setOption("readOnly", nur); else this.ta.readOnly = nur; },
  fehlerWeg() {
    if (!this.cm) return;
    if (this.fehlerMarke !== null) { this.cm.removeLineClass(this.fehlerMarke, "background", "fehlerzeile"); this.fehlerMarke = null; }
    this.cm.clearGutter("fehler");
  },
  fehler(zeile, text) {
    if (!this.cm || !zeile) return;
    this.fehlerWeg();
    const z = Math.min(zeile - 1, this.cm.lineCount() - 1);
    this.fehlerMarke = this.cm.addLineClass(z, "background", "fehlerzeile");
    const m = document.createElement("span"); m.className = "fehlermarke"; m.textContent = "●"; m.title = text;
    m.onclick = () => melde(`Zeile ${zeile}: ${text}`);
    this.cm.setGutterMarker(z, "fehler", m);
  },
  springe(zeile) { if (this.cm && zeile) { this.cm.setCursor({ line: zeile - 1, ch: 0 }); this.cm.scrollIntoView(null, 80); } },
  vorschlag() {
    if (!this.cm || !window.CodeMirror.showHint) return;
    this.cm.showHint({ hint: jediHinweis, completeSingle: false, closeCharacters: /[\s()\[\]{};:>,=]/ });
  },
};

const PY_WOERTER = ("False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield " +
  "print input len range int float str list dict set tuple open enumerate zip sorted sum min max abs round isinstance type map filter any all").split(" ");
function jediHinweis(cm, fertig) {
  const c = cm.getCursor(), zeile = cm.getLine(c.line);
  let s = c.ch; while (s > 0 && /\w/.test(zeile[s - 1])) s--;
  const wort = zeile.slice(s, c.ch);
  const von = CodeMirror.Pos(c.line, s), bis = CodeMirror.Pos(c.line, c.ch);
  const lokal = () => {
    const woerter = new Set(PY_WOERTER);
    (cm.getValue().match(/[A-Za-z_]\w{2,}/g) || []).forEach((w) => woerter.add(w));
    const l = [...woerter].filter((w) => w.startsWith(wort) && w !== wort).sort().slice(0, 40);
    fertig(l.length ? { list: l, from: von, to: bis } : null);
  };
  if (!bereit || laeuft) return lokal();
  anfrage({ typ: "complete", code: cm.getValue(), zeile: c.line + 1, spalte: c.ch, pfad: projektPfad(aktDatei) }, 6000)
    .then((r) => {
      const l = (r.liste || []).map((x) => ({
        text: x.t, displayText: x.t,
        render: (el) => { el.textContent = x.t; const t = document.createElement("span"); t.className = "hinttyp"; t.textContent = TYPEN[x.y] || x.y; el.appendChild(t); },
      }));
      if (!l.length) return lokal();
      fertig({ list: l, from: von, to: bis });
    }).catch(lokal);
}
jediHinweis.async = true;
const TYPEN = { function: "Funktion", module: "Modul", class: "Klasse", instance: "Objekt", keyword: "Schlüsselwort", statement: "Variable", param: "Parameter", property: "Eigenschaft", path: "Pfad" };

/* Extra-Tasten fürs Handy */
[["Tab", () => E.einruecken(false)], ["⇤", () => E.einruecken(true)], ["💡", () => E.vorschlag()], [":"], ["("], [")"], ["["], ["]"], ["{"], ["}"],
 ["\""], ["'"], ["="], ["=="], ["#"], ["_"], ["."], [","], ["+"], ["-"], ["*"], ["/"], ["<"], [">"], ["f\"\"", () => { E.einfuegen('f""'); if (E.cm) E.cm.execCommand("goCharLeft"); }],
 ["↶", () => E.rueck()], ["⌫ Zeile", () => E.zeileLoeschen()]].forEach(([k, fn]) => {
  const b = document.createElement("button"); b.textContent = k;
  b.onmousedown = (e) => e.preventDefault();
  b.onclick = fn || (() => E.einfuegen(k));
  $("tasten").appendChild(b);
});

/* Syntax-Prüfung während des Tippens */
let pruefTimer = null;
function pruefeSpaeter() {
  clearTimeout(pruefTimer);
  if (!aktDatei || !aktDatei.endsWith(".py")) return;
  pruefTimer = setTimeout(async () => {
    if (!bereit || laeuft) return;
    const datei = aktDatei;
    try {
      const r = await anfrage({ typ: "check", code: E.get(), pfad: projektPfad(datei) }, 4000);
      if (datei !== aktDatei) return;
      if (r.fehler) E.fehler(r.fehler.zeile, "Syntaxfehler: " + r.fehler.msg); else E.fehlerWeg();
    } catch (e) { }
  }, 900);
}

/* =====================================================================
   4) Projekte & Dateien in der Oberfläche
   ===================================================================== */
function projektPfad(datei) { return "/home/pyodide/projekte/" + P.name.replace(/[^\w\-. äöüÄÖÜß]/g, "_") + "/" + datei; }

function fuelleProjekte() {
  const s = $("projekt"); s.innerHTML = "";
  Object.keys(projekte).sort((a, b) => a.localeCompare(b, "de")).forEach((n) => { const o = document.createElement("option"); o.value = o.textContent = n; s.appendChild(o); });
  s.value = P ? P.name : "";
}
function sortierteDateien() {
  return Object.keys(P.dateien).sort((a, b) => {
    const pa = a.endsWith(".py") ? 0 : 1, pb = b.endsWith(".py") ? 0 : 1;
    if (a === P.haupt) return -1; if (b === P.haupt) return 1;
    return pa - pb || a.localeCompare(b, "de");
  });
}
function fuelleDateien() {
  const s = $("datei"); s.innerHTML = "";
  sortierteDateien().forEach((n) => {
    const o = document.createElement("option"); o.value = n;
    o.textContent = (n === P.haupt ? "★ " : "") + n + (istText(P.dateien[n]) ? "" : "  (" + groesse(P.dateien[n].length) + ")");
    s.appendChild(o);
  });
  s.value = aktDatei;
  const h = $("haupt"); h.innerHTML = "";
  Object.keys(P.dateien).filter((n) => n.endsWith(".py")).sort().forEach((n) => { const o = document.createElement("option"); o.value = o.textContent = n; h.appendChild(o); });
  h.value = P.haupt;
}

function oeffneProjekt(name) {
  if (P) { P.offen = aktDatei; speichern(true); }
  P = projekte[name];
  if (!P) return;
  LS.set("projekt", name);
  $("ziel").value = P.ziel || "";
  $("eingaben").value = P.eingaben || "";
  $("ghRepo").value = P.github.repo || "";
  $("ghBranch").value = P.github.branch || "";
  ghStandZeigen();
  zeigePakete();
  fuelleProjekte();
  oeffneDatei(P.offen && P.offen in P.dateien ? P.offen : (P.haupt in P.dateien ? P.haupt : sortierteDateien()[0]));
  letzterFehler = null; $("mFehler").disabled = true;
  mentorRender();
}

function oeffneDatei(n) {
  if (!n) { // Projekt ohne Dateien
    P.dateien["main.py"] = ""; n = "main.py";
  }
  aktDatei = n; P.offen = n;
  const inhalt = P.dateien[n];
  const bin = $("binaer");
  if (istText(inhalt)) {
    bin.style.display = "none"; E.lesen(false);
    E.set(inhalt, n);
  } else {
    E.set("", n); E.lesen(true);
    bin.innerHTML = "";
    if (/\.(png|jpe?g|gif|webp|svg)$/i.test(n)) {
      const img = new Image(); img.src = URL.createObjectURL(new Blob([inhalt], { type: n.endsWith(".svg") ? "image/svg+xml" : "image/" + n.split(".").pop().replace("jpg", "jpeg") }));
      bin.appendChild(img);
    }
    bin.appendChild(document.createTextNode(`Binärdatei „${n}“ (${groesse(inhalt.length)}) – nicht im Editor bearbeitbar. Herunterladen über ⋯`));
    bin.style.display = "flex";
  }
  fuelleDateien();
  speichern();
  pruefeSpaeter();
}

E.init();
E.aendern = () => {
  if (!P || !istText(P.dateien[aktDatei])) return;
  P.dateien[aktDatei] = E.get();
  speichern();
  E.fehlerWeg();
  pruefeSpaeter();
};

$("projekt").onchange = (e) => oeffneProjekt(e.target.value);
$("datei").onchange = (e) => oeffneDatei(e.target.value);
$("ziel").oninput = () => { P.ziel = $("ziel").value; speichern(); };
$("eingaben").oninput = () => { P.eingaben = $("eingaben").value; speichern(); };
$("haupt").onchange = (e) => { P.haupt = e.target.value; speichern(); fuelleDateien(); };

function gueltigerName(n) { return n && !n.startsWith("/") && !n.includes("..") && !/[\\:*?"<>|]/.test(n); }

$("neueDatei").onclick = async () => {
  let n = await frage("Name der neuen Datei (z. B. sensoren.py oder daten.csv):", "modul.py");
  if (!n) return;
  if (!n.includes(".")) n += ".py";
  if (!gueltigerName(n)) return melde("Ungültiger Dateiname.");
  if (!(n in P.dateien)) P.dateien[n] = "";
  oeffneDatei(n); speichern(true);
};

$("dateiMenu").onclick = async () => {
  const w = await dialog(`Datei „${aktDatei}“`, { knoepfe: [["Abbrechen", null], ["⬇ Herunterladen", "dl"], ["✎ Umbenennen", "um"], ["🗑 Löschen", "del"]] });
  if (w === "dl") herunterladen(aktDatei, new Blob([P.dateien[aktDatei]]));
  if (w === "um") {
    const n = await frage("Neuer Name:", aktDatei);
    if (!n || n === aktDatei) return;
    if (!gueltigerName(n) || n in P.dateien) return melde("Name ungültig oder schon vorhanden.");
    P.dateien[n] = P.dateien[aktDatei]; delete P.dateien[aktDatei];
    if (P.haupt === aktDatei) P.haupt = n;
    oeffneDatei(n); speichern(true);
  }
  if (w === "del") {
    if (!(await bestaetige(`„${aktDatei}“ wirklich löschen?`, "Löschen"))) return;
    delete P.dateien[aktDatei];
    if (P.haupt === aktDatei) P.haupt = Object.keys(P.dateien).find((n) => n.endsWith(".py")) || "main.py";
    oeffneDatei(sortierteDateien()[0]); speichern(true);
    zeigePakete();
  }
};

$("hochladen").onclick = () => $("dateiWahl").click();
$("dateiWahl").onchange = async (e) => {
  for (const f of e.target.files) {
    const bytes = new Uint8Array(await f.arrayBuffer());
    P.dateien[f.name] = bytesZuInhalt(f.name, bytes);
    schreibe(`✔ ${f.name} ins Projekt übernommen (${groesse(bytes.length)})\n`, "info");
  }
  e.target.value = ""; fuelleDateien(); speichern(true); zeigePakete();
};

async function legeProjektAn(name, dateien, ziel) {
  let n = name, i = 2;
  while (projekte[n]) n = `${name} (${i++})`;
  projekte[n] = neuesProjekt(n, dateien, ziel);
  if (dateien && !("main.py" in dateien)) projekte[n].haupt = Object.keys(dateien).find((d) => d.endsWith(".py")) || "main.py";
  await DB.put(projekte[n]);
  oeffneProjekt(n);
  return projekte[n];
}

$("projNeu").onclick = async () => {
  const n = await frage("Name des neuen Projekts:", "Mein Projekt");
  if (!n) return;
  await legeProjektAn(n, { "main.py": `# ${n}\n\ndef main():\n    print("Los geht's!")\n\n\nif __name__ == "__main__":\n    main()\n`, "requirements.txt": "# Ein Paket pro Zeile, z. B.\n# requests\n" });
  zeigeTab("t-projekt");
};
$("projUmben").onclick = async () => {
  const n = await frage("Neuer Projektname:", P.name);
  if (!n || n === P.name) return;
  if (projekte[n]) return melde("Den Namen gibt es schon.");
  const alt = P.name;
  await DB.del(alt); delete projekte[alt];
  P.name = n; projekte[n] = P; await DB.put(P);
  LS.set("projekt", n); fuelleProjekte();
};
$("projLoesch").onclick = async () => {
  if (!(await bestaetige(`Projekt „${P.name}“ mit allen Dateien löschen? (Auf GitHub bleibt es erhalten.)`, "Löschen"))) return;
  await DB.del(P.name); delete projekte[P.name]; P = null;
  if (!Object.keys(projekte).length) await legeProjektAn("Mein erstes Projekt", { "main.py": BEISPIEL });
  else oeffneProjekt(Object.keys(projekte)[0]);
};

/* Ansicht auf dem Handy */
function setzeLayout(k) {
  document.body.classList.remove("nur-editor", "nur-ausgabe");
  if (k) document.body.classList.add(k);
  if (E.cm) setTimeout(() => E.cm.refresh(), 50);
}
$("layout").onclick = () => {
  const b = document.body.classList;
  setzeLayout(b.contains("nur-editor") ? "nur-ausgabe" : b.contains("nur-ausgabe") ? "" : "nur-editor");
};

/* =====================================================================
   5) Pakete
   ===================================================================== */
function anforderungen() {
  const t = P.dateien["requirements.txt"];
  if (!istText(t)) return [];
  return t.split("\n").map((z) => z.replace(/#.*/, "").trim()).filter((z) => z && !z.startsWith("-"));
}
function zeigePakete() {
  const c = $("pakete"); c.innerHTML = "";
  const l = anforderungen();
  if (!l.length) { c.innerHTML = '<span class="hinweis">Noch keine eigenen Pakete in diesem Projekt.</span>'; return; }
  l.forEach((p) => {
    const d = document.createElement("span"); d.className = "chip"; d.textContent = p;
    const x = document.createElement("button"); x.textContent = "✕"; x.title = "Aus requirements.txt entfernen";
    x.onclick = () => {
      P.dateien["requirements.txt"] = P.dateien["requirements.txt"].split("\n").filter((z) => z.replace(/#.*/, "").trim() !== p).join("\n");
      if (aktDatei === "requirements.txt") E.ersetzen(P.dateien["requirements.txt"]);
      speichern(true); zeigePakete();
    };
    d.appendChild(x); c.appendChild(d);
  });
}
function paketEintragen(name) {
  if (anforderungen().map((x) => x.toLowerCase()).includes(name.toLowerCase())) return;
  let t = istText(P.dateien["requirements.txt"]) ? P.dateien["requirements.txt"] : "";
  if (t && !t.endsWith("\n")) t += "\n";
  P.dateien["requirements.txt"] = t + name + "\n";
  if (aktDatei === "requirements.txt") E.ersetzen(P.dateien["requirements.txt"]);
  fuelleDateien(); speichern(true); zeigePakete();
}
[["numpy", "numpy"], ["pandas", "pandas"], ["matplotlib", "matplotlib.pyplot as plt"], ["scipy", "scipy"], ["sympy", "sympy"], ["scikit-learn", "sklearn"], ["pillow", "PIL"],
 ["networkx", "networkx"], ["statsmodels", "statsmodels"], ["beautifulsoup4", "bs4"], ["pyyaml", "yaml"], ["regex", "regex"], ["shapely", "shapely"], ["opencv-python", "cv2"], ["requests", "requests"]].forEach(([p, imp]) => {
  const d = document.createElement("span"); d.className = "chip vor"; d.textContent = p; d.title = "Antippen: import oben ins Skript einfügen";
  d.onclick = () => {
    if (!istText(P.dateien[aktDatei]) || !aktDatei.endsWith(".py")) return;
    const neu = `import ${imp}\n` + E.get(); E.ersetzen(neu); P.dateien[aktDatei] = neu; speichern();
  };
  $("vorPakete").appendChild(d);
});
function installieren() {
  const n = $("pakName").value.trim(); if (!n) return;
  zeigeTab("t-aus");
  if (sende({ typ: "install", name: n })) { $("pakName").value = ""; status(`installiere ${n} …`); }
}
$("pakGo").onclick = installieren;
$("pakName").addEventListener("keydown", (e) => { if (e.key === "Enter") installieren(); });
$("pakListe").onclick = () => { zeigeTab("t-aus"); sende({ typ: "liste" }); };

/* =====================================================================
   6) Python-Worker
   ===================================================================== */
const SENSOREN = [
  // name, Anzeige, Einheit, min, max, Start, Schritt
  ["temperatur", "Lufttemperatur (DHT22)", "°C", -10, 45, 21, 0.5],
  ["luftfeuchte", "Luftfeuchte (DHT22)", "%", 0, 100, 60, 1],
  ["boden1", "Bodenfeuchte 1 (MCP3008 K0)", "%", 0, 100, 45, 1],
  ["boden2", "Bodenfeuchte 2 (MCP3008 K1)", "%", 0, 100, 55, 1],
  ["wassertemp", "Wassertemperatur (DS18B20)", "°C", 0, 40, 18, 0.5],
  ["licht", "Helligkeit (MCP3008 K2)", "lux", 0, 20000, 300, 50],
  ["co2", "CO₂", "ppm", 400, 5000, 800, 10],
  ["wasserstand", "Wasserstand Tank (MCP3008 K3)", "%", 0, 100, 70, 1],
];
let sensorWerte = LS.get("sensoren", {});
let pinGedrueckt = {};
let dhtFehler = LS.get("dhtfehler", true);
let worker = null, bereit = false, laeuft = false, wartetEingabe = false;
let anfrageNr = 0; const offeneAnfragen = {};
let letzterFehler = null, letzteAusgabe = "";

function knoepfe() {
  const an = bereit && !laeuft;
  ["run", "replGo", "pakGo", "pakListe"].forEach((id) => $(id).disabled = !an);
  $("stopp").disabled = !laeuft;
  $("run").textContent = laeuft ? "…" : "▶";
}

function starteWorker() {
  if (worker) worker.terminate();
  Object.values(offeneAnfragen).forEach((a) => a.nein(new Error("Neustart")));
  bereit = false; laeuft = false; wartetEingabe = false; eingabeZeigen(false); knoepfe();
  worker = new Worker("werkstatt-worker.js");
  worker.onmessage = (ev) => verarbeite(ev.data);
  worker.onerror = (e) => schreibe("Worker-Fehler: " + (e.message || e) + "\n", "err");
  worker.postMessage({ typ: "start", sab: SAB, sensorNamen: [...SENSOREN.map((s) => s[0]), "_dhtfehler"] });
  if (LIVE) schreibeSensorenInSAB();
}

function anfrage(msg, timeout) {
  return new Promise((ok, nein) => {
    const id = ++anfrageNr; msg.id = id;
    offeneAnfragen[id] = { ok, nein };
    worker.postMessage(msg);
    setTimeout(() => { if (offeneAnfragen[id]) { delete offeneAnfragen[id]; nein(new Error("Zeitüberschreitung")); } }, timeout || 5000);
  });
}

function sende(msg) {
  if (!bereit || laeuft) return false;
  laeuft = true; knoepfe(); worker.postMessage(msg); return true;
}

function verarbeite(m) {
  switch (m.typ) {
    case "status": status(m.text, m.ok); break;
    case "out": schreibe(m.text); letzteAusgabe = (letzteAusgabe + m.text).slice(-4000); break;
    case "err": schreibe(m.text, "err"); letzteAusgabe = (letzteAusgabe + m.text).slice(-4000); break;
    case "bild": {
      const i = new Image(); i.src = "data:image/png;base64," + m.daten; aus.appendChild(i);
      setTimeout(() => aus.scrollTop = aus.scrollHeight, 60); break;
    }
    case "pi": piEreignis(m.ev); break;
    case "eingabe": eingabeZeigen(true); break;
    case "bereit":
      bereit = true; knoepfe();
      status(`Python ${m.python} bereit`, true);
      schreibe(`Python ${m.python} (Pyodide ${m.pyodide}) bereit.${m.live ? "" : " (ohne Live-Modus)"}\n`, "info");
      pruefeSpaeter();
      break;
    case "startFehler":
      status("Start fehlgeschlagen");
      schreibe("Python konnte nicht starten. Beim ersten Start braucht die App Internet (ca. 15 MB), danach geht vieles offline.\n", "err");
      schreibeKnopf("⟲ Nochmal versuchen", () => starteWorker());
      break;
    case "fertig": laufFertig(m); break;
    case "installiert":
      laeuft = false; knoepfe(); status(`${m.name} installiert`, true);
      paketEintragen(m.name);
      break;
    case "installFehler": laeuft = false; knoepfe(); status("Installation fehlgeschlagen"); break;
    case "liste": laeuft = false; knoepfe(); schreibe(m.text + "\n"); break;
    case "check": case "complete": {
      const a = offeneAnfragen[m.id]; if (a) { delete offeneAnfragen[m.id]; a.ok(m); } break;
    }
  }
}

/* --- Ausführen --- */
let laufStart = 0, laufDatei = null, stoppTimer = null;
function ausfuehren() {
  if (!bereit || laeuft || !P) return;
  speichern(true);
  let datei = aktDatei;
  if (!datei.endsWith(".py")) datei = P.haupt in P.dateien ? P.haupt : Object.keys(P.dateien).find((n) => n.endsWith(".py"));
  if (!datei) return melde("Im Projekt gibt es noch keine .py-Datei.");
  E.fehlerWeg();
  letzterFehler = null; letzteAusgabe = ""; $("mFehler").disabled = true;
  piZuruecksetzen();
  if (window.innerWidth <= 820 && document.body.classList.contains("nur-editor")) setzeLayout("");
  zeigeTab("t-aus");
  schreibe(`\n▶ ${datei}\n`, "info");
  laufStart = performance.now(); laufDatei = datei;
  sende({ typ: "run", projekt: P.name, dateien: P.dateien, datei, konsole: false, stdin: P.eingaben || "", werte: fallbackWerte() });
}
$("run").onclick = ausfuehren;

function laufFertig(m) {
  clearTimeout(stoppTimer);
  laeuft = false; wartetEingabe = false; eingabeZeigen(false); knoepfe();
  const sek = ((performance.now() - laufStart) / 1000).toFixed(1);
  // Dateien, die das Skript geschrieben oder gelöscht hat, ins Projekt übernehmen
  const a = m.aenderungen || { geaendert: {}, geloescht: [] };
  const neu = Object.keys(a.geaendert);
  if (neu.length || a.geloescht.length) {
    neu.forEach((p) => P.dateien[p] = a.geaendert[p]);
    a.geloescht.forEach((p) => delete P.dateien[p]);
    if (neu.includes(aktDatei) && istText(P.dateien[aktDatei])) E.ersetzen(P.dateien[aktDatei]);
    if (!(aktDatei in P.dateien)) oeffneDatei(sortierteDateien()[0]); else fuelleDateien();
    speichern(true);
    schreibe(`📁 ${[...neu.map((p) => "+" + p), ...a.geloescht.map((p) => "−" + p)].join(", ")}\n`, "info");
  }
  const f = m.fehler;
  if (f) {
    schreibe(f.text, "err");
    if (f.art === "KeyboardInterrupt") { status("abgebrochen"); return; }
    letzterFehler = { ...f, datei: f.datei };
    $("mFehler").disabled = false;
    if (f.datei && f.zeile) {
      if (f.datei !== aktDatei && f.datei in P.dateien) oeffneDatei(f.datei);
      if (f.datei === aktDatei) { const msg = f.text.trim().split("\n").pop(); E.fehler(f.zeile, msg); E.springe(f.zeile); }
    }
    schreibeKnopf("🧭 Mentor: Fehler erklären", () => { zeigeTab("t-mentor"); mentorFrage("fehler"); });
    status("Fehler", false);
  } else {
    status(`fertig (${sek} s)`, true);
  }
}

/* --- Stopp --- */
$("stopp").onclick = () => {
  if (!laeuft) return;
  if (LIVE) {
    intr[0] = 2;
    if (wartetEingabe) { eingabeZeigen(false); }
    status("halte an …");
    clearTimeout(stoppTimer);
    stoppTimer = setTimeout(async () => {
      if (!laeuft) return;
      if (await bestaetige("Das Skript reagiert nicht (z. B. in einer langen Rechnung). Python komplett neu starten?", "Neu starten")) {
        schreibe("\n⟲ Python wird neu gestartet …\n", "info"); starteWorker();
      }
    }, 2500);
  } else {
    schreibe("\n⏹ Abgebrochen – Python wird neu gestartet …\n", "info");
    starteWorker();
  }
};

/* --- live input() --- */
function eingabeZeigen(an) {
  wartetEingabe = an;
  $("eingabeZeile").classList.toggle("an", an);
  if (an) { zeigeTab("t-aus"); if (window.innerWidth <= 820) setzeLayout(""); setTimeout(() => $("eingabeIn").focus(), 30); status("wartet auf Eingabe …"); }
}
function eingabeSenden() {
  if (!wartetEingabe || !LIVE) return;
  const t = $("eingabeIn").value; $("eingabeIn").value = "";
  schreibe(t + "\n", "ein");
  const bytes = new TextEncoder().encode(t).slice(0, einBuf.length);
  einBuf.set(bytes); ctrl[1] = bytes.length;
  Atomics.store(ctrl, 0, 1); Atomics.notify(ctrl, 0);
  eingabeZeigen(false); status("läuft …");
}
$("eingabeGo").onclick = eingabeSenden;
$("eingabeIn").addEventListener("keydown", (e) => { if (e.key === "Enter") eingabeSenden(); });

/* --- Konsole --- */
const verlauf = LS.get("verlauf", []); let vPos = verlauf.length;
function repl() {
  const c = $("replIn").value; if (!c.trim() || !bereit || laeuft) return;
  verlauf.push(c); if (verlauf.length > 100) verlauf.shift(); vPos = verlauf.length; LS.set("verlauf", verlauf);
  schreibe(">>> " + c + "\n", "ein"); $("replIn").value = "";
  laufStart = performance.now();
  sende({ typ: "run", projekt: P.name, dateien: P.dateien, code: c, konsole: true, stdin: P.eingaben || "", werte: fallbackWerte() });
}
$("replGo").onclick = repl;
$("replIn").addEventListener("keydown", (e) => {
  if (e.key === "Enter") repl();
  if (e.key === "ArrowUp" && vPos > 0) { vPos--; $("replIn").value = verlauf[vPos]; e.preventDefault(); }
  if (e.key === "ArrowDown") { vPos = Math.min(verlauf.length, vPos + 1); $("replIn").value = verlauf[vPos] || ""; e.preventDefault(); }
});
$("leeren").onclick = () => { aus.innerHTML = ""; };

/* =====================================================================
   7) Raspberry-Pi-Simulator
   ===================================================================== */
let piPins = {};
function sensorWert(s) { return s[0] in sensorWerte ? sensorWerte[s[0]] : s[5]; }
function schreibeSensorenInSAB() {
  if (!LIVE) return;
  SENSOREN.forEach((s, i) => sensArr[i] = sensorWert(s));
  sensArr[SENSOREN.length] = dhtFehler ? 1 : 0;
  for (let p = 0; p < 32; p++) sensArr[32 + p] = pinGedrueckt[p] ? 1 : 0;
}
function fallbackWerte() {
  const o = { sensoren: {}, pins: {} };
  SENSOREN.forEach((s) => o.sensoren[s[0]] = sensorWert(s));
  o.sensoren._dhtfehler = dhtFehler ? 1 : 0;
  Object.assign(o.pins, pinGedrueckt);
  return o;
}
function reglerBauen() {
  const c = $("regler"); c.innerHTML = "";
  SENSOREN.forEach((s, i) => {
    const d = document.createElement("div"); d.className = "regler";
    const l = document.createElement("span"); l.textContent = s[1] + " ";
    const sm = document.createElement("small"); sm.textContent = `pisim.sensor("${s[0]}")`; l.appendChild(sm);
    const w = document.createElement("b");
    const r = document.createElement("input"); r.type = "range"; r.min = s[3]; r.max = s[4]; r.step = s[6]; r.value = sensorWert(s);
    const zeig = () => w.textContent = `${(+r.value).toLocaleString("de-DE")} ${s[2]}`;
    r.oninput = () => { sensorWerte[s[0]] = +r.value; zeig(); if (LIVE) sensArr[i] = +r.value; LS.set("sensoren", sensorWerte); };
    zeig();
    d.append(l, w, r); c.appendChild(d);
  });
  $("dhtFehler").checked = dhtFehler;
  $("dhtFehler").onchange = () => { dhtFehler = $("dhtFehler").checked; LS.set("dhtfehler", dhtFehler); if (LIVE) sensArr[SENSOREN.length] = dhtFehler ? 1 : 0; };
  $("piModus").textContent = LIVE ? "Regler wirken sofort – auch während das Skript läuft." : "Ohne Live-Modus werden die Werte beim Start des Skripts übernommen.";
}
function piZuruecksetzen() { piPins = {}; piDHT = {}; piRender(); }
let piDHT = {};
function piEreignis(ev) {
  if (ev.art === "reset") { piPins = {}; piDHT = {}; }
  else if (ev.art === "setup") { piPins[ev.pin] = { modus: ev.modus, name: ev.name || piPins[ev.pin]?.name || "", wert: 0, pull: ev.pull }; }
  else if (ev.art === "out") { (piPins[ev.pin] = piPins[ev.pin] || { modus: "out", name: "" }).wert = ev.wert; }
  else if (ev.art === "name") { (piPins[ev.pin] = piPins[ev.pin] || { modus: "out", wert: 0 }).name = ev.name; }
  else if (ev.art === "dht") {
    const d = piDHT[ev.pin] = piDHT[ev.pin] || { pin: ev.pin };
    if (ev.fehler) d.err = true; else if (ev.t !== undefined) { d.err = false; d.t = ev.t; d.h = ev.h; }
  }
  piRender();
}
// Gleiche Namen und Symbole wie im Codekoje-Simulator
const OUT_LABEL = { 17: "Licht", 27: "Lüfter", 22: "Pumpe", 23: "Vernebler", 24: "Heizung", 18: "Licht 2", 25: "Lüfter 2" };
const HW_ICON = {
  Licht: '<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2V16h5v-.1c0-.8.4-1.5 1-2A6 6 0 0 0 12 3z"/>',
  Lüfter: '<circle cx="12" cy="12" r="2"/><path d="M12 10c0-4 1-7 4-7 2 0 3 2 1 4l-3 3M14 12c4 0 7 1 7 4 0 2-2 3-4 1l-3-3M12 14c0 4-1 7-4 7-2 0-3-2-1-4l3-3M10 12c-4 0-7-1-7-4 0-2 2-3 4-1l3 3"/>',
  Pumpe: '<path d="M12 3s6 7 6 11a6 6 0 0 1-12 0c0-4 6-11 6-11z"/>',
  Vernebler: '<path d="M4 10h11a3 3 0 1 0-3-3M4 14h14a3 3 0 1 1-3 3M4 18h6"/>',
  Heizung: '<path d="M8 21c0-4 4-5 4-9 0-2-1-4-1-4s5 2 5 8a4 4 0 0 1-8 5z"/>',
  Relais: '<rect x="4" y="7" width="16" height="10" rx="2"/><path d="M8 12h8"/>',
  Sensor: '<path d="M14 14.8V5a2 2 0 0 0-4 0v9.8a4 4 0 1 0 4 0z"/>',
  Knopf: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3.5"/>',
  Motor: '<circle cx="12" cy="12" r="8"/><path d="M12 4v4M12 16v4M4 12h4M16 12h4"/>',
};
function iconFuer(name, modus) {
  if (modus === "in") return HW_ICON.Knopf;
  const n = (name || "").toLowerCase();
  if (/licht|led|lampe|light/.test(n)) return HW_ICON.Licht;
  if (/lüfter|luefter|fan|ventil/.test(n)) return HW_ICON["Lüfter"];
  if (/pumpe|wasser|pump/.test(n)) return HW_ICON.Pumpe;
  if (/nebel|vernebler|befeucht/.test(n)) return HW_ICON.Vernebler;
  if (/heiz|wärme/.test(n)) return HW_ICON.Heizung;
  if (/motor/.test(n)) return HW_ICON.Motor;
  return HW_ICON.Relais;
}
const svgEsc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
function kachel(klassen, icon, titel, unter, wert) {
  const d = document.createElement("div"); d.className = "tile " + klassen;
  d.innerHTML = `<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icon}</svg><div><b>${svgEsc(titel)}</b><span>${svgEsc(unter)}</span></div><em>${svgEsc(wert)}</em>`;
  return d;
}
let piRenderGeplant = false;
function piRender() {
  if (piRenderGeplant) return; piRenderGeplant = true;
  requestAnimationFrame(() => {
    piRenderGeplant = false;
    const c = $("pins"); c.innerHTML = "";
    const pins = Object.keys(piPins).map(Number).sort((a, b) => a - b);
    const dhts = Object.values(piDHT);
    $("piLeer").style.display = pins.length || dhts.length ? "none" : "";
    dhts.forEach((d) => c.appendChild(kachel("dht" + (d.err ? " err" : ""), HW_ICON.Sensor, "DHT22", "GPIO " + d.pin,
      d.err ? "Messfehler" : d.t == null ? "bereit" : `${d.t.toLocaleString("de-DE")} °C · ${Math.round(d.h)} %`)));
    pins.forEach((pin) => {
      const p = piPins[pin];
      if (p.modus === "in") {
        const an = !!pinGedrueckt[pin];
        const k = kachel("knopf" + (an ? " on" : ""), HW_ICON.Knopf, p.name || "Eingang", `GPIO ${pin} · antippen`, an ? "GEDRÜCKT" : "frei");
        k.setAttribute("role", "button"); k.tabIndex = 0;
        const um = () => { pinGedrueckt[pin] = !pinGedrueckt[pin]; if (LIVE) sensArr[32 + pin] = pinGedrueckt[pin] ? 1 : 0; piRender(); };
        k.onclick = um; k.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); um(); } };
        c.appendChild(k);
      } else {
        const an = p.wert > 0;
        const name = p.name && !/^(OutputDevice|DigitalOutputDevice|LED|PWMOutputDevice|PWMLED|Buzzer)$/.test(p.name) ? p.name : (OUT_LABEL[pin] || p.name || "Relais");
        const wert = p.modus === "pwm" ? Math.round(p.wert * 100) + " %" : (an ? "AN" : "AUS");
        c.appendChild(kachel((an ? "on" : "") + (an && /lüfter|luefter|fan/i.test(name) ? " spin" : ""), iconFuer(name, p.modus), name, `GPIO ${pin}${p.modus === "pwm" ? " · PWM" : ""}`, wert));
      }
    });
  });
}

const KELLERFARM = {
  "main.py": `# Kellerfarm – Steuerung (läuft im Pi-Simulator und später unverändert auf dem Raspberry Pi)
import time
from gpiozero import OutputDevice, Button, MCP3008
import adafruit_dht
import board
import pisim  # nur für Anzeigenamen im Simulator – auf dem echten Pi diese Zeile entfernen

from einstellungen import ZONEN, LICHT_AN, LICHT_AUS, TAKT_SEKUNDEN

# --- Hardware ---
dht = adafruit_dht.DHT22(board.D4)
licht = OutputDevice(17, active_high=False, name="Licht (Relais)")
luefter = OutputDevice(27, active_high=False, name="Lüfter")
not_aus = Button(5, name="Not-Aus")

pumpen = {}
fuehler = {}
for zone in ZONEN:
    pumpen[zone["name"]] = OutputDevice(zone["pumpe"], active_high=False, name="Pumpe " + zone["name"])
    fuehler[zone["name"]] = MCP3008(channel=zone["kanal"])


def licht_sollte_an_sein(stunde):
    return LICHT_AN <= stunde < LICHT_AUS


def ein_durchgang(stunde):
    temperatur = dht.temperature
    feuchte = dht.humidity
    print(f"🌡 {temperatur:.1f} °C   💧 Luft {feuchte:.0f} %")

    # Licht nach Uhrzeit
    if licht_sollte_an_sein(stunde):
        licht.on()
    else:
        licht.off()

    # Lüfter bei Hitze oder zu feuchter Luft
    if temperatur > 26 or feuchte > 85:
        luefter.on()
    else:
        luefter.off()

    # Gießen je Zone
    for zone in ZONEN:
        boden = fuehler[zone["name"]].value * 100
        pumpe = pumpen[zone["name"]]
        if boden < zone["min_feuchte"]:
            pumpe.on()
            print(f"  🚿 {zone['name']}: Boden {boden:.0f} % → gießen")
        else:
            pumpe.off()


# Simulierte Uhr: jeder Durchgang = 1 Stunde
stunde = 6
while not not_aus.is_pressed:
    print(f"\\n🕐 {stunde:02d}:00 Uhr")
    ein_durchgang(stunde)
    stunde = (stunde + 1) % 24
    time.sleep(TAKT_SEKUNDEN)

print("⛔ Not-Aus gedrückt – alles aus.")
for p in pumpen.values():
    p.off()
licht.off()
luefter.off()
`,
  "einstellungen.py": `# Einstellungen der Kellerfarm

LICHT_AN = 6     # Uhr
LICHT_AUS = 22   # Uhr
TAKT_SEKUNDEN = 2  # Simulator: 2 Sekunden = 1 Stunde

ZONEN = [
    {"name": "Kräuter", "pumpe": 22, "kanal": 0, "min_feuchte": 40},
    {"name": "Microgreens", "pumpe": 23, "kanal": 1, "min_feuchte": 55},
]
`,
  "requirements.txt": "# Auf dem echten Pi: pip install gpiozero adafruit-circuitpython-dht\n# In der Werkstatt werden diese Bauteile simuliert.\n",
};
$("piBeispiel").onclick = async () => {
  await legeProjektAn("Kellerfarm", JSON.parse(JSON.stringify(KELLERFARM)), "Modulare Indoor-Farm im Keller: Licht nach Zeitplan, Lüfter bei Hitze/Feuchte, Pumpen je Zone nach Bodenfeuchte. Später auf dem Raspberry Pi laufen lassen.");
  zeigeTab("t-pi");
  schreibe("🌱 Kellerfarm-Projekt angelegt. ▶ drücken, dann im Pi-Tab mit den Reglern spielen. „Not-Aus“ beendet das Programm.\n", "info");
};

/* =====================================================================
   8) Mentor (Gemini)
   ===================================================================== */
// KI-Einstellungen und Lernstand kommen aus der Codekoje (gleicher Browser-Speicher)
function codekojeKI() {
  try {
    const ai = JSON.parse(localStorage.getItem("codekoje.ai") || "null") || {};
    return { key: ai.key || "", model: ai.model || "gemini-3.8-flash" };
  } catch (e) { return { key: "", model: "gemini-3.8-flash" }; }
}
function codekojeNiveau() {
  try {
    const pr = JSON.parse(localStorage.getItem("codekoje.profiles") || "null");
    const cur = (pr && pr.cur) || "main";
    const st = JSON.parse(localStorage.getItem(cur === "main" ? "codekoje.v1" : "codekoje.v1:" + cur) || "{}");
    const sk = st.skill || {};
    const t = Object.keys(sk);
    const lektionen = Object.keys(st.done || {}).length;
    return `${lektionen} Lektionen im Lernpfad geschafft; Fähigkeiten (0–100): ${t.length ? t.map((k) => k + " " + sk[k].s).join(", ") : "noch keine Werte"}`;
  } catch (e) { return ""; }
}
const MENTOR_SYSTEM = `Du bist der Programmier-Mentor in der "Werkstatt" der Lern-App Codekoje. In der Werkstatt läuft echtes Python 3 (Pyodide) im Browser – mit Projekten aus mehreren Dateien, PyPI-Paketen und GitHub-Abgleich.
Du begleitest Micha – Physiotherapeut, Programmier-Anfänger, lernt Python für eigene Projekte (z. B. eine Raspberry-Pi-gesteuerte Indoor-Farm im Keller).

So arbeitest du:
- Antworte immer auf Deutsch, locker, kurz und klar (er liest meist am Handy). Lieber 3 gute Sätze als eine Seite.
- Du leitest an, statt fertige Lösungen zu schreiben. Gib Hinweise, stelle Rückfragen, zeige kleine Beispiele mit ANDEREN Namen/Werten, damit er es selbst überträgt. Komplette Lösungen nur, wenn er ausdrücklich darum bittet.
- Erkläre jedes neue Konzept, bevor du es benutzt. Setze nichts voraus, was er noch nicht kennen kann.
- Bei Fehlern: 1) was die Meldung auf Deutsch bedeutet, 2) in welcher Zeile/warum, 3) wie er es selbst findet und behebt. Gib die Lösung nicht direkt vor.
- Beziehe dich auf sein Projektziel und den gezeigten Code.
- Technische Grenzen kennen: Pakete mit C-Code ohne WebAssembly-Version gehen hier nicht; keine echten Threads, keine Fenster (tkinter/pygame). requests nur zu Seiten mit CORS.
- In der Werkstatt gibt es einen Pi-Simulator: RPi.GPIO, gpiozero (LED, Button, OutputDevice, PWMLED, Motor, MCP3008), adafruit_dht, w1thermsensor, board sowie pisim.sensor("temperatur"/"luftfeuchte"/"boden1"/"boden2"/"wassertemp"/"licht"/"co2"/"wasserstand") und pisim.name(pin, "Text"). Der Code läuft später unverändert auf dem echten Pi (außer pisim-Zeilen).
- Pakete installiert er im Projekt-Tab oder per requirements.txt.
- Passe Erklärtiefe an seinen Lernstand an (steht im Kontext). Er hat den Codekoje-Lernpfad (Grundlagen + Kellerfarm) teils schon gemacht.
- Sicherheit: 230 V nur durch Elektrofachkraft, Aktoren im finally abschalten, Pumpe zeitlich begrenzen.
- Code-Beispiele in \`\`\`python … \`\`\` Blöcken.`;

function mentorKontext() {
  const dateien = Object.keys(P.dateien).map((n) => istText(P.dateien[n]) ? `${n} (${P.dateien[n].split("\n").length} Zeilen)` : `${n} (Binärdatei)`).join(", ");
  const niveau = codekojeNiveau();
  let s = (niveau ? `[Lernstand: ${niveau}]\n` : "") + `[Projekt: "${P.name}"]\n[Ziel: ${P.ziel || "noch nicht festgelegt"}]\n[Dateien: ${dateien}]\n`;
  if (istText(P.dateien[aktDatei])) s += `[Offene Datei: ${aktDatei}]\n\`\`\`python\n${P.dateien[aktDatei].slice(0, 12000)}\n\`\`\`\n`;
  // andere kleine .py-Dateien mitschicken
  let rest = 8000;
  for (const [n, v] of Object.entries(P.dateien)) {
    if (n === aktDatei || !n.endsWith(".py") || !istText(v) || v.length > rest) continue;
    s += `[Datei ${n}]\n\`\`\`python\n${v}\n\`\`\`\n`; rest -= v.length;
  }
  if (letzteAusgabe) s += `[Letzte Ausgabe]\n\`\`\`\n${letzteAusgabe.slice(-2500)}\n\`\`\`\n`;
  return s;
}

const MENTOR_VORLAGEN = {
  fehler: () => letzterFehler ? `Erklär mir bitte diesen Fehler, ohne mir gleich die Lösung zu verraten:\n${letzterFehler.text.slice(-1500)}` : null,
  code: () => `Erklär mir bitte Schritt für Schritt, was der Code in ${aktDatei} macht.`,
  weiter: () => `Was wäre ein sinnvoller nächster kleiner Schritt für mein Projekt? Bitte nur den Schritt beschreiben und was ich dafür lernen muss.`,
  tipp: () => `Ich komme nicht weiter. Gib mir bitte einen Tipp in die richtige Richtung – aber keine fertige Lösung.`,
};

let mentorLaeuft = false;
async function mentorFrage(artOderText) {
  if (mentorLaeuft || !P) return;
  const text = MENTOR_VORLAGEN[artOderText] ? MENTOR_VORLAGEN[artOderText]() : artOderText;
  if (!text) return;
  const ki = codekojeKI();
  if (!ki.key) {
    const w = await dialog("Für den Mentor brauchst du deinen Gemini-Schlüssel in der Codekoje (Zahnrad oben rechts). Danach funktioniert er hier automatisch.", { knoepfe: [["Später", false], ["Zu den Einstellungen", true, "btn small"]] });
    if (w) location.href = "index.html#einstellungen";
    return;
  }
  P.mentor.push({ r: "user", t: text });
  mentorLaeuft = true; mentorRender(true);
  const verlaufKurz = P.mentor.slice(-16);
  const contents = verlaufKurz.map((x, i) => ({
    role: x.r === "user" ? "user" : "model",
    parts: [{ text: i === verlaufKurz.length - 1 ? mentorKontext() + "\n" + x.t : x.t }],
  }));
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(ki.model)}:generateContent`, {
      method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": ki.key },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: MENTOR_SYSTEM }] }, contents, generationConfig: { temperature: 0.6, maxOutputTokens: 4096 } }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error ? d.error.message : "HTTP " + r.status);
    const antwort = (d.candidates?.[0]?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || "").join("").trim() || "(keine Antwort)";
    P.mentor.push({ r: "model", t: antwort });
  } catch (e) {
    P.mentor.push({ r: "model", t: "⚠️ Mentor nicht erreichbar: " + e.message });
  }
  if (P.mentor.length > 60) P.mentor = P.mentor.slice(-60);
  mentorLaeuft = false; speichern(true); mentorRender();
}

function md(text) {
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const teile = text.split(/```(\w*)\n?([\s\S]*?)```/g);
  let html = "";
  for (let i = 0; i < teile.length; i++) {
    if (i % 3 === 0) {
      let t = esc(teile[i]);
      t = t.replace(/`([^`\n]+)`/g, "<code>$1</code>").replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
        .replace(/^#{1,4}\s*(.+)$/gm, "<b>$1</b>").replace(/^\s*[-*]\s+/gm, "• ")
        .replace(/\n/g, "<br>");
      html += t;
    } else if (i % 3 === 2) {
      html += `<pre><button type="button" data-kopie>Kopieren</button><code>${esc(teile[i].replace(/\n$/, ""))}</code></pre>`;
    }
  }
  return html;
}

function mentorRender(denkt) {
  if (!P) return;
  const c = $("chat"); c.innerHTML = "";
  if (!P.mentor.length) {
    const b = document.createElement("div"); b.className = "msg ai";
    b.innerHTML = '<div class="who">Mentor</div>' + md(`Moin! Ich bin dein Mentor für **${P.name}**. Ich sehe deinen Code, deine Fehlermeldungen und dein Projektziel.\n\nIch schreibe dir nicht alles vor, sondern zeige dir den Weg. Frag einfach – oder nimm einen der Knöpfe unten.`);
    c.appendChild(b);
  }
  P.mentor.forEach((x) => {
    const b = document.createElement("div"); b.className = "msg " + (x.r === "user" ? "me" : "ai");
    const who = document.createElement("div"); who.className = "who"; who.textContent = x.r === "user" ? "Du" : "Mentor";
    if (x.r === "user") { b.appendChild(who); b.appendChild(document.createTextNode(x.t.length > 600 ? x.t.slice(0, 600) + " …" : x.t)); }
    else b.innerHTML = '<div class="who">Mentor</div>' + md(x.t);
    c.appendChild(b);
  });
  if (denkt || mentorLaeuft) { const b = document.createElement("div"); b.className = "msg ai denkt"; b.textContent = "Denkt nach …"; c.appendChild(b); }
  c.querySelectorAll("[data-kopie]").forEach((b) => b.onclick = async () => {
    try { await navigator.clipboard.writeText(b.nextSibling.textContent); b.textContent = "✔"; } catch (e) { b.textContent = "✘"; }
    setTimeout(() => b.textContent = "Kopieren", 1200);
  });
  c.scrollTop = c.scrollHeight;
}
document.querySelectorAll(".ladder button").forEach((b) => b.onclick = async () => {
  if (b.dataset.m === "leeren") { if (await bestaetige("Gespräch mit dem Mentor leeren?")) { P.mentor = []; speichern(true); mentorRender(); } return; }
  mentorFrage(b.dataset.m);
});
function mentorSenden() { const t = $("mentorIn").value.trim(); if (!t) return; $("mentorIn").value = ""; mentorFrage(t); }
$("mentorGo").onclick = mentorSenden;
$("mentorIn").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && window.innerWidth > 820) { e.preventDefault(); mentorSenden(); } });

/* =====================================================================
   9) GitHub-Abgleich
   ===================================================================== */
async function gh(pfad, opt = {}) {
  const token = LS.get("token", "");
  if (!token) throw Object.assign(new Error("Kein GitHub-Zugangsschlüssel eingetragen (⚙ Einstellungen)."), { status: 0 });
  const r = await fetch("https://api.github.com" + pfad, {
    method: opt.method || "GET",
    headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", ...(opt.body ? { "Content-Type": "application/json" } : {}) },
    body: opt.body ? JSON.stringify(opt.body) : undefined,
    cache: "no-store",
  });
  if (r.status === 204) return null;
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(`${d.message || "Fehler"} (${r.status})`), { status: r.status });
  return d;
}
function ghStandZeigen() {
  const g = P.github;
  $("ghStand").textContent = g.zeit ? `Zuletzt abgeglichen: ${new Date(g.zeit).toLocaleString("de-DE")} (${(g.sha || "").slice(0, 7)})` : "";
}
function ghEinstellungenLesen() {
  P.github.repo = $("ghRepo").value.trim().replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "").replace(/\/$/, "");
  P.github.branch = $("ghBranch").value.trim();
  $("ghRepo").value = P.github.repo;
  speichern();
  if (!/^[\w.-]+\/[\w.-]+$/.test(P.github.repo)) throw new Error("Bitte Repo als „Nutzer/Name“ eintragen, z. B. Feuerfuchs89/Kellerfarm.");
  return P.github.repo;
}
$("ghRepo").onchange = $("ghBranch").onchange = () => { try { ghEinstellungenLesen(); } catch (e) { } };

async function pool(liste, n, fn) {
  const erg = new Array(liste.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, liste.length) }, async () => { while (i < liste.length) { const j = i++; erg[j] = await fn(liste[j], j); } }));
  return erg;
}

async function ghPush() {
  let repo;
  try { repo = ghEinstellungenLesen(); } catch (e) { return melde(e.message); }
  const knopf = $("ghPush"); knopf.disabled = true;
  try {
    status("GitHub: prüfe Repo …");
    let info;
    try { info = await gh(`/repos/${repo}`); }
    catch (e) {
      if (e.status !== 404) throw e;
      if (!(await bestaetige(`Das Repo „${repo}“ gibt es noch nicht (oder der Schlüssel darf es nicht sehen). Neu anlegen als privates Repo?`, "Anlegen"))) return;
      const [besitzer, name] = repo.split("/");
      const ich = await gh("/user");
      if (ich.login.toLowerCase() !== besitzer.toLowerCase()) throw new Error(`Neue Repos kann ich nur unter deinem Namen (${ich.login}) anlegen.`);
      await gh("/user/repos", { method: "POST", body: { name, private: true, auto_init: true, description: "Codekoje-Werkstatt: " + P.name } });
      info = await gh(`/repos/${repo}`);
    }
    const branch = P.github.branch || info.default_branch || "main";
    let eltern = null;
    try { eltern = (await gh(`/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`)).object.sha; }
    catch (e) { if (e.status !== 404 && e.status !== 409) throw e; }
    if (!eltern && info.size === 0) {
      // Leeres Repo: ein erster Commit über die Contents-API, sonst geht die Git-API nicht
      await gh(`/repos/${repo}/contents/README.md`, { method: "PUT", body: { message: "Start", content: btoa("# " + P.name + "\n"), branch } });
      eltern = (await gh(`/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`)).object.sha;
    }
    if (eltern && P.github.sha && eltern !== P.github.sha) {
      if (!(await bestaetige("Auf GitHub gibt es neuere Änderungen (z. B. von einem anderen Gerät). Trotzdem deinen Stand hochladen und diese überschreiben? Sonst erst ⬇ Holen.", "Überschreiben"))) return;
    } else if (eltern && !P.github.sha) {
      if (!(await bestaetige(`Das Repo „${repo}“ hat schon Inhalt. Mit deinem Projekt ersetzen? (Alte Stände bleiben in der GitHub-Historie.)`, "Ersetzen"))) return;
    }
    const nachricht = await frage("Was hast du geändert? (Commit-Nachricht)", "Werkstatt: " + new Date().toLocaleString("de-DE"));
    if (nachricht === null) return;
    status("GitHub: lade hoch …");
    const meta = { ziel: P.ziel, haupt: P.haupt, pykoje: 2 };
    const alle = Object.entries(P.dateien).concat([[".pykoje.json", JSON.stringify(meta, null, 2) + "\n"]]);
    const eintraege = await pool(alle, 4, async ([pfad, inhalt]) => {
      if (istText(inhalt)) return { path: pfad, mode: "100644", type: "blob", content: inhalt };
      const b = await gh(`/repos/${repo}/git/blobs`, { method: "POST", body: { content: bytesZuB64(inhalt), encoding: "base64" } });
      return { path: pfad, mode: "100644", type: "blob", sha: b.sha };
    });
    const baum = await gh(`/repos/${repo}/git/trees`, { method: "POST", body: { tree: eintraege } });
    const commit = await gh(`/repos/${repo}/git/commits`, { method: "POST", body: { message: nachricht || "Werkstatt", tree: baum.sha, parents: eltern ? [eltern] : [] } });
    if (eltern) await gh(`/repos/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, { method: "PATCH", body: { sha: commit.sha, force: true } });
    else await gh(`/repos/${repo}/git/refs`, { method: "POST", body: { ref: "refs/heads/" + branch, sha: commit.sha } });
    P.github.sha = commit.sha; P.github.zeit = Date.now(); speichern(true); ghStandZeigen();
    status("GitHub: hochgeladen ✔", true);
    schreibe(`⬆ ${Object.keys(P.dateien).length} Dateien nach github.com/${repo} (${branch}) hochgeladen.\n`, "info");
  } catch (e) {
    status("GitHub-Fehler"); melde("GitHub: " + e.message);
  } finally { knopf.disabled = false; }
}

async function ghHolen(repo, branch) {
  const info = await gh(`/repos/${repo}`);
  branch = branch || info.default_branch || "main";
  const ref = await gh(`/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`);
  const commit = await gh(`/repos/${repo}/git/commits/${ref.object.sha}`);
  const baum = await gh(`/repos/${repo}/git/trees/${commit.tree.sha}?recursive=1`);
  const blobs = baum.tree.filter((t) => t.type === "blob" && t.size <= 20 * 1024 * 1024).slice(0, 400);
  let n = 0;
  const dateien = {}; let meta = null;
  await pool(blobs, 6, async (t) => {
    const b = await gh(`/repos/${repo}/git/blobs/${t.sha}`);
    const inhalt = bytesZuInhalt(t.path, b64ZuBytes(b.content));
    if (t.path === ".pykoje.json") { try { meta = JSON.parse(inhalt); } catch (e) { } }
    else dateien[t.path] = inhalt;
    status(`GitHub: hole Dateien … ${++n}/${blobs.length}`);
  });
  return { dateien, meta, sha: ref.object.sha, branch };
}

async function ghPull() {
  let repo;
  try { repo = ghEinstellungenLesen(); } catch (e) { return melde(e.message); }
  if (!(await bestaetige(`Stand von github.com/${repo} holen? Deine lokalen Dateien in „${P.name}“ werden dadurch ersetzt.`, "Holen"))) return;
  const knopf = $("ghPull"); knopf.disabled = true;
  try {
    status("GitHub: hole …");
    const r = await ghHolen(repo, P.github.branch);
    P.dateien = r.dateien;
    if (r.meta) { if (r.meta.ziel !== undefined) P.ziel = r.meta.ziel; if (r.meta.haupt) P.haupt = r.meta.haupt; }
    if (!(P.haupt in P.dateien)) P.haupt = Object.keys(P.dateien).find((x) => x.endsWith(".py")) || "main.py";
    P.github.sha = r.sha; P.github.zeit = Date.now();
    speichern(true);
    const name = P.name; P = null; oeffneProjekt(name);
    status("GitHub: geholt ✔", true);
    schreibe(`⬇ ${Object.keys(r.dateien).length} Dateien von github.com/${repo} geholt.\n`, "info");
  } catch (e) { status("GitHub-Fehler"); melde("GitHub: " + e.message); }
  finally { knopf.disabled = false; }
}
$("ghPush").onclick = ghPush;
$("ghPull").onclick = ghPull;
$("projKlonen").onclick = async () => {
  let repo = await frage("Welches GitHub-Repo? (Nutzer/Name)", "Feuerfuchs89/");
  if (!repo) return;
  repo = repo.replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "").replace(/\/$/, "");
  try {
    status("GitHub: hole …");
    const r = await ghHolen(repo, "");
    const p = await legeProjektAn(repo.split("/")[1], r.dateien, r.meta?.ziel);
    if (r.meta?.haupt && r.meta.haupt in p.dateien) p.haupt = r.meta.haupt;
    p.github = { repo, branch: r.branch, sha: r.sha, zeit: Date.now() };
    await DB.put(p); const n = p.name; P = null; oeffneProjekt(n);
    status("GitHub: geholt ✔", true);
  } catch (e) { status("GitHub-Fehler"); melde("GitHub: " + e.message); }
};

/* =====================================================================
   10) ZIP
   ===================================================================== */
$("zipExport").onclick = async () => {
  if (!window.JSZip) return melde("ZIP-Funktion nicht geladen (offline?).");
  const z = new JSZip();
  for (const [p, v] of Object.entries(P.dateien)) z.file(p, v);
  z.file(".pykoje.json", JSON.stringify({ ziel: P.ziel, haupt: P.haupt, pykoje: 2 }, null, 2));
  herunterladen(P.name.replace(/[^\w\-äöüÄÖÜß ]/g, "_") + ".zip", await z.generateAsync({ type: "blob", compression: "DEFLATE" }));
};
$("zipImport").onclick = () => $("zipWahl").click();
$("zipWahl").onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = ""; if (!f) return;
  if (!window.JSZip) return melde("ZIP-Funktion nicht geladen (offline?).");
  try {
    const z = await JSZip.loadAsync(f);
    const eintraege = Object.values(z.files).filter((x) => !x.dir && !x.name.startsWith("__MACOSX") && !x.name.includes("/__pycache__/"));
    // gemeinsamen Oberordner entfernen
    const ersterOrdner = eintraege.length && eintraege.every((x) => x.name.includes("/") && x.name.split("/")[0] === eintraege[0].name.split("/")[0]) ? eintraege[0].name.split("/")[0] + "/" : "";
    const dateien = {}; let meta = null;
    for (const x of eintraege) {
      const pfad = x.name.slice(ersterOrdner.length);
      const inhalt = bytesZuInhalt(pfad, await x.async("uint8array"));
      if (pfad === ".pykoje.json") { try { meta = JSON.parse(inhalt); } catch (er) { } } else dateien[pfad] = inhalt;
    }
    const p = await legeProjektAn(f.name.replace(/\.zip$/i, ""), dateien, meta?.ziel);
    if (meta?.haupt && meta.haupt in p.dateien) { p.haupt = meta.haupt; await DB.put(p); fuelleDateien(); }
    schreibe(`📥 ${Object.keys(dateien).length} Dateien aus ${f.name} als Projekt geöffnet.\n`, "info");
  } catch (er) { melde("ZIP konnte nicht gelesen werden: " + er.message); }
};

/* =====================================================================
   11) Einstellungen
   ===================================================================== */
function einstOeffnen() {
  $("eToken").value = LS.get("token", "");
  const ki = codekojeKI();
  $("eKI").innerHTML = ki.key
    ? `✔ Nutzt deinen Gemini-Schlüssel aus der Codekoje (Modell <code>${svgEsc(ki.model)}</code>). Ändern: <a href="index.html#einstellungen">Codekoje-Einstellungen</a>.`
    : `Noch kein Gemini-Schlüssel. Trag ihn in den <a href="index.html#einstellungen">Codekoje-Einstellungen</a> ein – er gilt dann auch hier.`;
  $("eSchrift").value = String(LS.get("schrift", 14));
  $("eInfo").innerHTML = LIVE
    ? "✔ Live-Modus aktiv: <code>input()</code> fragt direkt nach, ■ hält Skripte ohne Neustart an, Pi-Regler wirken sofort."
    : "Live-Modus nicht verfügbar (Seite wird nicht über den Service Worker geladen oder Browser zu alt). <code>input()</code>-Antworten dann im Projekt-Tab vorab eintragen.";
  $("einstellungen").classList.add("an");
}
$("einst").onclick = einstOeffnen;
$("eOk").onclick = () => {
  LS.set("token", $("eToken").value.trim());
  LS.set("schrift", +$("eSchrift").value);
  schriftSetzen();
  $("einstellungen").classList.remove("an");
};
$("eNeustart").onclick = () => { $("einstellungen").classList.remove("an"); schreibe("\n⟲ Python wird neu gestartet …\n", "info"); starteWorker(); };
$("einstellungen").onclick = (e) => { if (e.target.id === "einstellungen") $("einstellungen").classList.remove("an"); };
function schriftSetzen() { document.documentElement.style.setProperty("--ed", LS.get("schrift", 14) + "px"); if (E.cm) E.cm.refresh(); }

/* =====================================================================
   12) Codekoje-Anbindung: Code von dort übernehmen
   ===================================================================== */
async function codekojeImport() {
  let daten = LS.get("import", null);
  if (daten) LS.del("import");
  if (!daten && location.hash.startsWith("#code")) {
    try {
      const b64 = location.hash.slice(location.hash.indexOf("=") + 1);
      daten = JSON.parse(new TextDecoder().decode(b64ZuBytes(b64.replace(/-/g, "+").replace(/_/g, "/"))));
    } catch (e) { }
  }
  if (location.hash) history.replaceState(null, "", location.pathname + location.search);
  if (!daten || !daten.code) return false;
  const projName = daten.projekt || "Codekoje-Übungen";
  let datei = (daten.name || "uebung.py").replace(/[^\w\-.äöüÄÖÜß]/g, "_");
  if (!datei.endsWith(".py")) datei += ".py";
  if (!projekte[projName]) await legeProjektAn(projName, {}, daten.ziel || "Übungen aus der Codekoje ausprobieren und erweitern");
  else oeffneProjekt(projName);
  if (datei in P.dateien && P.dateien[datei] !== daten.code) {
    let i = 2; const basis = datei.replace(/\.py$/, ""); while (`${basis}_${i}.py` in P.dateien) i++; datei = `${basis}_${i}.py`;
  }
  P.dateien[datei] = daten.code;
  if (daten.ziel && !P.ziel) P.ziel = daten.ziel;
  if (P.dateien["main.py"] === "" && datei !== "main.py") delete P.dateien["main.py"]; // leere Vorlage weg
  P.haupt = P.haupt in P.dateien ? P.haupt : datei;
  await DB.put(P);
  oeffneDatei(datei);
  schreibe(`📚 Aus der Codekoje übernommen: ${datei}\n`, "info");
  return true;
}

/* =====================================================================
   13) Start
   ===================================================================== */
const BEISPIEL = `# Willkommen in der Werkstatt der Codekoje!
# Hier läuft echtes Python: mehrere Dateien, Pakete wie numpy, GitHub-Abgleich.
# ▶ Ausführen (oder Strg+Enter). Tipp: input() fragt direkt in der Ausgabe nach.

import numpy as np
import matplotlib.pyplot as plt

name = input("Wie heißt du? ")
print(f"Moin {name}! Python läuft.")

# kleine Welle am Cospudener See 🌊
x = np.linspace(0, 4 * np.pi, 200)
plt.plot(x, np.sin(x) * np.exp(-x / 8))
plt.title("Gedämpfte Welle")
plt.show()
`;

async function los() {
  if (await serviceWorkerKlaeren()) return; // Seite lädt neu
  $("live").textContent = LIVE ? "live" : "einfach";
  $("live").classList.toggle("an", LIVE);
  $("live").onclick = einstOeffnen;
  if (LIVE) $("eingabenKarte").hidden = true;
  else $("eingabenText").textContent = "Ohne Live-Modus: Jede Zeile ist eine Antwort auf ein input() – der Reihe nach.";
  schriftSetzen();
  reglerBauen();

  await DB.open();
  (await DB.alle()).forEach((p) => {
    p.github = p.github || { repo: "", branch: "", sha: null, zeit: null };
    p.mentor = p.mentor || []; projekte[p.name] = p;
  });

  // Übernahme aus der allerersten Pykoje (Einzelskripte)
  const alt = LS.get("skripte", null);
  if (alt && !projekte["Meine Skripte"]) {
    projekte["Meine Skripte"] = neuesProjekt("Meine Skripte", alt);
    projekte["Meine Skripte"].haupt = Object.keys(alt)[0];
    const altPakete = LS.get("pakete", []);
    if (altPakete.length) projekte["Meine Skripte"].dateien["requirements.txt"] = altPakete.join("\n") + "\n";
    await DB.put(projekte["Meine Skripte"]);
    LS.del("skripte"); LS.del("pakete");
  }
  if (!Object.keys(projekte).length) {
    projekte["Mein erstes Projekt"] = neuesProjekt("Mein erstes Projekt", { "main.py": BEISPIEL });
    await DB.put(projekte["Mein erstes Projekt"]);
  }
  const letztes = LS.get("projekt", null);
  oeffneProjekt(projekte[letztes] ? letztes : Object.keys(projekte)[0]);
  await codekojeImport();
  window.addEventListener("hashchange", codekojeImport);
  window.addEventListener("storage", (e) => { if (e.key === "pykoje:import" && e.newValue) codekojeImport(); });

  starteWorker();
  window.addEventListener("beforeunload", () => { if (P) { P.offen = aktDatei; DB.put(P); } });
  document.addEventListener("visibilitychange", () => { if (document.hidden) speichern(true); });
}
los();

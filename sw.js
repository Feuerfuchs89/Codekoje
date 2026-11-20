// Codekoje Service Worker – macht die App offline nutzbar (Version w2-20261120)
// Die Werkstatt bekommt zusätzlich "Cross-Origin-Isolation": Damit fragt input() live nach
// und der Stopp-Knopf hält Skripte an, ohne Python neu zu starten.
const CACHE = "codekoje-w2-20261120";
const CDN_CACHE = "codekoje-cdn";
const SHELL = ["./", "index.html", "werkstatt.html", "werkstatt.js", "werkstatt-worker.js", "manifest.webmanifest",
  "icon.svg", "icon-32.png", "icon-192.png", "icon-512.png", "icon-180.png"];
const CDN = ["https://cdn.jsdelivr.net/npm/skulpt@1.2.0/dist/skulpt.min.js", "https://cdn.jsdelivr.net/npm/skulpt@1.2.0/dist/skulpt-stdlib.js"];
const CDN_HOSTS = ["cdn.jsdelivr.net", "unpkg.com", "cdnjs.cloudflare.com", "files.pythonhosted.org", "fonts.googleapis.com", "fonts.gstatic.com"];
const WERKSTATT = /\/(werkstatt\.html|werkstatt\.js|werkstatt-worker\.js)$/;

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL).catch(() => {}))
    .then(() => caches.open(CDN_CACHE)).then((c) => Promise.all(CDN.map((u) => holeCDN(c, u).catch(() => {})))));
  self.skipWaiting();
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE && k !== CDN_CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("message", (e) => { if (e.data === "claim") self.clients.claim(); });

// Header für die Isolation (nur Werkstatt-Seiten) bzw. damit fremde Dateien dort erlaubt sind
function mitHeadern(r, isolieren) {
  if (!r || r.status === 0) return r;
  const h = new Headers(r.headers);
  h.set("Cross-Origin-Resource-Policy", "cross-origin");
  if (isolieren) {
    h.set("Cross-Origin-Embedder-Policy", "require-corp");
    h.set("Cross-Origin-Opener-Policy", "same-origin");
  }
  return new Response(r.body, { status: r.status, statusText: r.statusText, headers: h });
}

async function holeCDN(cache, url) {
  // immer als CORS-Anfrage holen, damit die Antwort nicht "undurchsichtig" ist (nötig für die Werkstatt)
  const r = await fetch(new Request(url, { mode: "cors", credentials: "omit" }));
  const neu = mitHeadern(r, false);
  if (r.ok) await cache.put(url, neu.clone());
  return neu;
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.hostname === "generativelanguage.googleapis.com" || url.hostname === "api.github.com") return; // KI & GitHub immer live

  // Bibliotheken, Schriften, Python, Pakete: einmal laden, dann aus dem Cache
  if (CDN_HOSTS.includes(url.hostname)) {
    e.respondWith((async () => {
      const c = await caches.open(CDN_CACHE);
      const hit = await c.match(req.url);
      if (hit) return hit;
      try { return await holeCDN(c, req.url); }
      catch (err) { return fetch(req); } // Notfall: normal laden (z. B. Seite ohne CORS)
    })());
    return;
  }

  // PyPI-Verzeichnis: erst Netz, sonst Cache
  if (url.hostname === "pypi.org") {
    e.respondWith(fetch(req).then((r) => {
      if (r.ok) { const k = r.clone(); caches.open(CDN_CACHE).then((c) => c.put(req.url, k)); }
      return r;
    }).catch(() => caches.match(req.url)));
    return;
  }

  if (url.origin !== self.location.origin) return;
  const werkstatt = WERKSTATT.test(url.pathname);

  // Seiten und Werkstatt-Dateien: erst Netz (für Updates), sonst Cache
  if (req.mode === "navigate" || werkstatt) {
    const schluessel = req.mode === "navigate" ? (werkstatt ? "werkstatt.html" : "index.html") : req;
    e.respondWith(fetch(req).then((r) => {
      if (r.ok && r.type === "basic") { const k = r.clone(); caches.open(CACHE).then((x) => x.put(schluessel, k)); }
      return mitHeadern(r, werkstatt);
    }).catch(async () => mitHeadern(await caches.match(schluessel, { ignoreSearch: true }), werkstatt)));
    return;
  }

  // Icons usw.: aus dem Cache, sonst Netz
  e.respondWith(caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req).then((r) => {
    if (r.ok) { const c = r.clone(); caches.open(CACHE).then((x) => x.put(req, c)); }
    return r;
  })));
});

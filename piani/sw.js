/* Service worker — Pro Loco Fabbrico · Piani
   Tiene sul telefono la pagina e le librerie, così l'app si apre anche senza rete.
   I dati non passano di qui: li tiene l'app (copia locale + coda delle modifiche). */
const CACHE = "piani-v1";
const PAGINA = "./index.html";
const SCOCCA = ["./", "./index.html", "./manifest.webmanifest", "./icon-192.png", "./icon-512.png", "./apple-touch-icon.png"];
const LIBRERIE = [
  "https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js",
  "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth-compat.js",
  "https://www.gstatic.com/firebasejs/10.12.2/firebase-database-compat.js",
  "https://unpkg.com/react@18.3.1/umd/react.production.min.js",
  "https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js",
  "https://unpkg.com/@babel/standalone@7.26.4/babel.min.js",
  "https://unpkg.com/@fortune-sheet/react@1.0.4/dist/index.umd.min.js",
  "https://unpkg.com/@fortune-sheet/react@1.0.4/dist/index.umd.min.css",
  "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js"
];
/* da questi siti si tengono in cache i file scaricati (librerie con la versione nell'indirizzo, caratteri) */
const ESTERNI = ["www.gstatic.com", "unpkg.com", "cdnjs.cloudflare.com", "fonts.googleapis.com", "fonts.gstatic.com"];

self.addEventListener("message", (e) => { if (e.data === "skipWaiting") self.skipWaiting(); });

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => Promise.all(
    SCOCCA.map((u) => c.add(new Request(u, { cache: "reload" })).catch(() => {}))
      .concat(LIBRERIE.map((u) => fetch(u, { mode: "cors" }).then((r) => { if (r.ok) return c.put(u, r); }).catch(() => {})))
  )));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((ks) => Promise.all(ks.filter((k) => k.indexOf("piani-") === 0 && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

const metti = (req, res) => { if (res && (res.ok || res.type === "opaque")) { const c = res.clone(); caches.open(CACHE).then((x) => x.put(req, c)).catch(() => {}); } return res; };

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // la pagina: prima la rete (così gli aggiornamenti arrivano subito), senza rete quella salvata
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req.url, { cache: "no-cache", credentials: "same-origin" })
        .then((r) => { if (r.ok && url.origin === self.location.origin) caches.open(CACHE).then((c) => c.put(PAGINA, r.clone())).catch(() => {}); return r; })
        .catch(() => caches.match(PAGINA).then((r) => r || caches.match("./")))
    );
    return;
  }

  if (url.origin === self.location.origin) {
    if (url.searchParams.has("v")) return;                 // controllo della versione: sempre dalla rete
    e.respondWith(fetch(req).then((r) => metti(req, r)).catch(() => caches.match(req, { ignoreSearch: true })));
    return;
  }

  // librerie e caratteri: quelli salvati subito (hanno la versione nell'indirizzo), altrimenti rete e li salvo
  if (ESTERNI.indexOf(url.hostname) >= 0) {
    e.respondWith(caches.match(req).then((r) => r || fetch(req).then((x) => metti(req, x))));
  }
  // tutto il resto (database, accesso) passa senza toccarlo
});

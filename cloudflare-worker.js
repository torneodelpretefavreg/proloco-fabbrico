// Notifiche immediate — Pro Loco Fabbrico
// Cloudflare Worker. Va impostato un segreto (Settings → Variables and Secrets):
//   FIREBASE_SA = contenuto del file .json della chiave privata Firebase (account di servizio)
//
// L'app chiama questo indirizzo subito dopo un salvataggio con: { idToken, evento, id, ... }
// Il worker verifica che l'utente sia un membro attivo, rilegge l'attività da Firestore
// (non si fida di quello che manda l'app) e invia le notifiche push con Firebase Cloud Messaging.

const PROJECT = "proloco-fabbrico";
const APP_URL = "https://torneodelpretefavreg.github.io/proloco-fabbrico/";
const ORIGINI = ["https://torneodelpretefavreg.github.io"];
const MESI = ["gen", "feb", "mar", "apr", "mag", "giu", "lug", "ago", "set", "ott", "nov", "dic"];
const DEFAULT = { assegnazioni: true, adminAttivita: true };
const FS = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;

export default {
  async fetch(req, env) {
    const origin = req.headers.get("Origin") || "";
    const cors = {
      "Access-Control-Allow-Origin": ORIGINI.includes(origin) ? origin : ORIGINI[0],
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Vary": "Origin",
    };
    const risp = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    if (req.method === "GET") return risp({ ok: true, servizio: "notifiche Pro Loco Fabbrico", configurato: !!env.FIREBASE_SA });
    if (req.method !== "POST") return risp({ errore: "metodo non ammesso" }, 405);
    try {
      const body = JSON.parse(await req.text());
      const uid = await verificaIdToken(body.idToken).catch(() => null);
      if (!uid) return risp({ errore: "non autorizzato" }, 401);
      const esito = await gestisci(env, uid, body);
      return risp(esito);
    } catch (e) {
      return risp({ errore: String(e && e.message || e) }, 500);
    }
  },
};

// ---------------------------------------------------------------- logica
async function gestisci(env, uid, body) {
  const token = await accessToken(env);
  const [att, utenti, tokens, settings] = await Promise.all([
    getDoc(token, "attivita", body.id), lista(token, "utenti"), lista(token, "pushTokens"), lista(token, "pushSettings"),
  ]);
  const utMap = Object.fromEntries(utenti.map(u => [u.id, u]));
  const io = utMap[uid];
  if (!io || io.attivo === false) return { errore: "utente non attivo" };
  if (!att) return { inviate: 0, nota: "attività non trovata" };

  const pref = Object.fromEntries(settings.map(s => [s.id, { ...DEFAULT, ...s }]));
  const prefDi = (u) => pref[u] || DEFAULT;
  const attivi = utenti.filter(u => u.attivo !== false && !u.sostituitoDa);
  const admins = attivi.filter(u => u.ruolo === "admin").map(u => u.id);
  const nome = (id) => (utMap[id] && utMap[id].nome) || "Qualcuno";
  const resp = att.responsabili || [];
  const fine = att.fine || att.inizio;
  const msgs = []; // { a, title, body, tag }
  const patch = {};

  const ev = body.evento;
  if (ev === "creata" || ev === "assegnazione") {
    const gia = att.notificati || [];
    const nuovi = [...new Set((body.nuovi || []).filter(x => resp.includes(x) && x !== uid && !gia.includes(x)))];
    nuovi.forEach(u => { if (prefDi(u).assegnazioni !== false) msgs.push({ a: u, title: "Nuova attività per te", body: `${att.titolo} · entro il ${fmt(fine)}`, tag: "ass-" + body.id }); });
    patch.notificati = [...new Set([...gia, ...resp])];
    if (ev === "creata") admins.filter(a => a !== uid && prefDi(a).adminAttivita !== false)
      .forEach(a => msgs.push({ a, title: "Novità dal team", body: `${io.nome} ha creato: ${att.titolo}`, tag: "nov-" + body.id }));
  }
  if (ev === "fatto") {
    const persona = body.persona;
    if (persona && att.completamenti && att.completamenti[persona]) {
      admins.filter(a => a !== uid && a !== persona && prefDi(a).adminAttivita !== false)
        .forEach(a => msgs.push({ a, title: "Novità dal team", body: `${nome(persona)} ha segnato fatto: ${att.titolo}`, tag: "fatto-" + body.id + "-" + persona }));
      const tutti = resp.length > 0 && resp.every(id => att.completamenti && att.completamenti[id]);
      const approvata = !!(att.approvato && att.approvato.il) || att.stato === "fatto";
      if (tutti && !approvata && !att.avvisoApprovazione) {
        [...new Set([...admins, ...(att.referente ? [att.referente] : [])])].filter(a => a !== uid)
          .forEach(a => msgs.push({ a, title: "Da approvare ✓", body: `${att.titolo}: tutti hanno segnato fatto`, tag: "appr-" + body.id }));
        patch.avvisoApprovazione = true;
      }
    }
  }
  if (ev === "approvata" && att.approvato && att.approvato.il) {
    admins.filter(a => a !== uid && prefDi(a).adminAttivita !== false)
      .forEach(a => msgs.push({ a, title: "Novità dal team", body: `${io.nome} ha approvato: ${att.titolo}`, tag: "ok-" + body.id }));
    resp.filter(u => u !== uid && !admins.includes(u))
      .forEach(u => msgs.push({ a: u, title: "Attività approvata ✓", body: `${att.titolo} è stata approvata da ${io.nome}`, tag: "ok-" + body.id }));
  }

  // invio
  const tokPer = {};
  tokens.forEach(t => { if (t.uid && t.token) (tokPer[t.uid] = tokPer[t.uid] || []).push(t); });
  let inviate = 0; const morti = new Set();
  for (const m of msgs) {
    if (!utMap[m.a] || utMap[m.a].attivo === false) continue;
    for (const t of tokPer[m.a] || []) {
      const r = await fetch(`https://fcm.googleapis.com/v1/projects/${PROJECT}/messages:send`, {
        method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        body: JSON.stringify({ message: {
          token: t.token,
          notification: { title: m.title, body: m.body },
          webpush: { notification: { icon: APP_URL + "icon-192.png", badge: APP_URL + "icon-192.png", tag: m.tag }, fcm_options: { link: APP_URL } },
        } }),
      });
      if (r.ok) inviate++;
      else if (r.status === 404 || r.status === 400) morti.add(t.id);
    }
  }
  const lavori = [...morti].map(id => fetch(`${FS}/pushTokens/${encodeURIComponent(id)}`, { method: "DELETE", headers: { Authorization: "Bearer " + token } }));
  if (Object.keys(patch).length) lavori.push(aggiorna(token, "attivita", body.id, patch));
  await Promise.all(lavori);
  return { inviate, messaggi: msgs.length };
}

const fmt = (k) => { const [, m, d] = String(k || "").split("-").map(Number); return d ? `${d} ${MESI[m - 1]}` : ""; };

// ---------------------------------------------------------------- Firestore REST
function daFS(v) {
  if (!v) return null;
  if ("stringValue" in v) return v.stringValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("timestampValue" in v) return v.timestampValue;
  if ("nullValue" in v) return null;
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(daFS);
  if ("mapValue" in v) return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, daFS(x)]));
  return null;
}
function aFS(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === "string") return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(aFS) } };
  return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, aFS(x)])) } };
}
const docDa = (d) => ({ id: d.name.split("/").pop(), ...Object.fromEntries(Object.entries(d.fields || {}).map(([k, v]) => [k, daFS(v)])) });
async function getDoc(token, c, id) {
  if (!id) return null;
  const r = await fetch(`${FS}/${c}/${encodeURIComponent(id)}`, { headers: { Authorization: "Bearer " + token } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error("Firestore " + r.status);
  return docDa(await r.json());
}
async function lista(token, c) {
  const out = []; let pt = "";
  do {
    const r = await fetch(`${FS}/${c}?pageSize=300${pt ? "&pageToken=" + pt : ""}`, { headers: { Authorization: "Bearer " + token } });
    if (!r.ok) throw new Error("Firestore " + r.status);
    const j = await r.json();
    (j.documents || []).forEach(d => out.push(docDa(d)));
    pt = j.nextPageToken || "";
  } while (pt);
  return out;
}
async function aggiorna(token, c, id, campi) {
  const mask = Object.keys(campi).map(k => "updateMask.fieldPaths=" + encodeURIComponent(k)).join("&");
  return fetch(`${FS}/${c}/${encodeURIComponent(id)}?${mask}&currentDocument.exists=true`, {
    method: "PATCH", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ fields: Object.fromEntries(Object.entries(campi).map(([k, v]) => [k, aFS(v)])) }),
  });
}

// ---------------------------------------------------------------- autenticazione
const enc = new TextEncoder();
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const deb64u = (s) => { s = s.replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "="; return Uint8Array.from(atob(s), c => c.charCodeAt(0)); };

let chiaviGoogle = null, chiaviScadenza = 0;
async function verificaIdToken(idToken) {
  if (!idToken || typeof idToken !== "string") return null;
  const parti = idToken.split(".");
  if (parti.length !== 3) return null;
  const head = JSON.parse(new TextDecoder().decode(deb64u(parti[0])));
  const pl = JSON.parse(new TextDecoder().decode(deb64u(parti[1])));
  const ora = Math.floor(Date.now() / 1000);
  if (head.alg !== "RS256" || pl.aud !== PROJECT || pl.iss !== "https://securetoken.google.com/" + PROJECT || !pl.sub || pl.exp < ora || pl.iat > ora + 300) return null;
  if (!chiaviGoogle || Date.now() > chiaviScadenza) {
    const r = await fetch("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com");
    chiaviGoogle = (await r.json()).keys || []; chiaviScadenza = Date.now() + 3600 * 1000;
  }
  const jwk = chiaviGoogle.find(k => k.kid === head.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, deb64u(parti[2]), enc.encode(parti[0] + "." + parti[1]));
  return ok ? pl.sub : null;
}

let tokenCache = null, tokenScadenza = 0;
async function accessToken(env) {
  if (tokenCache && Date.now() < tokenScadenza) return tokenCache;
  const sa = JSON.parse(env.FIREBASE_SA || "null");
  if (!sa || !sa.private_key) throw new Error("Manca il segreto FIREBASE_SA");
  const der = deb64u(sa.private_key.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "").replace(/\+/g, "-").replace(/\//g, "_"));
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const ora = Math.floor(Date.now() / 1000);
  const h = b64u(enc.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const p = b64u(enc.encode(JSON.stringify({
    iss: sa.client_email, aud: "https://oauth2.googleapis.com/token", iat: ora, exp: ora + 3600,
    scope: "https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/firebase.messaging",
  })));
  const firma = b64u(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(h + "." + p)));
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=" + encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer") + "&assertion=" + h + "." + p + "." + firma,
  });
  const j = await r.json();
  if (!j.access_token) throw new Error("Accesso a Google non riuscito");
  tokenCache = j.access_token; tokenScadenza = Date.now() + 50 * 60 * 1000;
  return tokenCache;
}

// Notifiche push della Pro Loco Fabbrico.
// Gira su GitHub Actions ogni 5 minuti (vedi .github/workflows/notifiche.yml).
// Serve il segreto FIREBASE_SA = chiave JSON di un account di servizio Firebase.
//
// Cosa manda:
//  - "Nuova attività per te" quando qualcuno viene aggiunto come incaricato
//  - "Sotto-attività per te" quando qualcuno diventa responsabile di una sotto-attività (riserva: di solito lo fa subito Cloudflare)
//  - "Da approvare" all'amministratore (e al responsabile) quando tutti hanno chiuso il loro cerchio
//  - ogni mattina dalle 8: scadenze vicine e riepilogo (giornaliero o del lunedì), secondo le preferenze di ognuno
//  - agli amministratori: nuove attività create da altri, ogni "fatto" segnato, approvazioni date da altri

import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getMessaging } from "firebase-admin/messaging";

const APP_URL = "https://torneodelpretefavreg.github.io/proloco-fabbrico/";
const ORA_MATTINA = 8;
const DEFAULT = { scadenze: true, giorniPrima: 2, assegnazioni: true, riepilogo: "settimanale", adminAttivita: true };
const MESI = ["gen", "feb", "mar", "apr", "mag", "giu", "lug", "ago", "set", "ott", "nov", "dic"];

let sa = null;
try { sa = JSON.parse(process.env.FIREBASE_SA || "null"); } catch (e) {}
if (!sa || !sa.private_key) { console.log("Manca il segreto FIREBASE_SA: niente da fare."); process.exit(0); }
initializeApp({ credential: cert(sa) });
const db = getFirestore();
const fcm = getMessaging();

// ---- date in ora italiana ----
function adessoRoma() {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Rome", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false, weekday: "short" });
  const p = Object.fromEntries(f.formatToParts(new Date()).map(x => [x.type, x.value]));
  return { oggi: `${p.year}-${p.month}-${p.day}`, ora: Number(p.hour) % 24, giorno: p.weekday };
}
const giorniTra = (a, b) => Math.round((Date.parse(b + "T12:00:00Z") - Date.parse(a + "T12:00:00Z")) / 86400000);
const fmt = (k) => { const [, m, d] = String(k).split("-").map(Number); return `${d} ${MESI[m - 1]}`; };
const fineDi = (a) => a.fine || a.inizio;
const fatta = (a) => !!(a.approvato && a.approvato.il) || a.stato === "fatto" || a.done === true;
const elenco = (arr, n = 3) => arr.slice(0, n).join(", ") + (arr.length - n === 1 ? " e un'altra" : arr.length > n ? ` e altre ${arr.length - n}` : "");

const tutti = async (c) => (await db.collection(c).get()).docs.map(d => ({ id: d.id, ref: d.ref, ...d.data() }));

async function main() {
  const { oggi, ora, giorno } = adessoRoma();
  const inizioGiro = new Date().toISOString(); // le novità successive le vedrà il giro dopo
  const [utenti, attivita, tokens, settings] = await Promise.all([tutti("utenti"), tutti("attivita"), tutti("pushTokens"), tutti("pushSettings")]);
  const statoRef = db.collection("config").doc("notifiche");
  const stato = (await statoRef.get()).data() || {};

  const attivi = utenti.filter(u => u.attivo !== false && !u.sostituitoDa);
  const utMap = Object.fromEntries(utenti.map(u => [u.id, u]));
  const pref = Object.fromEntries(settings.map(s => [s.id, { ...DEFAULT, ...s }]));
  const prefDi = (uid) => pref[uid] || DEFAULT;
  const tokPer = {};
  tokens.forEach(t => { if (t.uid && t.token) (tokPer[t.uid] = tokPer[t.uid] || []).push(t); });
  const admins = attivi.filter(u => u.ruolo === "admin").map(u => u.id);

  const coda = {}; // uid -> { assegnate: [], sotto: [], altre: [], novita: [] }
  const metti = (uid, tipo, msg) => { if (!utMap[uid] || utMap[uid].attivo === false) return; (coda[uid] = coda[uid] || { assegnate: [], sotto: [], altre: [], novita: [] })[tipo].push(msg); };
  const chiaveSub = (s) => s.id + ":" + s.resp;
  const nome = (uid, fallback) => (utMap[uid] && utMap[uid].nome) || fallback || "Qualcuno";
  const scritture = [];

  // 1) nuove assegnazioni
  for (const a of attivita) {
    const resp = a.responsabili || [];
    const gia = a.notificati || [];
    const nuovi = resp.filter(x => !gia.includes(x));
    if (!nuovi.length) continue;
    // al primo giro avviso solo per le attività create negli ultimi 2 giorni
    const recente = stato.inizializzato || (a.creatoIl && Date.now() - Date.parse(a.creatoIl) < 2 * 86400000);
    const chi = a.modificatoDaUid || a.creatoDaUid; // chi si assegna da solo non riceve l'avviso
    if (recente && !fatta(a)) {
      for (const u of nuovi) if (u !== chi && prefDi(u).assegnazioni !== false) metti(u, "assegnate", a);
    }
    scritture.push(a.ref.update({ notificati: [...new Set([...gia, ...resp])] }));
  }

  // 1b) nuovi responsabili di sotto-attività
  // La prima volta che un'attività viene vista qui si segna solo il punto di partenza, senza avvisare.
  for (const a of attivita) {
    const conResp = (a.sottoattivita || []).filter(s => s && s.id && s.resp);
    const chiavi = conResp.map(chiaveSub);
    if (!Array.isArray(a.notificatiSub)) { scritture.push(a.ref.update({ notificatiSub: chiavi })); continue; }
    const nuove = conResp.filter(s => !a.notificatiSub.includes(chiaveSub(s)));
    if (!nuove.length) continue;
    const chi = a.modificatoDaUid || a.creatoDaUid;
    if (!fatta(a)) for (const s of nuove) if (!s.done && s.resp !== chi && prefDi(s.resp).assegnazioni !== false) metti(s.resp, "sotto", { a, s });
    scritture.push(a.ref.update({ notificatiSub: [...new Set([...a.notificatiSub, ...chiavi])] }));
  }

  // 2) attività da approvare
  for (const a of attivita) {
    const resp = a.responsabili || [];
    const daApprovare = !fatta(a) && resp.length > 0 && resp.every(id => a.completamenti && a.completamenti[id]);
    if (daApprovare && !a.avvisoApprovazione) {
      const approvatori = [...new Set([...admins, ...(a.referente ? [a.referente] : [])])];
      approvatori.forEach(u => metti(u, "altre", { title: "Da approvare ✓", body: `${a.titolo}: tutti hanno segnato fatto`, tag: "appr-" + a.id }));
      scritture.push(a.ref.update({ avvisoApprovazione: true }));
    } else if (!daApprovare && a.avvisoApprovazione) {
      scritture.push(a.ref.update({ avvisoApprovazione: false }));
    }
  }

  // 2b) novità per gli amministratori (solo eventi successivi all'ultimo giro)
  // Ora questi avvisi li manda subito il servizio Cloudflare (cloudflare-worker.js): qui restano spenti
  // per non mandarli doppi. Per riattivarli qui, metti NOVITA_DA_GITHUB = true.
  const NOVITA_DA_GITHUB = false;
  const da = stato.ultimoControlloAdmin; // al primo giro non avviso niente: fisso solo il punto di partenza
  if (da && NOVITA_DA_GITHUB) {
    const destinatari = admins.filter(u => prefDi(u).adminAttivita !== false);
    const eventi = [];
    for (const a of attivita) {
      if (a.creatoIl && a.creatoIl > da && a.creatoIl <= inizioGiro)
        eventi.push({ chi: a.creatoDaUid, testo: `${nome(a.creatoDaUid, a.creatoDa)} ha creato: ${a.titolo}` });
      for (const [uid, quando] of Object.entries(a.completamenti || {}))
        if (quando > da && quando <= inizioGiro && (a.responsabili || []).includes(uid))
          eventi.push({ chi: uid, testo: `${nome(uid)} ha segnato fatto: ${a.titolo}` });
      if (a.approvato && a.approvato.il > da && a.approvato.il <= inizioGiro)
        eventi.push({ chi: a.approvato.uid, testo: `${nome(a.approvato.uid, a.approvato.nome)} ha approvato: ${a.titolo}` });
    }
    for (const u of destinatari) eventi.filter(e => e.chi !== u).forEach(e => metti(u, "novita", e.testo));
  }

  // 3) una volta al giorno, dalle 8: scadenze e riepilogo
  const giro = stato.ultimoGiorno !== oggi && ora >= ORA_MATTINA;
  if (giro) {
    for (const u of attivi) {
      const p = prefDi(u.id);
      const mie = attivita.filter(a => (a.responsabili || []).includes(u.id) && !fatta(a) && !(a.completamenti && a.completamenti[u.id]));
      // sotto-attività affidate a lui, ancora aperte, di attività non approvate
      const subMie = [];
      attivita.forEach(a => { if (!fatta(a)) (a.sottoattivita || []).forEach(s => { if (s && s.resp === u.id && !s.done) subMie.push({ a, s, fine: s.scadenza || fineDi(a) }); }); });
      if (p.scadenze !== false) {
        for (const a of mie) {
          const g = giorniTra(oggi, fineDi(a));
          const anticipo = Number(p.giorniPrima);
          if (g === anticipo || (g === 0 && anticipo !== 0) || g === -1) {
            const quando = g < 0 ? "è scaduta ieri" : g === 0 ? "scade oggi" : g === 1 ? "scade domani" : `scade tra ${g} giorni (${fmt(fineDi(a))})`;
            metti(u.id, "altre", { title: g < 0 ? "Attività in ritardo" : "Scadenza vicina", body: `${a.titolo} ${quando}`, tag: "scad-" + a.id });
          }
        }
        for (const x of subMie) {
          // senza una data propria la sotto-attività scade con l'attività: se è già tra le sue, l'avviso c'è già
          if (!x.s.scadenza && mie.includes(x.a)) continue;
          const g = giorniTra(oggi, x.fine);
          const anticipo = Number(p.giorniPrima);
          if (g === anticipo || (g === 0 && anticipo !== 0) || g === -1) {
            const quando = g < 0 ? "è scaduta ieri" : g === 0 ? "scade oggi" : g === 1 ? "scade domani" : `scade tra ${g} giorni (${fmt(x.fine)})`;
            metti(u.id, "altre", { title: g < 0 ? "Sotto-attività in ritardo" : "Scadenza vicina", body: `${x.s.text} (${x.a.titolo}) ${quando}`, tag: "scad-sub-" + x.a.id + "-" + x.s.id });
          }
        }
      }
      const vuoleRiepilogo = p.riepilogo === "giornaliero" || (p.riepilogo === "settimanale" && giorno === "Mon");
      if (vuoleRiepilogo) {
        const ritardo = mie.filter(a => fineDi(a) < oggi);
        const daApprovare = admins.includes(u.id)
          ? attivita.filter(a => !fatta(a) && (a.responsabili || []).length && a.responsabili.every(id => a.completamenti && a.completamenti[id]))
          : [];
        if (mie.length || daApprovare.length || subMie.length) {
          const parti = [];
          if (mie.length) parti.push(`${mie.length} da fare${ritardo.length ? `, ${ritardo.length} in ritardo` : ""}: ${elenco(mie.map(a => a.titolo))}`);
          if (subMie.length) {
            const subRit = subMie.filter(x => x.fine < oggi).length;
            parti.push(`${subMie.length} sotto-attività${subRit ? ` (${subRit} in ritardo)` : ""}: ${elenco(subMie.map(x => x.s.text))}`);
          }
          if (daApprovare.length) parti.push(`${daApprovare.length} da approvare`);
          metti(u.id, "altre", { title: p.riepilogo === "giornaliero" ? "Il tuo programma di oggi" : "La tua settimana", body: parti.join(" · "), tag: "riepilogo" });
        }
      }
    }
  }

  // 4) invio
  let inviate = 0;
  const daCancellare = new Set();
  for (const [uid, q] of Object.entries(coda)) {
    const msgs = [...q.altre];
    if (q.assegnate.length === 1) {
      const a = q.assegnate[0];
      msgs.unshift({ title: "Nuova attività per te", body: `${a.titolo} · entro il ${fmt(fineDi(a))}`, tag: "ass-" + a.id });
    } else if (q.assegnate.length > 1) {
      msgs.unshift({ title: `${q.assegnate.length} nuove attività per te`, body: elenco(q.assegnate.map(a => a.titolo), 4), tag: "ass-multi" });
    }
    if (q.sotto.length === 1) {
      const { a, s } = q.sotto[0];
      msgs.unshift({ title: "Sotto-attività per te", body: `${s.text} · in ${a.titolo}${s.scadenza ? ` · entro il ${fmt(s.scadenza)}` : ""}`, tag: "sub-" + a.id + "-" + s.id });
    } else if (q.sotto.length > 1) {
      msgs.unshift({ title: `${q.sotto.length} sotto-attività per te`, body: elenco(q.sotto.map(x => x.s.text), 4), tag: "sub-multi" });
    }
    if (q.novita.length === 1) msgs.push({ title: "Novità dal team", body: q.novita[0], tag: "novita" });
    else if (q.novita.length > 1) msgs.push({ title: `${q.novita.length} novità dal team`, body: elenco(q.novita, 3).replace(/, /g, " · "), tag: "novita" });
    const tk = tokPer[uid] || [];
    if (!tk.length || !msgs.length) continue;
    for (const m of msgs) {
      const res = await fcm.sendEachForMulticast({
        tokens: tk.map(t => t.token),
        notification: { title: m.title, body: m.body },
        webpush: {
          notification: { title: m.title, body: m.body, icon: APP_URL + "icon-192.png", badge: APP_URL + "icon-192.png", tag: m.tag },
          fcmOptions: { link: APP_URL },
        },
      });
      inviate += res.successCount;
      res.responses.forEach((r, i) => {
        const code = r.error && r.error.code;
        if (code === "messaging/registration-token-not-registered" || code === "messaging/invalid-registration-token" || code === "messaging/invalid-argument") daCancellare.add(tk[i].id);
      });
    }
  }
  daCancellare.forEach(id => scritture.push(db.collection("pushTokens").doc(id).delete()));

  const nuovoStato = { inizializzato: true, ultimoGiro: new Date().toISOString(), ultimoControlloAdmin: inizioGiro };
  if (giro) nuovoStato.ultimoGiorno = oggi;
  scritture.push(statoRef.set(nuovoStato, { merge: true }));
  scritture.push(db.collection("config").doc("push").set({ ultimoInvio: Date.now() }, { merge: true }));
  await Promise.all(scritture);
  console.log(`Fatto: ${inviate} notifiche consegnate, ${daCancellare.size} dispositivi rimossi${giro ? ", giro del mattino eseguito" : ""}.`);
}

main().catch(e => { console.error(e); process.exit(1); });

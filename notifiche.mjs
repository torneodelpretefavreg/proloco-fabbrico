// Notifiche push della Pro Loco Fabbrico.
// Gira su GitHub Actions ogni 5 minuti (vedi .github/workflows/notifiche.yml).
// Serve il segreto FIREBASE_SA = chiave JSON di un account di servizio Firebase.
//
// Cosa manda:
//  - "Nuova attività per te" quando qualcuno viene aggiunto come incaricato
//  - "Da approvare" all'amministratore (e al responsabile) quando tutti hanno chiuso il loro cerchio
//  - ogni mattina dalle 8: scadenze vicine e riepilogo (giornaliero o del lunedì), secondo le preferenze di ognuno

import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getMessaging } from "firebase-admin/messaging";

const APP_URL = "https://torneodelpretefavreg.github.io/proloco-fabbrico/";
const ORA_MATTINA = 8;
const DEFAULT = { scadenze: true, giorniPrima: 2, assegnazioni: true, riepilogo: "settimanale" };
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
const elenco = (arr, n = 3) => arr.slice(0, n).join(", ") + (arr.length > n ? ` e altre ${arr.length - n}` : "");

const tutti = async (c) => (await db.collection(c).get()).docs.map(d => ({ id: d.id, ref: d.ref, ...d.data() }));

async function main() {
  const { oggi, ora, giorno } = adessoRoma();
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

  const coda = {}; // uid -> { assegnate: [], altre: [] }
  const metti = (uid, tipo, msg) => { if (!utMap[uid] || utMap[uid].attivo === false) return; (coda[uid] = coda[uid] || { assegnate: [], altre: [] })[tipo].push(msg); };
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

  // 3) una volta al giorno, dalle 8: scadenze e riepilogo
  const giro = stato.ultimoGiorno !== oggi && ora >= ORA_MATTINA;
  if (giro) {
    for (const u of attivi) {
      const p = prefDi(u.id);
      const mie = attivita.filter(a => (a.responsabili || []).includes(u.id) && !fatta(a) && !(a.completamenti && a.completamenti[u.id]));
      if (p.scadenze !== false) {
        for (const a of mie) {
          const g = giorniTra(oggi, fineDi(a));
          const anticipo = Number(p.giorniPrima);
          if (g === anticipo || (g === 0 && anticipo !== 0) || g === -1) {
            const quando = g < 0 ? "è scaduta ieri" : g === 0 ? "scade oggi" : g === 1 ? "scade domani" : `scade tra ${g} giorni (${fmt(fineDi(a))})`;
            metti(u.id, "altre", { title: g < 0 ? "Attività in ritardo" : "Scadenza vicina", body: `${a.titolo} ${quando}`, tag: "scad-" + a.id });
          }
        }
      }
      const vuoleRiepilogo = p.riepilogo === "giornaliero" || (p.riepilogo === "settimanale" && giorno === "Mon");
      if (vuoleRiepilogo) {
        const ritardo = mie.filter(a => fineDi(a) < oggi);
        const daApprovare = admins.includes(u.id)
          ? attivita.filter(a => !fatta(a) && (a.responsabili || []).length && a.responsabili.every(id => a.completamenti && a.completamenti[id]))
          : [];
        if (mie.length || daApprovare.length) {
          const parti = [];
          if (mie.length) parti.push(`${mie.length} da fare${ritardo.length ? `, ${ritardo.length} in ritardo` : ""}: ${elenco(mie.map(a => a.titolo))}`);
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

  const nuovoStato = { inizializzato: true, ultimoGiro: new Date().toISOString() };
  if (giro) nuovoStato.ultimoGiorno = oggi;
  scritture.push(statoRef.set(nuovoStato, { merge: true }));
  scritture.push(db.collection("config").doc("push").set({ ultimoInvio: Date.now() }, { merge: true }));
  await Promise.all(scritture);
  console.log(`Fatto: ${inviate} notifiche consegnate, ${daCancellare.size} dispositivi rimossi${giro ? ", giro del mattino eseguito" : ""}.`);
}

main().catch(e => { console.error(e); process.exit(1); });

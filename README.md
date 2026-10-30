# Pro Loco Fabbrico · Attività

App web condivisa per il direttivo: **Gantt** delle attività divise per business unit, **calendario**, vista **Persone** (chi fa cosa e quanto carico ha nelle prossime 8 settimane), **promemoria**, sotto-attività e note, notifiche push.

## File

| File | A cosa serve |
|---|---|
| `index.html` | l'app intera |
| `sw.js` | service worker: notifiche ad app chiusa e apertura più rapida |
| `manifest.webmanifest`, `icon-*.png`, `apple-touch-icon.png` | installazione sul telefono come app |
| `firestore.rules` | regole di sicurezza del database |

Vanno pubblicati **tutti nella stessa cartella** (Firebase Hosting, GitHub Pages, Netlify…). Serve https: aperto come file dal computer funziona solo la modalità prova.

## Modalità prova

Finché in `index.html` la `apiKey` contiene "INCOLLA" l'app parte con dati di esempio salvati solo nel browser: si può provare tutto senza Firebase. Il link "ripristina" nella fascia gialla rimette i dati iniziali.

## Collegamento a Firebase (10 minuti)

1. **Crea il progetto** su console.firebase.google.com (es. `proloco-fabbrico`). Analytics non serve.
2. **Authentication** → Inizia → metodo di accesso **Email/Password** → Attiva.
3. **Firestore Database** → Crea database → modalità produzione → regione `eur3` (Europa).
4. **Regole**: Firestore → Regole → incolla il contenuto di `firestore.rules` → Pubblica.
5. **App web**: Impostazioni progetto (ingranaggio) → Le tue app → icona `</>` → registra → copia l'oggetto `firebaseConfig`.
6. In `index.html`, in cima allo script, sostituisci `firebaseConfig` con quello copiato. In `ADMIN_EMAILS` c'è già la tua email: se usi un'altra email cambiala sia lì sia in `firestore.rules`.
7. **Domini**: se pubblichi fuori da Firebase Hosting, aggiungi il dominio in Authentication → Impostazioni → Domini autorizzati.
8. Apri l'app → **Primo accesso amministratore** → scegli la password. Da quel momento sei admin.
9. ⚙️ → **Business Unit** → "Crea quelle di partenza" (Generale, Sagra, Eventi e manifestazioni, Turismo e promozione) e modificale come preferisci.
10. ⚙️ → **Utenti** → aggiungi i membri del direttivo. Ognuno riceve un'email per scegliere la password. Solo loro possono entrare ed essere responsabili.

## Ruoli

- **Amministratore**: gestisce utenti (aggiunge, disattiva, rende admin) e business unit.
- **Membro**: crea, modifica e completa attività e promemoria; modifica il proprio profilo.
- Un utente disattivato non può più entrare; le attività a suo nome restano.

## Notifiche push

**Già pronto nell'app:** ognuno, da ⚙️ → Notifiche, attiva gli avvisi sul proprio dispositivo e sceglie cosa ricevere (scadenze con X giorni di anticipo, nuove assegnazioni, riepilogo giornaliero o del lunedì).
Per attivarle: Impostazioni progetto → Cloud Messaging → Certificati push web → Genera coppia di chiavi → incolla la chiave in ⚙️ → Notifiche → Configurazione.
Su iPhone servono iOS 16.4+ e l'app aggiunta alla schermata Home.

**Ancora da fare:** l'invio vero e proprio richiede un piccolo programma che ogni mattina legge attività e preferenze e manda le notifiche. Si può fare con Cloud Functions di Firebase (piano Blaze a consumo: per una Pro Loco il costo è praticamente zero, ma serve una carta) oppure con un'azione programmata gratuita su GitHub. Lo preparo quando abbiamo collegato Firebase.

## Struttura dati (Firestore)

- `utenti/{uid}`: nome, email, ruolo (`admin`/`membro`), incarico, colore, attivo
- `bu/{id}`: nome, colore, ordine
- `attivita/{id}`: titolo, buId, responsabili[], inizio, fine, ora, milestone, luogo, stato (`da_fare`/`in_corso`/`fatto`), priorità, avanzamento, sottoattivita[], note, notifica, creatoDa, modificatoDa…
- `promemoria/{id}`: testo, scadenza, assegnatoA, done
- `pushTokens/{token}`, `pushSettings/{uid}`, `config/push`: notifiche

## Hub (`/hub`)

Pagina di partenza con tutti i programmi della Pro Loco e un archivio di password condivise: `torneodelpretefavreg.github.io/proloco-fabbrico/hub/`.

- Si entra con gli **stessi account del planner** (nome utente o email + password). Gli utenti disattivati non entrano.
- Le password dell'archivio sono cifrate nel browser (AES-256) con una **chiave dell'archivio** separata, scelta alla prima apertura: non viene salvata da nessuna parte, va comunicata a voce.
- Dati in Firestore: `hub/apps` (elenco programmi) e `hub/vault` (archivio cifrato). Serve la regola `match /hub/{id}` presente in `firestore.rules`: ripubblica le regole dopo l'aggiornamento.

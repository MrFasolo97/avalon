# Migrazione da `new_net` al nuovo codice — senza attivare l'Economy Fork #13330000

> **Nota:** questo è un *upgrade di codice*, non un cambio di economia. Si distribuisce la codebase Avalon rifattorizzata ma **non** si attivano le regole economiche dell'Hard Fork #13330000. Tutti i saldi DTC, le fee, le ricompense e i parametri economici restano invariati.

**Tipo**: runbook operativo
**Data**: 18 ottobre 2026
**Ultima verifica**: 20 ottobre 2026 — tutti i controlli sotto sono stati rieseguiti sull'albero del tag **`v2.0.2`** (= `v2.0.0` più i fix della review gitar-bot e l'allineamento a Node 24, S1), e lo stato della rete è stato rimisurato (head invariato)
**Partenza**: branch `new_net` (la linea di codice su cui gira la rete attuale, oggi ferma)
**Arrivo**: nuovo codice = tag **`v2.0.2`** su `feat/auto-force-finalize` (= la punta di codice di `new_econs` `6cc3b46` meno il commit `46c77ff`; verificato 2026-10-20: il diff di codice = esattamente i 6 file econs, zero residui econs)
**Companion**: `doc/economics_fork_13330000.md` (cosa fa la nuova economia, in dettaglio)

> **Revisione 2026-10-28** — il flag day della force-finalization è stato spostato da `13.925.000` (~21 giorni) a **`13.325.000`** (~4 h dopo la ripresa), sfruttando la catena ferma: non producendo blocchi, il cutover è già un unico riavvio coordinato, quindi la rete di sicurezza non deve attendere. Questo modifica `src/config.js` su `feat/auto-force-finalize`, quindi il tag certificato `v2.0.2` non corrisponde più all'HEAD del branch — **ri-creare il tag di release prima di usare S1** (il branch è già a `package.json` 2.0.3, senza tag).

Verifiche eseguite per questo runbook (in un worktree temporaneo; rieseguite il 20 ottobre 2026 sull'albero `v2.0.2`, il cui `src`/`test`/`scripts` corrisponde a `new_econs` `6cc3b46` fatta eccezione per il revert econs):

- il revert del commit econs **applica senza conflitti** (5 file modificati + `D test/supply-anchor.js`; 6 file, +10 / −432);
- **zero residui** dei simboli econs in `src/`, `test/`, `scripts/` sull'albero revertato (la cartella `doc/` non viene scansionata apposta: companion e documenti di migrazione discutono quei simboli di proposito — vedi il grep corretto in S2);
- `node test/audit-fixes.js` → **24 passed, 0 failed** (anche dopo il revert); `node test/force-finalize.js` → **All tests passed**;
- `npx eslint ./src/*` → identico alla baseline (**2 errori preesistenti** `curly`: `src/http/auth/index.js:90`, `src/p2p.js:533`; ~251 warning);
- la history risultante è `{0, 241600, 13325000}`: **il fork di force-finalization resta intatto** (l'one-liner di S2 restituisce `FF@13325000: true | sigVer: 2`, e l'albero revertato `src/` non contiene la entry `13330000`).

---

## 0. TL;DR

| Dentro la migrazione | Fuori |
|---|---|
| 168 commit (181 alla punta di codice `6cc3b46`: sopra `cefabdd` solo non-consenso — docs, bump javalon2, endpoint `/version`, release 2.0.0–2.0.2): hardening sicurezza (SSRF, NoSQLi, prototype pollution, redazione log), **force-finalization anti-fork**, halt-recovery, rate limiting, Node ≥ 24, testnet Docker, log viewer, bump dipendenze (`javalon2` ora `^1.1.10`) | **solo** il commit `46c77ff` `feat(econs): add hard fork #13330000 (supply-anchored pool, vote rate cap)` — 6 file, +432 / −10 |

Tre cose da tenere in testa:

1. **Un solo momento pericoloso**: il *flag day*. Tutti i leader devono girare lo stesso codice **lo stesso giorno**, perché il nuovo codice cambia anche vari validatori (R2).
2. **Cinque default nuovi che rompono i client** se non configurati: `CORS_ORIGIN`, `HTTP_HOST`, rate limit globale, `TRUST_PROXY`, body 1 MB (S3).
3. **La rete è ferma**: la ripresa della catena *è* il cutover, e fino al blocco 13.325.000 (~4 h dopo la ripresa) non esiste force-finalization come rete di sicurezza (S5, R15).

---

## 1. Cosa è "la nuova economia" — e cosa non lo è

### 1.1 L'oggetto da escludere

Un **unico commit**, `46c77ff`, tra gli ultimi commit di codice del branch (i commit sopra di esso toccano il codice solo in `cefabdd` — che non tocca l'economia — e nei fix della review v2.0.1 `d0ca532`, che ripristinano la semantica storica; tutto il resto sopra è non-consenso: docs, bump javalon2, endpoint `/version`, release 2.0.0–2.0.2):

```
46c77ff  feat(econs): add hard fork #13330000 (supply-anchored pool, vote rate cap)
         src/cache.js           2 righe toccate
         src/chain.js          43
         src/config.js         22
         src/economics.js      54
         src/main.js           34
         test/supply-anchor.js 287 (nuovo)
         ------------------------------------------------
         6 file, +432 / -10
```

Cosa aggiunge, in sintesi (dettaglio in `doc/economics_fork_13330000.md`):

| Elemento | Effetto dal blocco 13.330.000 |
|---|---|
| `rewardPoolYearlyRate: 0.10` | pool 8 h = 10 %/anno del supply totale (~52.265 DTC) invece della costante `rewardPoolAmount = 150001` |
| `vtReferenceTotal: 15500000` | cap sul payout di **un singolo voto** = `pool × \|vt\| / vtReferenceTotal` |
| `eco.totalSupplyUnits` + `chain.scanSupply()` + persistenza in `cache.state` | accumulatore di supply (stato di consenso) su cui si calcola il pool |
| `pow10` / `ipow` gated su `accountPrice` | determinismo numerico (pre-fork i `Math.pow(10,n)` erano già bit-identici) |
| `initialSupplyBlock: 13320066`, `initialSupply: 572311976.600145` | anchor frozen, filtrato da `allowedKeys` (la governance non può riscriverlo) |

### 1.2 Cosa NON è la nuova economia (e va tenuto)

Tutto il resto del branch, incluso un altro hard fork **che resta**:

```
   0     config base (valori effettivi invariati; solo il rename interno blockHashSerialization → consensusSigVersion, valore 1)
 241600    txLimits (già attiva su new_net)
 13325000  forceFinalize: true  +  consensusSigVersion: 2      <-- RESTA (altezza abbassata da 13925000 a catena ferma)
```

`13325000` è il flag day *successivo* — ora fissato appena sopra l'head di ripresa (13.320.067) invece del vecchio orizzonte di ~21 giorni, perché la catena ferma rende il cutover un unico riavvio coordinato. Abilita la force-finalization e passa la serializzazione dei messaggi di consenso alla versione a chiavi ordinate. **Va tenuto anche nella migrazione "senza economia"**: è la rete di sicurezza contro i fork, cioè il motivo principale per cui si migra.

Nota: `new_net` **non ha nessun codice di force-finalization** (`consensus.js` 290 → 684 righe, 47 commit su halt/consenso/quorum, `scripts/auto_resolve_halt.sh` nuovo da 794 righe). Questa, non l'economia, è la sostanza della migrazione.

### 1.3 Come è stata costruita l'esclusione (traccia d'audit)

**Gli operatori non costruiscono nulla**: l'esclusione è già certificata come tag `v2.0.2` — `git checkout v2.0.2` (S1) *è* tutto il passo. Le tre varianti sotto sono il registro decisionale di come è stato prodotto quell'albero (e perché V3 è stato scartato):

| Variante | Come | Diff | Pro | Contro |
|---|---|---|---|---|
| **V1 — revert** (equivalente all'albero) | `git revert 46c77ff` sul nuovo codice | 6 file (+10 / −432) + 1 commit di revert | verificata, banale, rimuove codice morto *e* il test | un commit `revert` nella storia (rumore se il branch è pubblico) |
| **V2 — storia lineare** | branch da `46c77ff^` + `cherry-pick` di tutti i commit sopra | albero **identico** a V1 | nessun `revert` nel log: preferibile se il branch viene pubblicato per i node operator | richiede una sequenza di cherry-pick (nessun conflitto atteso) |
| **V3 — solo la entry di config** | togliere il blocco `13330000` da `config.history` | ~10 righe | modifica minima; riattivare l'economia = rimettere una entry | lascia codice morto + accumulatore inutilizzato e **fa fallire `test/supply-anchor.js`** (va cancellato); un merge futuro da `new_econs` può reintrodurre la entry con conflitto silenzioso |

In ogni variante vale la regola d'oro: **la nuova economia si esclude solo nel codice, mai a runtime** (nessun env var la disabilita; nessuna `allowedKeys` la spegne).

---

## 2. Stato della rete al momento della scrittura (misurato)

| Dato | Valore | Fonte |
|---|---|---|
| Head | **13.320.067** (rimisurato 2026-10-20: invariato) | `GET https://dtube.fso.ovh/count` |
| Ultimo blocco | ts `2026-06-27T01:01:05Z`, miner `brianphobos`, `phash` coerente col blocco 13320066 | `GET /block/13320067` |
| Fermi da | **~115 giorni** al 2026-10-20 (il tip non è corrotto: è un halt, non un fork sul tip) | confronto timestamp |
| Fork econs 13.330.000 | **non ancora attivato**: mancano **9.933 blocchi** ≈ **8,3 h** di tempo-blocco (3 s) | differenza altezze |
| Fork force-finalization 13.325.000 | mancano **4.933 blocchi** ≈ **4,1 h** a 3 s — abbassata mentre la catena è ferma | differenza altezze |
| Anchor economia | 13.320.066 = **tip − 1** | `src/config.js` |

Conseguenze operative:

- **È il momento giusto**: finché la catena è ferma, escludere il fork econs è neutro (nessun blocco prodotto con le regole nuove, niente da riconciliare).
- **Ma è anche urgente**: chi riparte con il codice che *contiene* la entry lo attiva dopo ~8 h di produzione. Se alcuni nodi ripartono con l'economia e altri senza, si spacca (R1).
- **L'anchor è fissato al tip attuale − 1**: la nuova economia è stata preparata per una ripartenza *da qui*. Motivo in più per non spostare quelle due chiavi se in futuro la si vuole attivare (R9).

---

## 3. Decisioni preliminari (da chiudere prima di toccare i nodi)

- **D1 — Variante di esclusione**: V1 / V2 / V3 (§1.3). Default proposto: **V1**, o **V2** se il branch va pubblicato.
- **D2 — Chi aggiorna, e quando**: *tutti* i leader attivi, *tutti* i nodi che servono l'API pubblica di `AvalonAPINodes`, gli indexer. Chi resta su `new_net` **deve** essere spento prima del blocco di cutover (R1/R2).
- **D3 — La nuova economia si riattiva in futuro?** Se sì: serve una **nuova entry di fork** con altezza futura e anchor rimisurato. Le chiavi `initialSupply`/`initialSupplyBlock` sono invarianti di consenso: non si spostano, non si editano a mano (appendice C).
- **D4 — Punto di non ritorno e rollback**: definire *prima* il blocco oltre il quale non si torna indietro (S9) e chi ha l'autorità per dichiararlo.

---

## 4. Passi della migrazione

### S0 — Pre-flight (prima di toccare qualunque cosa) 🔴

```bash
# 1. Fotografia dello stato attuale: commit, config, chiavi
cd /percorso/avalon && git rev-parse HEAD && git status --short
cp -a .env /backup/env.$(date +%F)                    # se esiste
cp -a scripts/start.sh /backup/start.sh.$(date +%F)   # contiene le chiavi del nodo!

# 2. Backup dati (fai ENTRAMBI se non sei sicuro dello storage in uso)
cp -a "$BLOCKS_DIR"/blocks.bson /backup/blocks.bson.$(date +%F)
cp -a "$BLOCKS_DIR"/*.idx /backup/ 2>/dev/null
mongodump --db "${DB_NAME:-avalon}" --out /backup/mongo-$(date +%F)   # se si usa Mongo

# 3. Versioni e ambiente
node -v          # deve essere >= 24 (nuovo codice: engines ">=24.0.0")
npm -v
nginx -v 2>/dev/null; grep -rn "proxy_set_header\|proxy_pass" /etc/nginx/  # reverse proxy?
```

Da annotare nel foglio di cutover: altezza head, hash del blocco head, **commit** attualmente in produzione, porte (`HTTP_PORT`, `P2P_PORT`), elenco peer, minuti di tolleranza previsti.

### S1 — Ottenere il branch senza economia 🔴

**Consigliato: usare il tag di release.** L'albero verificato senza econs è pubblicato come tag **`v2.0.2`** sul branch `feat/auto-force-finalize` (verificato 2026-10-20: identico a `new_econs` in ogni file tranne i 6 file econs, zero residui econs):

```bash
cd /percorso/avalon
git fetch --all --tags
git checkout v2.0.2                 # nuovo codice senza econs, con /version + fix della review
```

**Cosa aggiungono le release rispetto a `v2.0.0`** — ciascuno riverificato sull'albero reale:

**`v2.0.1`** — tre fix dalla review automatica del codice (gitar-bot, PR #2, 20 ottobre 2026):

1. `scripts/auto_resolve_halt.sh`: l'offset di `blocks.index` viene decodificato come `(high << 8) + low`, in accordo con la codifica scritta da `src/blocks.js` (`high = pos >> 8`, `low = pos & 0xFF`). Il precedente `<< 32` faceva esplodere ogni posizione di troncamento reale oltre la dimensione del file, quindi l'ultima risorsa di troncamento BSON non avrebbe mai potuto funzionare su una chain reale;
2. `src/http/account/index.js`: `validate.string` riceve ora `allowedUsernameCharsOnlyMiddle`, quindi gli account i cui nomi contengono `-` o `.` nel mezzo (legittimi per la validazione dei tx) non vengono più 404-ati;
3. `src/consensus.js`: la quorum di finalizzazione è `floor(n·2/3) + 1` — il più piccolo intero strettamente maggiore di 2/3 — ripristinando la semantica storica di `new_net` che `ceil` + `>=` aveva indebolito per conte di `activeLeaders` multipli di 3.

**`v2.0.2`** (stesso giorno, sopra `v2.0.1`): immagini Docker e guard di avvio allineati a **Node 24** — `docker/Dockerfile` (NodeSource `setup_24.x`), `docker/testnet/Dockerfile` (`FROM node:24`), `docker/test.dockerfile` (`node:24-alpine`) e il check di versione in `main.js` (`>= v24`, era `>= v18` mentre `engines` richiedeva ≥24): chiude R8.

`v2.0.0` resta valido per la provenienza; ogni percorso operativo di questo documento usa `v2.0.2`.

Costruire il branch a mano — **non richiesto per la migrazione** (traccia d'audit, per memoria: il tag *è* già quell'albero):

Variante **V1** (verificata pulita):

```bash
cd /percorso/avalon
git fetch --all
git log --oneline -5 new_econs        # per orientamento: docs, deps, /version e i commit di release sopra cefabdd
git checkout -b new_net_noecons new_econs
git revert --no-commit 46c77ff        # nessun conflitto, nessun intervento manuale
git status --short                    # atteso: 5 M + D test/supply-anchor.js
git diff --stat                       # atteso: 6 file, 10 insertions(+), 432 deletions(-)
git commit -m "revert(econs): esclude il fork #13330000 da questa release"
```

Variante **V2** (stesso albero, storia lineare):

```bash
git checkout -b new_net_noecons 46c77ff^   # = 9774aca
git cherry-pick 46c77ff..new_econs         # tutti i commit sopra l'econs:
                                           # docs, deps, /version, release e i fix
                                           # commit di release (nessun conflitto atteso)
```

Controllo di equivalenza (in ogni variante — conferma anche il tag):

```bash
# atteso: esattamente i 6 file dell'economia — il tag/branch = nuovo codice − econs
# (limitato al codice apposta: le revisioni di doc/ possono legittimamente differire)
git diff new_econs v2.0.2 --stat -- src test scripts   # oppure il tuo new_net_noecons
```

### S2 — Verifica statica, offline ⚠️

```bash
export PATH="...node24/bin:$PATH"     # Node >= 24
npm ci                                # o npm install se il lock non è allineato

# 1. Nessun residuo dell'economia
grep -rn "rewardPoolYearlyRate\|vtReferenceTotal\|initialSupplyBlock\|totalSupplyUnits\|13330000" \
     src test scripts 2>/dev/null
# atteso: nessun output. doc/ NON viene scansionata apposta: economics_fork_13330000.md
# e i documenti di migrazione discutono quei simboli di proposito (la versione precedente
# di questo comando scansionava doc/ e l'esclusione non matchava il nome di questo file).

# 2. La config all'altezza del fork non attiva più nulla, e il resto resta
node -e 'global.logr=new Proxy({},{get:()=>()=>{}});global.cache={state:{}};
const c=require("./src/config.js");
const p=c.read(13330000), f=c.read(13325000);
console.log("econs:",p.rewardPoolYearlyRate,p.vtReferenceTotal,p.initialSupplyBlock,
            "| pool:",p.rewardPoolAmount,"| FF@13325000:",f.forceFinalize,"| sigVer:",f.consensusSigVersion)'
# atteso: econs: undefined undefined undefined | pool: 150001 | FF@13325000: true | sigVer: 2

# 3. Gate qualità
npm run lint                      # atteso: 2 errori preesistenti curly (auth/index.js:90, p2p.js:533) + ~251 warning
node test/audit-fixes.js          # atteso: 24 passed, 0 failed
node test/force-finalize.js       # atteso: All tests passed
# test/supply-anchor.js: NON deve esistere (il revert lo elimina; nella V3 va cancellato a mano)

# 4. Confermare di essere sul tag di release certificato
git describe --tags              # atteso: v2.0.2
```

### S3 — Config, ambiente, proxy 🔴

Il nuovo codice aggiunge **18 variabili d'ambiente** (ricontate il 2026-10-20: l'albero passa da 45 a 63 riferimenti `process.env`) e **non ne rimuove nessuna**. Cinque di queste cambiano il comportamento di *default* rispetto a `new_net` e possono rompere i client se ignorate:

| Variabile | Default nuovo | `new_net` | Perché importa |
|---|---|---|---|
| `CORS_ORIGIN` | **`false`** → nessun header CORS | `cors()` = `*` | 🔴 **il client web (dtube2) non riesce più a leggere le risposte API cross-origin**. Da impostare (es. `*`, o l'origine del client) |
| `HTTP_HOST` | **`127.0.0.1`** | `0.0.0.0` | 🔴 API non raggiungibile dall'esterno/dal container se non la si imposta esplicitamente (il `docker-compose.yml` la passa già) |
| rate limit globale | **50 req/s per IP** (nuovo) | assente | richieste massicce (feed, indexer, script) prendono `429`; `/transact` ha un limiter separato a **5 req/s** |
| `TRUST_PROXY` | non impostata → `X-Forwarded-For` **ignorato** | header fidato | 🔴 dietro nginx *tutti* i client condividono un solo secchiello → `429` di massa, e le sessioni admin risultano legate all'IP del proxy. Con valore sbagliato si riapre lo spoofing |
| body parser | **1 MB** | illimitato | payload grandi → `413` |

Delle 18 variabili nuove, solo ~10 toccano il runtime del daemon (4 di esse sono i must-config di sicurezza/auth: `ADMIN_TOKEN`, `LOG_ADMIN_TOKEN`, `TRUST_PROXY`, `CORS_ORIGIN`; 4 sono limiti anti-abuso: `CONTENT_MAX_COMMENTS`, `CONTENT_MAX_RESULTS`, `IMG_MAX_BYTES`, `IMG_MAX_PIXELS`; 2 sono il log viewer in-nodo: `LOG_FULL`, `LOG_PAGE`), 6 sono parametri esclusivi dello script di halt-recovery (`BSON_PATH`, `IDX_PATH`, `REMOVE_COUNT`, `NEW_HEIGHT`, `DRY_RUN`, `TMP_COLL`), 1 è ops a runtime (`SKIP_EARLY_CHECK_BLOCKS`) e 1 è solo testnet (`BOOTSTRAP_HOST`).

🔴 **Lacuna di scopribilità da chiudere prima del cutover**: **nessuna** delle nuove variabili è dichiarata in `scripts/start.sh` (che dichiara solo 12 export), benché il README indichi proprio lì "l'elenco delle variabili d'ambiente disponibili". Aggiungere in coda a `scripts/start.sh` (o consegnare un `.env.example`) un blocco commentato con le 18 nuove variabili e i loro default, così i operatori le trovano davvero.

Altre variabili nuove, da valutare: `IMG_MAX_BYTES` (10 MB), `IMG_MAX_PIXELS` (20 MPixels), `CONTENT_MAX_COMMENTS` (2000), `CONTENT_MAX_RESULTS` (10000), `LOG_ADMIN_TOKEN` / `LOG_FULL` / `LOG_PAGE` (log viewer in-nodo), e le variabili usate solo dagli script di halt (`BSON_PATH`, `IDX_PATH`, `REMOVE_COUNT`, `NEW_HEIGHT`, `DRY_RUN`, `SKIP_EARLY_CHECK_BLOCKS`, `TMP_COLL`, `BOOTSTRAP_HOST`).

Autenticazione: nel nuovo codice `requireAuth()` protegge `/debug`, `/recover`, `/logs`, `/mineBlock`. Attenzione: **su un nodo senza token configurato quegli endpoint risultano raggiungibili** (`cefabdd`) → impostare `ADMIN_TOKEN`/`LOG_ADMIN_TOKEN` prima di esporre il nodo.

Dietro reverse proxy:

```nginx
proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
# poi nel .env del nodo:
TRUST_PROXY=1        # "1" = primo hop fidato; 0/false = non fidarsi (default)
CORS_ORIGIN='*'      # o l'origine esatta del client web
HTTP_HOST=0.0.0.0
```

Docker: `docker/docker-compose.yml` ha perso `version:` e ora passa `HTTP_HOST=0.0.0.0`. Node è allineato a **24** ovunque dal `v2.0.2`: immagine mainnet (`docker/Dockerfile`, NodeSource `setup_24.x`), immagine testnet (`docker/testnet/Dockerfile`, `FROM node:24`), `docker/test.dockerfile` (`node:24-alpine`) e il guard di avvio in `main.js` (`>= v24`) — tutto coerente con `engines: node >= 24` (R8 chiuso).

### S4 — Dry-run su testnet locale ⚠️

Prima di toccare la mainnet, riprodurre la migrazione su `docker/testnet` (3 miner + bootstrap, porte 3101-3104 / 6101-6104):

1. checkout del tag di release e build (`git checkout v2.0.2 && docker compose build`);
2. catena da zero: verifica che i blocchi si producano e che nei log **non compaia mai** `Hard Fork #13330000`;
3. **prova di determinismo**: rebuild completo da genesis sul codice nuovo-senza-economia e confronto di un centinaio di hash di blocco con un nodo `new_net` → devono coincidere (i validatori sono cambiati, R2);
4. test force-finalization (due `/mineBlock` quasi simultanei su miner diversi);
5. test di un nodo di controllo che si sincronizza da zero (replay + accumulatore non coinvolto).

### S5 — Flag day: cutover mainnet 🔴

Ordine non negoziabile: **prima si ferma tutto, poi si tronca/riprende, poi si riparte con un solo codice**.

```bash
# 1. Congelamento: fermare TUTTI i leader (coordinato, chat/voice aperta)
#    - nessun nodo deve restare su new_net
# 2. Diagnosi dell'halt (sempre in dry-run per primo)
DRY_RUN=1 ./scripts/auto_resolve_halt.sh
#    Lo script tronca blocchi (BSON o Mongo) e riscrive lo stato.
#    Guardrail da conoscere: MAX_REMOVE_BLOCKS (10), MAX_TOTAL_REMOVE (30) e
#    .avalon_halt/state.json → se la catena non è avanzata dall'ultimo troncamento
#    lo script RIFIUTA di troncare di nuovo ("Manual intervention required").
# 3. Start della nuova versione su tutti i nodi (stesso commit!)
cd /percorso/avalon
export HTTP_HOST=0.0.0.0 CORS_ORIGIN='*' TRUST_PROXY=1 ADMIN_TOKEN=... LOG_ADMIN_TOKEN=...
nohup ./scripts/start.sh > /var/log/avalon.log 2>&1 &   # o systemd / pm2 / screen
```

### S6 — Verifica post-cutover (checklist)

```bash
curl -s localhost:3001/count                      # head che AVANZA (13.320.068+)
curl -s localhost:3001/block/13320068 | head -c 200   # phash = hash del 13320067
curl -s localhost:3001/supply | head -c 200           # sanità (endpoint invariato, non econs)
curl -s localhost:3001/version         # atteso: {"version":"2.0.2"} — IDENTICO su ogni nodo
grep -c "Hard Fork #13330000" /var/log/avalon.log     # atteso: 0 (per sempre)
grep "Hard Fork #" /var/log/avalon.log | tail -3      # attesi solo 241600 (e 13325000 dal futuro fork)
```

Più, sul nodo di controllo: rebuild da genesis → stesso head **e stesso hash** degli altri nodi. Formato payout/voti: invariato (pool = 150001). Primo giorno intero di osservazione: `/count` monotono, nessun `possBlocks` crescente, peer stabili. Ogni operatore esegue `curl -s localhost:3001/version` e riporta il risultato nella chat di cutover: tutti i nodi devono rispondere `2.0.2`.

### S7 — Client, indexer, embed

- **Nessuna modifica client necessaria per escludere l'economia**: il fork non tocca nessun endpoint HTTP (`46c77ff` non modifica `src/http/**`) e `/supply` resta quello di prima.
- **Ma**: `CORS_ORIGIN` va impostata su *tutti* i nodi pubblici, altrimenti dtube2 (browser) non legge le risposte.
- `client/settings.js` → `AvalonAPINodes` (`api.avalonblocks.com`, `dtube.fso.ovh`, `avalon.luminade.fun`, `dtube.tekraze.com`, `testnet.dtube.fso.ovh`, più una voce dev locale `localhost:3001`): ognuno di questi nodi va aggiornato e configurato, altrimenti il client continua a parlare con istanze vecchie.
- Rate limit: `/transact` 5 req/s per IP e globale 50 req/s → verificare i flussi che inviano più transazioni in raffica (batch di voti/upload da dtube2) e prevedere retry/backoff lato client.
- `javalon2`: il nodo passa da `^1.1.7` a `^1.1.10` (bump del 2026-10-20, commit `04ad87b`; la 1.1.10 aggiunge il fix di fallback sul DMCA endpoint e bump di dipendenze compatibili), ma **non lo usa per la validazione di consenso** (usa `secp256k1` diretto: nessun impatto sulla catena; serve solo a `scripts/mega_generic_test.js`). Il bump cambia `signVerify` lato JS (ricostruzione dell'hash + rifiuto di `pubKey`/`signature`/`hash` mancanti): verificare gli script/tool terzi che firmavano con la vecchia formulazione.
- `dtube-embed`, `ipfs-caching`, `DTubeGo` non sono coinvolti in questa migrazione.

### S8 — Sorveglianza e secondo flag day (13.325.000)

- Entro **13.325.000** (4.933 blocchi ≈ **4 h** a 3 s dall'attuale head — appena sopra il blocco di ripresa, sfruttando l'halt) **tutti i nodi devono girare il nuovo codice**: quel fork abilita `forceFinalize` e passa `consensusSigVersion` a 2 (serializzazione a chiavi ordinate). Un nodo rimasto indietro non produce/valida le stesse firme → fork o halt.
- Fino a quel blocco la rete ha **forza-finalization disabilitata**: un nuovo halt si risolve solo con `auto_resolve_halt.sh`.
- Da monitorare: `Hard Fork #13325000` nei log al momento giusto, health dei peer, eventuali `possBlocks` multipli.
- **Backlog post-migrazione** (audit dipendenze 2026-10-20): bump `sharp` `^0.32.6` → `^0.35.5` (high: CVE libvips/libheif sull'endpoint di processing immagini utente; validare con un test upload+resize) e `apidoc` `^1.2.0` → `^0.29.0` (solo dev). Un commit, DOPO il cutover — fuori dal delta del flag day apposta.

### S9 — Rollback

- **Rollback immediato** (prima di produrre blocchi con il nuovo codice): stop → `git checkout` del commit precedente → restart. Costo: i minuti di fermo.
- 🔴 **Dopo che il nuovo codice ha validato blocchi**: tornare a `new_net` significa **troncare fino al blocco di cutover**, perché `new_net` non conosce le correzioni di validazione introdotte dal nuovo codice (R2/R3). Serve il backup di S0 e lo stesso `auto_resolve_halt.sh`.
- Salvare per poter tornare indietro: `blocks.bson`/dump Mongo, commit precedente, `.env`, `.avalon_halt/state.json`, log del periodo.

---

## 5. Rischi

| # | Rischio | Impatto | Prob. | Mitigazione |
|---|---|---|---|---|
| **R1** | Esclusione applicata solo ad alcuni nodi → al blocco 13.330.000 alcuni applicano il fork e altri no: `dist`/pool diversi, **catena divisa** | 🔴 critico | media | flag day con tutti i leader; verifica S2 (one-liner su ogni nodo) + `grep "Hard Fork #13330000"` = 0 + `curl /version` = 2.0.2 su ogni nodo; nessun nodo `new_net` online |
| **R2** | Il nuovo codice cambia **validatori** (`validate/json.js`, `float.js`, `integer.js`, `string.js`, controllo bandwidth su create-account, bound dimensione blocchi, JSON con chiavi `.`/`$` rifiutate): un blocco/tx accettata dai vecchi può essere rifiutata dai nuovi | 🔴 fork o rebuild impossibile | alta se il cutover non è coordinato | testnet S4 con rebuild di controllo e confronto hash; cutover simultaneo; nessun nodo misto |
| **R3** | Rollback dopo blocchi post-cutover: la vecchia versione non riesce a validare la catena nuova | 🔴 perdita dati | media | definire in D4 il punto di non ritorno; backup S0; troncamento mirato S9 |
| **R4** | `CORS_ORIGIN` non impostata (default `false`) → il client web non legge le API | 🔴 client rotto | alta | impostarla su tutti i nodi pubblici (S3, S7) |
| **R5** | `HTTP_HOST` default `127.0.0.1` → API non raggiungibile dall'esterno | 🔴 servizio down | media | impostare `HTTP_HOST=0.0.0.0` (S3) e verificare da fuori, non solo da localhost |
| **R6** | Rate limit globale 50 r/s + `TRUST_PROXY` non impostata dietro proxy: un solo secchiello per tutti → `429` di massa; sessioni admin legate all'IP del proxy | 🟠 degrado/abuso | alta | `TRUST_PROXY` corretta + header nginx; valutare limiti in nginx; monitorare i `429` |
| **R7** | Rate limit su `/transact` (5 r/s) rompe flussi batch di dtube2 | 🟠 tx perse | media | backoff/retry client; verificare i flussi di voto/upload |
| **R8** | Node: `engines >= 24` ma immagini Docker su **Node 18** (`docker/Dockerfile`, `docker/testnet/Dockerfile`) e check runtime `>= 18` — trovato in validazione | 🟠 install/runtime non supportato | bassa *(chiuso)* | **chiuso in `v2.0.2`**: immagini allineate (`setup_24.x`, `FROM node:24`, `node:24-alpine`) e guard di `main.js` portato a `>= v24`; validare con `npm ci` su Node ≥ 24 |
| **R9** | Riattivare l'economia in futuro toccando `initialSupplyBlock`/`initialSupply` (anchor frozen, filtrato da `allowedKeys`) | 🔴 fork silenzioso | bassa | nuova entry di fork con altezza futura e anchor misurato; mai spostare le chiavi esistenti (appendice C) |
| **R10** | `eco.totalSupplyUnits` non bootstrappato → `logr.fatal` + `process.exit(1)` al primo blocco del fork (per un nodo che attraversa l'anchor senza ripartire) | 🟠 nodo che muore | bassa (esclusa in questa migrazione) | è il motivo per cui l'anchor è al tip attuale: riavvio di tutti i nodi in occasione della ripartenza |
| **R11** | Halt non risolto: force-finalization **non è attiva** fino a 13.325.000; i guardrail dello script (max 10 blocchi per passata, 30 totali, stato `.avalon_halt`) possono rifiutare il troncamento | 🔴 catena ferma | media | `DRY_RUN=1` prima, pianificare l'intervento manuale, backup S0, finestra di manutenzione concordata |
| **R12** | Senza la nuova economia restano aperti: ceiling di emissione 28,7 %/anno con pool costante `150001`, e il **drenaggio del pool da parte di una singola whale** su rete inattiva (bug di value extraction, `economics_fork_13330000.md` §2) | 🟠 economico | certa | decisione di business esplicita e datata (D3): riattivare con un fork successivo |
| **R13** | `scripts/start.sh` contiene una **chiave privata in chiaro** (`NODE_OWNER_PRIV=34Ep…`) su entrambi i branch, e nella storia ci sono commit "rimuovi chiavi private" poi annullati | 🔴 sicurezza | certa | ruotare la chiave del nodo prima di diffondere questo documento o il branch; non versionare `start.sh` reale |
| **R14** | Bump dipendenze (`mongodb` 4.2→4.17, `sharp`, `secp256k1`, `express`, ora `javalon2` ^1.1.10): comportamento/indici diversi su DB esistenti | 🟠 errori a runtime | media | test su copia del DB; leggere i log al primo avvio; `npm ci` da lockfile |
| **R15** | Il nuovo codice *è* una release anti-halt (consensus.js 290→684 righe) ma la force-finalization è disattivata fino a 13.325.000: la stabilità della ripresa dipende dalla nuova logica non ancora esercitata in produzione | 🟠 nuovo halt | media | testnet di force-finalization (S4); `auto_resolve_halt.sh` pronto; osservazione ravvicinata (S8) |

---

## 6. Definition of done

- [ ] Tag checkoutato su ogni nodo (`git checkout v2.0.2`) e `git diff new_econs v2.0.2 --stat -- src test scripts` mostra **solo** i 6 file dell'economia
- [ ] `grep` residui e one-liner config di S2 → esito atteso (nessuna chiave econs, `pool: 150001`, `FF@13325000: true`, `sigVer: 2`)
- [ ] `npm run lint` + `test/audit-fixes.js` + `test/force-finalize.js` verdi come da baseline
- [ ] Node ≥ 24 su tutti i nodi e nelle immagini Docker
- [ ] Ogni nodo sul tag certificato (`git describe --tags` = `v2.0.2`); `curl /version` restituisce `2.0.2` su ogni nodo
- [ ] `CORS_ORIGIN`, `HTTP_HOST`, `TRUST_PROXY`, `ADMIN_TOKEN`/`LOG_ADMIN_TOKEN` impostate e verificate **da fuori rete locale**
- [ ] Nuove env vars dichiarate in `scripts/start.sh` (blocco commentato) perché i operatori possano scoprirle
- [ ] Dry-run su testnet: rebuild da genesis con hash coincidenti + force-finalization testata
- [ ] Backup di blocchi, DB, `.env`, commit precedente in luogo sicuro e verificato
- [ ] Tutti i leader fermi, nessuno su `new_net`, chat di cutover aperta
- [ ] Dopo il cutover: `/count` avanza, hash di catena coerenti su tutti i nodi, **zero** `Hard Fork #13330000` nei log
- [ ] Calendario condiviso con la rete: entro il blocco **13.325.000** tutti sul nuovo codice
- [ ] Chiave privata di `scripts/start.sh` ruotata

---

## 7. ⏱ Stime di esecuzione

Tempo di presidio umano per passo, stimato sul layout reale del nodo mainnet (`blocks.bson` 4,2 GB + 102 MB index, Mongo ~2,7 GB):

| Passo | Presidio | Su cosa si basa |
|---|---|---|
| **S0 pre-flight** | **~15 min** | copia blocks.bson/index ≈ 1–2 min (4,3G su disco locale/1Gbit), `mongodump` 2,7G ≈ 2–3 min, snapshot git/env/chiavi ~5 min |
| **S1 checkout della release** | **~1 min** | `git checkout v2.0.2` (tag già certificato; le varianti di self-build sono solo audit) |
| **S2 verifica statica** | **~10–15 min** | `npm ci` 1–5 min (a cache), grep + one-liner config + lint + 2 suite di test |
| **S3 config/proxy** | **~30 min per nodo** | `.env` + blocco commentato nuovo in `start.sh` + nginx (`X-Forwarded-For`) + verifica dall'esterno |
| **S4 dry-run testnet** | **~1–2 h al primo giro**, ~45 min a ripetizione | `docker compose build` 15–30 min la prima volta; catena da zero, rebuild di determinismo, test force-finalization |
| **S5 flag day** | **finestra ~45–60 min** | stop di tutti i leader 10–15, diagnosi `DRY_RUN=1` 5–10, troncamento/restart 10–15, verifica primo blocco 10–15 |
| **S6 post-cutover** | **~15 min + 1–4 h non presidiate** | checklist curl; il rebuild da genesis sul nodo di controllo gira in background (13,3M blocchi) |
| **S7 client/indexer** | **~1 h** | `CORS_ORIGIN` su ogni nodo pubblico di `AvalonAPINodes` (~10–15 min ciascuno) + check flussi batch dtube2 |
| **S8 sorveglianza** | **~15 min in totale** | fino a 13.325.000 (≈4 h dopo la ripresa), monitoraggio leggero |
| **S9 piano rollback** | **~30 min** | decisione D4 + backup già coperti da S0 |

Totali:
- **Un operatore sul proprio nodo: ~4–6 ore di presidio** (di cui ~1 h è la finestra di cutover), più 1–4 h di rebuild non presidiato e ~4 h di osservazione leggera.
- **Calendario realistico: 2 giornate** — una per S0–S4 (dry-run su testnet), una per il flag day S5–S6 — più la finestra concertata con gli altri leader.
- Il lavoro critico è tutto in **S0–S3 + S5 (~2 h)**: il resto è attesa o monitoraggio.

---

## Appendice A — Cosa c'è nel nuovo codice (misurato il 2026-10-20)

168 commit / 102 file / +5131 −801 misurati a `cefabdd` (la vecchia punta di codice); alla punta di codice `6cc3b46`: 181 commit / 106 file / +5604 −812 — sopra `cefabdd` solo non-consenso (docs, bump javalon2, endpoint `/version`, release 2.0.0–2.0.2; i file in più rispetto a `cefabdd` sono l'`doc/v1.5.2-upgrade.md` aggiornato, questo runbook e `src/http/version/`).

| Blocco | Esempi |
|---|---|
| Consenso / anti-fork | force-finalization con quorum, backoff, firma verificata, broadcast; `forceFinalizeFallback` (default `false`: la catena si ferma invece di rischiare un fork); `consensusSigVersion: 2` gated a 13.325.000 |
| Recupero halt | `scripts/auto_resolve_halt.sh` (794 righe), troncamento BSON/Mongo, guardrail anti-loop |
| Sicurezza HTTP | SSRF (`src/http/ssrf.js`, pinning IP/TLS), validazione input, cap su query, rate limit globale e per-endpoint, `requireAuth` condiviso, sessioni legate all'IP, redazione log/credenziali |
| Rete P2P | cap payload websocket, rate limiter dedicato, TTL su `blockSenders`, cleanup O(1) |
| Robustezza cache/blocchi | scrittura atomica dello stato, error handling coda Mongo, BSON troncato gestito, `sanitizeQuery` |
| Validatori | `float`/`integer`/`string`/`json` (NaN/Infinity, chiavi `.`/`$`, bound a zero), dimensione JSON in byte |
| Piattaforma | Node ≥ 24, `docker/testnet` multi-nodo, log viewer in-nodo, endpoint `/version`, `javalon2` 1.1.10 |
| Economia (l'unica esclusa) | commit `46c77ff` |

## Appendice B — Timeline hard fork

| Altezza | Contenuto | Stato |
|---|---|---|
| 0 | config base (`rewardPoolAmount: 150001`, `rewardPoolMaxShare: 0.1`, …) | attiva |
| 241600 | `txLimits` | attiva |
| 13.320.067 | head attuale (catena ferma dal 2026-06-27; rimisurato 2026-10-20: invariato) | — |
| **13.330.000** | **economia: pool % supply + cap voto + accumulatore** | **da escludere (mai attivata: mancano 9.933 blocchi ≈ 8,3 h a 3 s)** |
| 13.325.000 | `forceFinalize: true`, `consensusSigVersion: 2` | si attiva ≈4 h dopo la ripresa (era ~21 giorni; abbassata a catena ferma) |

## Appendice C — Invarianti dell'economia (se un giorno si riattiva)

- `initialSupplyBlock: 13320066` / `initialSupply: 572311976.600145` sono **misure frozen** e sono **filtrate da `allowedKeys`**: la governance non può riscriverle, solo una nuova entry di fork può.
- Mai spostare quelle chiavi tra entry di history: cambierebbe `config.read(n)` per blocchi già prodotti.
- `bootstrapSupply()` (upgrade/riavvio) ricostruisce l'accumulatore con `chain.scanSupply(anchor+1 … head)` da BSON o Mongo: un nodo che riparte dopo l'anchor si auto-ripara; un nodo che *attraversa* l'anchor **senza** ripartire finisce in `logr.fatal` + `process.exit(1)`.
- Riattivare l'economia = nuovo fork con l'altezza futura desiderata (l'anchor 13.320.066 può restare, il costo è lo scan).

## Appendice D — Comandi rapidi

```bash
# Il mio checkout esclude davvero l'economia?  (atteso: esattamente i 6 file)
git diff new_econs HEAD --stat -- src test scripts

# Nessun residuo?  (solo src/test/scripts — vedi S2 sul perché si esclude doc/)
grep -rn "rewardPoolYearlyRate\|vtReferenceTotal\|initialSupplyBlock\|totalSupplyUnits" src test scripts

# Config all'altezza del fork + fork successivo intatto
node -e 'global.logr=new Proxy({},{get:()=>()=>{}});global.cache={state:{}};const c=require("./src/config.js");
const p=c.read(13330000),f=c.read(13325000);console.log(p.rewardPoolYearlyRate,p.vtReferenceTotal,p.initialSupplyBlock,p.rewardPoolAmount,f.forceFinalize,f.consensusSigVersion)'

# Stato della rete
curl -s https://dtube.fso.ovh/count

# Stessa release su questo nodo? (atteso: 2.0.2)
curl -s localhost:3001/version

# Il nodo ha attivato l'economia? (deve restare vuoto)
grep "Hard Fork #13330000" /var/log/avalon.log
```

# Avalon Testnet — Layer S/H Offline-Leader Drills

Testnet esteso a **5 leader + 2 standby** per eseguire la matrice G1–G12 del piano
`doc/consensus-offline-leaders-plan.en.md`.

## Requisiti

- Docker + Docker Compose v2
- ~8 GB RAM (8 nodi: bootstrap, setup, mongodb, 5 miners, 2 standbys)

## Avvio

```bash
cd docker/testnet

# Build
docker compose -p avalon-drills \
  -f docker-compose.yml \
  -f docker-compose.drills.yml build

# Avvia
docker compose -p avalon-drills \
  -f docker-compose.yml \
  -f docker-compose.drills.yml up -d

# Log
docker compose -p avalon-drills logs -f
```

L'avvio segue lo stesso flusso del testnet base:
1. `bootstrap` — genesis e primi blocchi
2. `setup` — crea 7 account (`miner1..miner5`, `standby1..standby2`), trasferisce token, abilita i nodi, vota i leader
3. `miner1..miner5` — leader set iniziale
4. `standby1..standby2` — pool di standby (ordinamento canonico per nome li mette dopo i miner)

## Porte host

| Servizio  | HTTP  | P2P   |
|-----------|-------|-------|
| bootstrap | 3201  | 6201  |
| miner1    | 3202  | 6202  |
| miner2    | 3203  | 6203  |
| miner3    | 3204  | 6204  |
| miner4    | 3205  | 6205  |
| miner5    | 3206  | 6206  |
| standby1  | 3207  | 6207  |
| standby2  | 3208  | 6208  |

## Comandi utili

```bash
# Altezza corrente
watch -n 1 'curl -s http://localhost:3201/count'

# Stato consensus (leader health, quorum, possBlocks)
curl -s http://localhost:3201/consensus | jq

# Hash cross-node determinismo
curl -s http://localhost:3201/debug/statehash | jq '.stateHash'
curl -s http://localhost:3202/debug/statehash | jq '.stateHash'

# Peer list
curl -s http://localhost:3201/peers

# Schedule corrente
curl -s http://localhost:3201/schedule | jq
```

## Matrice drill G1–G12

| Id | Scenario | Comando esemplificativo | Atteso |
|----|----------|------------------------|--------|
| G1 | 1 leader down 60 blocchi | `docker stop avalon-drills-miner5` per 60s | catena continua, `skips` corretto, nessun jail |
| G2 | 1 leader down 200 blocchi | `docker stop avalon-drills-miner5` per ~600s | jailed dopo 30 turni, `E=4/q=4`, nessun halt |
| G3 | 2 leader down 400 blocchi | `docker stop avalon-drills-miner4 avalon-drills-miner5` | jailed, `E=3/q=3`, catena continua |
| G4 | Top-5 down, standby entra (Layer H) | `docker stop avalon-drills-miner5` per >30 turni | `standby1` entra al prossimo epoch, produce a 3s |
| G5 | Partizione 3/2 per 100 blocchi | isolare 2 nodi dalla rete Docker | maggioranza finalizza, minoranza resync |
| G6 | Clock skew ±5s su due nodi | `docker exec ... date -s ...` | blocchi in pending, poi accettati, nessun ban |
| G7 | Equivocazione | due `/mineBlock` quasi contemporanei | rank deterministico sceglie un blocco, no fork |
| G8 | Force-finalize con viste asimmetriche | kill/restart rapido | fetch path converge, no halt |
| G9 | Nodo vecchio durante S1/H1 | avviare tag `v2.0.x` | S1: segue; H1: stalla e resync, mai fork |
| G10 | Tutti i 5 leader down | `docker stop avalon-drills-miner{1..5}` | halt deterministico, no fork |
| G11 | 2 leader killed nello stesso round | `docker kill` due miner | dopo ~21s haltBreaker, recovery round con unanimità 3/3 |
| G12 | 2 leader killed, HALT_BREAKER=0 | come G11 con env off | halt deterministico, restart di uno riprende |

## Fermare tutto

```bash
docker compose -p avalon-drills \
  -f docker-compose.yml \
  -f docker-compose.drills.yml down -v
```

## Note

- Layer S/H è attivo dal blocco **100** (`patch-config-testnet.js`).
- `ADMIN_ALLOW_ANONYMOUS=1` permette `/mineBlock` senza token solo in locale.
- Lo stato `leaderHealth` è ricostruibile dai blocchi; `/consensus` lo espone in tempo reale.

## Esiti drill (run 2026-11-03/04 — matrice completa)

Testnet ricostruita da genesis con **2 standby** e i fix sotto, poi matrice G1–G12.

| Drill | Esito | Note |
|-------|-------|------|
| G1  | PASS | 1 leader giù 60 blocchi, catena continua, `skips` corretto, statehash ok |
| G2  | PASS | 1 leader in jail dopo 30 turni, `E=4`, statehash coincide |
| G3  | PASS | 2 leader in jail, esclusi dall'eligible, catena continua |
| G4  | PASS | `standby1` promosso nell'`activeLeaderSet` all'epoch successivo |
| G5  | PASS | partizione 3/2: la maggioranza finalizza, la minoranza risincronizza |
| G6  | PASS | clock skew ±5s via **libfaketime** (host clock intatto) |
| G7  | PASS | equivocazione: rank deterministico, la catena converge |
| G8  | PASS | force-finalize con viste asimmetriche: converge, nessun halt |
| G9  | PASS | nodo `v2.0.3` (script nuovo): mai un blocco divergente |
| G10 | PASS | tutti i leader giù → la catena **riprende**, nessun fork |
| G11 | PASS | halt breaker: 2 leader uccisi, recovery round, statehash coincide |
| G12 | PASS | breaker off: halt deterministico, il restart riprende |

**Risultato: 12/12 PASS, 0 FAIL.**

### Fix applicati

- **`leaderMaxVotes` 7 → 8** (`patch-config-testnet.js`). Il master auto-approva
  sé stesso (`approves: ["dtube","miner1"…"standby1"]`), quindi con 7 slot
  `standby2` non riceveva `node_appr` e la testnet aveva **un solo standby**.
- **F2 — `eligibleLeaders()` derivato dalla catena** (`src/consensus.js`). Prima
  usava `activeLeaders()`, che scorre i `recentBlocks` **locali** e può differire
  di un blocco tra nodi: la soglia di quorum risultava diversa (q=3 su un nodo,
  q=4 su un altro) e un gruppo finalizzava un blocco che l'altro ancora
  richiedeva → fork permanente dopo un halt totale. Ora la base è
  `chain.activeLeaderSet()` (rotazione identica su ogni nodo).
  **Attenzione genesis:** la rotazione va usata **solo dopo** che il master è
  uscito dallo schedule. Durante il bootstrap il master è lo scheduled leader e
  deve restare eleggibile, altrimenti la chain fresca si blocca al primo epoch
  dopo il voto dei miner (lo schedule "master" non può rigenerarsi perché il
  blocco che lo rigenererebbe è quello bloccato). Il fix è quindi condizionale:
  finché `chain.schedule.shuffle` contiene il master si usa il comportamento
  storico, poi la rotazione deterministica.
- **`/debug/statehash` deterministico** (`src/http/debug/index.js`). Hashava i
  contatori cumulativi di `leaderHealth` (`produced`/`missed`, dipendenti dalla
  finestra di rebuild locale: 641 vs 456) **e** `consensus.activeLeaders()`
  (vista locale) → falsi positivi di divergenza a blocchi identici. Ora hash-a
  solo i campi rilevanti al consenso, con nomi ordinati, e le due liste derivano
  dalla catena (`activeLeaderSet()`).
- **Retry della connessione MongoDB** (`src/mongo.js`). Un nodo riavviato insieme
  a MongoDB (resume coordinato / flag day) raggiungeva `init()` prima che mongo
  fosse pronto e faceva `process.exit(1)`: metà rete crashava ad ogni restart.
  Ora ritenta con backoff (30 × 2 s) prima di arrendersi.
- **Flag effettivo `haltBreaker`** (`src/http/consensus/index.js`). `/consensus`
  riportava `config.haltBreaker`, non l'override per-nodo `HALT_BREAKER=0`; ora
  riporta il valore realmente in vigore (necessario per la G12).
- **Guard anti-crash in `consensus.round()`** (`src/consensus.js`). Un
  `NEW_BLOCK` malformato (senza `hash`) arrivava fino a
  `block.hash.substr(...)` e lanciava `TypeError: Cannot read properties of
  undefined (reading 'substr')`: il nodo moriva e, via relay P2P, cadeva **metà
  rete** a metà drill. Ora un blocco senza `hash` valido viene rifiutato.
- **`keepAlive` a prova di eccezione** (`src/p2p.js`). È una catena async che si
  ri-schedula **alla fine**; un'eccezione nel mezzo la rompeva e il nodo non si
  riconnetteva **mai più** ai PEERS → miner con **0 peer** dopo un restart
  totale (bootstrap incluso) → stallo. Inoltre saltava il peer se il
  `dns.lookup` falliva. Ora il corpo è in `try/catch` con ri-schedulazione in
  `finally`, e in caso di DNS fallito tenta comunque la connessione. Validato:
  dopo un restart di tutti i nodi i peer tornano entro ~25 s.
- **Suite idempotente — `settle_testnet`** (`lib.sh` + `run-all-drills.sh`).
  Prima di ogni drill riavvia i container rimasti fermi e aspetta che la catena
  avanzi di nuovo. Senza questo, un drill interrotto lasciava un nodo giù e
  faceva fallire a cascata tutti i successivi ("not running" / "chain did not
  produce"). Con il settle la suite completa è **11/11 PASS** in un solo run.
- **Harness**: assert di G3/G4 robusti al quoting di Node (apici singoli);
  `verify_statehash_match` ora usa come check **autorevole** l'hash del blocco a
  un'altezza comune (`verify_chain_agreement`, alignment-free) e lo statehash
  derivato solo come **warning** (diverge transitoriamente dopo restart/partizione
  senza essere un fork); nuovo **`G9-old-node.sh`** (build/cache dell'immagine
  `v2.0.3` + invariante no-fork).
- **G6 con libfaketime** (`Dockerfile` + `docker-compose.drills-clock-skew.yml` +
  `G6-clock-skew.sh`). `cap_add: [SYS_TIME]` + `date -s` **non** è sicuro: i
  container condividono l'orologio del kernel host, quindi `date -s` sposterebbe
  l'orologio **dell'host**. libfaketime sfasа solo il processo node
  (`LD_PRELOAD`, `FAKETIME=±5s`), host intatto.

### Nota di topologia

Con `NO_DISCOVERY=1` i miner si collegano tutti al **bootstrap** (hub): ogni
nodo ha **1 peer** (il bootstrap), che ha 7 peer. È il comportamento atteso, non
una mancanza di connettività. Un restart del **solo bootstrap** lascia i miner
con 0 peer finché non si riconnettono (ora garantito dal fix `keepAlive`).

## Checklist operatore — lancio testnet pubblica (copia per ogni lancio)

Riferimenti: guida [`doc/public-testnet.md`](../../doc/public-testnet.md), matrice
drill sopra, runbook mainnet `doc/mainnet-deployment-and-rollback.md`.

### Coordinator — prima di annunciare

- [ ] Tag **congelato e pushato**: `v2.1.0`; su ogni macchina operatore
      `git describe --tags` = `v2.1.0`.
- [ ] Config patch testnet scritta e pubblicata **come `git diff src/config.js`**:
      `originHash` **dedicato**, `block0ts`, `masterPub`/`masterPubLeader` freschi,
      `masterDaoTxs`, `leaderMaxVotes: 8`, `masterLeaderUntil: 0`, Layer S/H attivo
      a un'altezza bassa (es. 100).
- [ ] Patch ri-verificata **byte-for-byte** da una seconda persona.
- [ ] Genesis provato su una macchina usa-e-getta: `db.dropDatabase()`, **niente**
      `genesis.zip`, la catena supera `#0`.
- [ ] Chiave privata del master messa al sicuro; **solo chiavi testnet**.
- [ ] Peer list + endpoint bootstrap (`ws://<ip>:6001`) pronti da pubblicare.
- [ ] Data/altezza di lancio e checkpoint decisi; messaggio pinnato scritto.

### Ogni operatore — prima del lancio

- [ ] Node.js ≥ 24, MongoDB attivo, **NTP/chrony attivo** (`maxDrift` = 200 ms).
- [ ] Porta P2P (6001) **raggiungibile da internet**; porta HTTP secondo policy.
- [ ] Coppia di chiavi **testnet** nuova (`node src/cli.js keypair`); mai chiavi mainnet.
- [ ] `git checkout v2.1.0` + `npm ci`; `git diff src/config.js` **identico** alla patch del coordinator.
- [ ] Avvio pulito: `db.dropDatabase()`, niente `genesis.zip`, `blocks/` vuota.
- [ ] Env: `HTTP_HOST=0.0.0.0`, `CORS_ORIGIN`, `TRUST_PROXY`, `ADMIN_TOKEN`/`LOG_ADMIN_TOKEN`,
      `PEERS=ws://<bootstrap>:6001`, `NODE_OWNER*`.
- [ ] `NO_DISCOVERY` **non** impostato (rete pubblica); pubblica il proprio
      endpoint con `profile … '{"node":{"ws":"ws://<ip>:6001"}}'`.

### Giorno del lancio — checkpoint

- [ ] `curl /version` → `{"version":"2.1.0"}` **identico su ogni nodo** (census).
- [ ] `curl /count` monotono; `curl /peers` mostra peer di entità indipendenti.
- [ ] `grep -c "Different chain id, disconnecting"` = **0**.
- [ ] `grep -c "Hard Fork #13330000"` = **0**.
- [ ] Ogni operatore posta `version` / `count` / `peers` sul canale.

### Drill da girare **sulla rete pubblica** (è la ragione per cui esiste)

- [ ] **Discovery**: ferma brevemente il bootstrap del coordinator → gli altri nodi
      si ri-scoprono e restano su **una sola** catena? (i drill locali **non** coprono
      questo path: girano con `NO_DISCOVERY=1`).
- [ ] Leader offline ~100 blocchi; clock skew (NTP spento su un nodo); partizione 3/2;
      collisione (due `/mineBlock`); tutti-i-leader-giù con recupero.
- [ ] Dopo **ogni** drill: tutti i nodi d'accordo su `count` e hash dei blocchi.

### Se qualcosa si rompe

- [ ] **Halt, don't fork**: fermati, raccogli i log, coordina sul canale.
- [ ] Rollback: stop → commit precedente → ripristina lo snapshot Mongo +
      `blocks.bson` pre-modifica.

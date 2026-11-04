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

## Esiti drill (run 2026-11-03/04)

Testnet ricostruita con **2 standby** (vedi fix sotto), poi matrice G1–G12.

| Drill | Esito | Note |
|-------|-------|------|
| G1  | PASS | 1 leader giù 60 blocchi, catena continua, `skips` corretto |
| G2  | PASS | 1 leader in jail dopo 30 turni, `E=4`, statehash coincide |
| G3  | PASS | 2 leader in jail, catena continua, statehash coincide |
| G4  | PASS | `standby1` promosso nell'`activeLeaderSet` al primo epoch |
| G5  | PASS | (run precedente) partizione 3/2, resync, nessun fork |
| G6  | SKIP | serve `CAP_SYS_TIME`: il container non può spostare l'orologio |
| G7  | PASS | (run precedente) equivocazione, rank deterministico |
| G8  | PASS | (run precedente) force-finalize con viste asimmetriche |
| G9  | PASS | **automatizzato** (nuovo): nodo `v2.0.3` segue e non forka mai |
| G10 | **FAIL** | catena ferma→riprende, ma un nodo ritardatario resta su un fork |
| G11 | PASS | halt breaker: 2 leader uccisi, recovery, statehash coincide |
| G12 | non eseguito | richiede l'overlay `docker-compose.drills-halt-breaker-off.yml` |

### Fix applicati

- **`leaderMaxVotes` 7 → 8** (`patch-config-testnet.js`). Il master auto-approva
  sé stesso (`approves: ["dtube","miner1"…"standby1"]`), quindi con 7 slot
  `standby2` non riceveva `node_appr` e la testnet aveva **un solo standby**.
- **F2 — `eligibleLeaders()` derivato dalla catena** (`src/consensus.js`). Prima
  usava `activeLeaders()`, che scorre i `recentBlocks` **locali** e può differire
  di un blocco tra nodi: la soglia di quorum risultava diversa (q=3 su un nodo,
  q=4 su un altro) e un gruppo finalizzava un blocco che l'altro ancora
  richiedeva → fork permanente dopo un halt totale. Ora la base è
  `chain.activeLeaderSet()` (rotazione identica su ogni nodo). Con il fix la
  G10 **riprende** correttamente.
- **`/debug/statehash` normalizzato** (`src/http/debug/index.js`). Hashava i
  contatori cumulativi di `leaderHealth` (`produced`/`missed`), che dipendono
  dalla finestra di rebuild locale (es. 641 vs 456) → falsi positivi di
  divergenza a blocchi identici. Ora hash-a solo i campi rilevanti al consenso
  (`streak`, `absent`, `lastScheduledTurn`, `jailed`, …), con chiavi ordinate.
- **Harness drill**: assert di G4/G3 robusti al quoting di Node (apici singoli);
  `verify_statehash_match` più paziente (retry ~3 min) perché subito dopo un
  restart di massa lo stato derivato converge in decine di secondi.

### Limite noto aperto (G10)

G10 resta **rosso** e non è un problema di harness: dopo "tutti giù → restart",
un nodo ritardatario può restare su un blocco diverso e non risincronizzare
(`invalid phash` in `recover()`). È la precondizione documentata in
`doc/consensus-offline-leaders-plan.en.md` §9.1 e
`doc/consensus-single-quorum-and-locks.en.md` §1.3/§4.2: **non c'è ancora la
regola "un solo candidato per `(height, phase)` per firmatario" (single-vote)**,
quindi due candidati allo stesso altezza possono ciascuno raggiungere il quorum
su insiemi disgiunti. Va implementata prima di considerare Layer S/H spedibile.

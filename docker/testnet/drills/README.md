# Layer S/H Drill Scripts

Script di automazione per la matrice G1–G12 del piano
`doc/consensus-offline-leaders-plan.en.md`.

## Prerequisito

Il testnet drills deve essere attivo:

```bash
cd docker/testnet
docker compose -p avalon-drills \
  -f docker-compose.yml \
  -f docker-compose.drills.yml up -d --build
```

## Uso

Esegui uno script singolo:

```bash
cd docker/testnet/drills
bash G1-one-leader-down-60-blocks.sh
```

Oppure la suite rapida:

```bash
bash run-all-drills.sh
```

Per includere anche i drill lunghi (jail, standby promotion):

```bash
bash run-all-drills.sh --long
```

## Script disponibili

| Script | Drill | Durata tipica | Note |
|--------|-------|---------------|------|
| `G1-one-leader-down-60-blocks.sh` | G1 | ~2 min | |
| `G2-one-leader-jailed.sh` | G2 | ~10 min | aspetta 30 turni mancati |
| `G3-two-leaders-jailed.sh` | G3 | ~15 min | |
| `G4-standby-promotion.sh` | G4 | ~12 min | Layer H |
| `G5-network-partition.sh` | G5 | ~3 min | disconnette 2 nodi dalla rete Docker |
| `G6-clock-skew.sh` | G6 | variabile | richiede container privilegiato, altrimenti SKIP |
| `G7-equivocation.sh` | G7 | ~1 min | due `/mineBlock` concorrenti via docker exec |
| `G8-force-finalize-asymmetric.sh` | G8 | ~2 min | kill + restart nodo |
| `G10-all-leaders-down.sh` | G10 | ~2 min | halt deterministico |
| `G11-halt-breaker-recovery.sh` | G11 | ~2 min | recovery round automatico |
| `G12-halt-breaker-off.sh` | G12 | ~2 min | richiede testnet avviato con `docker-compose.drills-halt-breaker-off.yml` |

G9 (nodo vecchio) non è automatizzato perché richiede un'immagine/container della
versione `v2.0.x`; va eseguito manualmente.

## Implementazione

I drill non si appoggiano alle porte host del testnet: usano `docker exec` per
chiamare le API HTTP interne su `localhost:3001` di ciascun container.  Questo
rende gli script robusti anche quando Docker Compose non supporta il tag YAML
`!reset` per le liste di porte.

## Uscita

Ogni script stampa `[PASS]` o `[FAIL]` e ripristina lo stato dei container in
`trap EXIT`.

## Correzioni e limiti noti (run 2026-11-03)

Bug di codice trovati eseguendo i drill su `avalon-drills` (ora corretti):

* **Auto-jail di ogni leader (bloccante).** Le tx `enable-node` del setup fanno
  scattare la regola heartbeat, che marcava *ogni* leader `probation`; il primo
  blocco prodotto da ciascuno lo ri-mandava in jail (`recordProduced`), la
  rotazione collassava sugli standby e poi su un set vuoto →
  `schedule.shuffle[...] is undefined` → crash di tutti i nodi. `heartbeat` ora
  arma la `probation` solo per un account davvero in jail, e `recordProduced`
  chiude la probation in ACTIVE (design §6.2).
* **Halt breaker mai armabile.** `_resolveForceFinalize` azzerava `ffProposals`
  subito prima di chiamare `runHaltBreaker()`, che quindi vedeva sempre
  `0/5 respondents` e non poteva mai sparare. Ora `ffProposals` è preservato.

Bug di harness (corretti): G1 verificava lo statehash del nodo che aveva appena
fermato; G10 confrontava l'altezza con quella pre-stop (i blocchi prodotti
durante lo stop contavano come "avanzamento"); G2/G3/G4/G11 verificavano subito
dopo il restart, prima del catch-up (nuovo helper `wait_node_synced`).

Altri bug di codice trovati e corretti:

* **Resume dopo un arresto totale.** Un nodo che riparte non tentava mai di
  produrre (`minerWorker` era chiamato solo da `addBlock`) e, quando ci provava,
  il guard "slow performance" cedeva lo slot perché l'head era vecchio. Ora:
  1) `main.js` fa un kick di `minerWorker` al boot; 2) `minerWorker` produce
  comunque se l'head è vecchio (chain ferma); 3) la proposta FF viene
  ri-trasmessa dal halt breaker a ogni tentativo, e si contano solo i
  `respondents` *recenti* (i voti dei nodi morti scadono) — prima si azzerava
  `ffProposals` e si vedevano sempre 0 voti.

**Verificato:** G10 ora ferma la chain con tutti giù e **riprende** quando i
leader tornano. Per ripartire serve **almeno un produttore autorizzato** (lo
scheduled di `head+1` o un backup recente) tra i riavviati: riavviare l'intero
set è la scelta sicura.

G12 (breaker OFF) è riformulato su **3 leader giù**: con 2 giù il quorum
adattivo recupera da solo (`E=3, q=3`), quindi non c'è halt da osservare.

`verify_statehash_match` ora allinea le altezze prima di confrontare: su una
chain viva una lettura ingenua sembra una divergenza (un nodo a `h`, l'altro a
`h+1`) — solo un mismatch **a parità di altezza** è reale.

**G5 (partizione) — risolto.** Il resync dopo la riunione falliva per tre cause,
ora corrette:

1. `keepAlive` considerava connesso qualsiasi socket con IP/porta corrispondenti
   anche se **morto** (half-open lasciato da `docker network disconnect`), e
   andava in errore su un `_socket` nullo → non riconnetteva mai. Ora richiede
   `readyState === OPEN` e chiude i socket che non rispondono ai probe di stato
   entro 20 s.
2. lo `node_status` dei peer era uno snapshot dell'handshake **mai aggiornato** e
   veniva sovrascritto dal handler di `QUERY_NODE_STATUS` → `refresh()`/`recover()`
   confrontavano teste stantie e non vedevano il gap. Ora c'è un refresh
   periodico (5 s) e il `node_status` è preservato.
3. `refresh()` recuperava solo con un gap **> 10** blocchi; ora recupera anche con
   un gap piccolo se l'head è fermo (**stalled**).

Inoltre `/debug/statehash` non include più `possBlocks` (gossip transitorio che
faceva sembrare divergenti nodi sani), e `tryNextStep` non moltiplica più i timer
(era un hot-loop che bloccava l'event loop durante uno stallo).

**Stato dei drill su questa build: G1, G5, G7, G8, G10, G11 tutti PASS.**
G2/G3/G4 (jail/standby, 10–15 min), G6 (clock skew) e G12 (richiede l'overlay
breaker-off) non eseguiti in questa sessione.

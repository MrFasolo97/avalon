# Avalon Testnet — Force Finalization Test

Testnet multi-nodo per testare il meccanismo di **force finalization** in caso di blocchi concorrenti alla stessa altezza.

## Requisiti

- Docker + Docker Compose v2

## Avvio

```bash
cd docker/testnet

# Build le immagini
docker compose build

# Avvia tutti i nodi
docker compose up -d

# Segui i log
docker compose logs -f
```

L'avvio automatico:
1. **bootstrap** — crea la rete da zero (genesi, blocco 0, mina i primi blocchi)
2. **setup** — genera 3 chiavi miner, crea gli account, trasferisce token, abilita i nodi, vota i leader
3. **miner1..3** — si sincronizzano con bootstrap e iniziano a minare

## Architettura

| Servizio | HTTP (host) | P2P (host) | Account |
|----------|-------------|------------|---------|
| bootstrap | `:3101` | `:6101` | dtube (master) |
| miner1 | `:3102` | `:6102` | miner1 |
| miner2 | `:3103` | `:6103` | miner2 |
| miner3 | `:3104` | `:6104` | miner3 |

Tutti i nodi sono sulla stessa rete Docker e si scoprono via `PEERS=ws://bootstrap:6001`.

## Isolamento della chain (chain id)

Questo dev net è **locale**: usa `NO_DISCOVERY=1` e si connette solo a `ws://bootstrap:6001`,
quindi non parla con la mainnet per costruzione. Nessuna porta P2P va esposta su internet.

Sulla chain id (`originHash` in `src/config.js`) questo dev net **non** la sovrascrive a runtime:

- sul branch `testnet/public` `originHash` è già quella della testnet pubblica → isolato;
- sulla linea di release/mainnet il dev net eredita l'`originHash` della mainnet, ed è
  **voluto**: la prova di migrazione S4 (`doc/testnet-migration-test.en.md`) cambia versione di
  codice mantenendo la chain, quindi la chain id deve restare stabile tra le due versioni.
  Cambiarla romperebbe la continuità del test (il nodo fallisce con
  `Block #0 hash doesn't match config`). Tenerlo locale è sufficiente.

## Testare la Force Finalization

### Scenario: blocchi concorrenti

Per simulare un conflitto (due leader minano blocchi diversi alla stessa altezza):

```bash
# In due terminali diversi, esegui quasi contemporaneamente:
curl http://localhost:3102/mineBlock   # miner1 forza un blocco
curl http://localhost:3103/mineBlock   # miner2 forza un blocco
```

Se i due `/mineBlock` partono allo stesso micro-intervallo, entrambi i minatori
producono un blocco valido per la stessa altezza N. I nodi della rete li
inseriscono entrambi in `possBlocks[]` e votano. Se nessuno raggiunge 2/3,
dopo ~27 secondi (5 leader × 3s + 2 round × 3s + margine) scatta la
**force finalization**: ogni nodo sceglie deterministicamente il vincitore
(timestamp più basso → hash più basso) e lo finalizza, sbloccando la catena.

### Verifica

```bash
# Monitora l'altezza della catena
watch -n 1 'curl -s http://localhost:3101/count'

# Vedi il log della force finalization
docker compose logs bootstrap | grep -i "force\|collision"

# Dopo un conflitto, controlla che la catena continui ad avanzare
while true; do
  h=$(curl -s http://localhost:3101/count)
  echo "Block #$h  $(date)"
  sleep 2
done
```

### Per fermare tutto

```bash
docker compose down -v
```

## Config

Le variabili d'ambiente principali sono in `docker-compose.yml`. Le chiavi
generate vengono salvate in un volume condiviso `testnet_config` letto da
tutti i miner.

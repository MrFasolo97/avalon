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

| Servizio | HTTP | P2P | Account |
|----------|------|-----|---------|
| bootstrap | `:3001` | `:6001` | dtube (master) |
| miner1 | `:3002` | `:6002` | miner1 |
| miner2 | `:3003` | `:6003` | miner2 |
| miner3 | `:3004` | `:6004` | miner3 |

Tutti i nodi sono sulla stessa rete Docker e si scoprono via `PEERS=ws://bootstrap:6001`.

## Testare la Force Finalization

### Scenario: blocchi concorrenti

Per simulare un conflitto (due leader minano blocchi diversi alla stessa altezza):

```bash
# In due terminali diversi, esegui quasi contemporaneamente:
curl http://localhost:3002/mineBlock   # miner1 forza un blocco
curl http://localhost:3003/mineBlock   # miner2 forza un blocco
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
watch -n 1 'curl -s http://localhost:3001/count'

# Vedi il log della force finalization
docker compose logs bootstrap | grep -i "force\|collision"

# Dopo un conflitto, controlla che la catena continui ad avanzare
while true; do
  h=$(curl -s http://localhost:3001/count)
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

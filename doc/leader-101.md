# Avalon Leader 101

## Enabling your node for block production

If you want to start producing blocks on avalon, your account will need to define a leader key. Generate one into a file with `node src/cli key > leader-key.json`

Secondly, you will need to enter your username, public leader key, and private leader key at the bottom of the `scripts/start.sh` file, and restart your node.

Finally, you will need to associate your public leader key with your account by using the on-chain transaction.
```bash
node src/cli enable-node YOUR_LEADER_PUB_KEY -M YOUR_USERNAME -K YOUR_KEY
```
This transaction must be signed with your master key, or a custom key that allows this transaction. Once this step is done, you can head to the [leader election page](https://d.tube/#!/election) and vote yourself. If your leader key is properly associated to your account, you should see yourself uncrossed.

Once enough votes for your account come in, and you reach the top leaders, your node will start regularly mining blocks.

## Auto-peer discovery
Avalon has a peer-discovery mechanism turned on by default. Elected leaders can declare a **public node** IP in their JSON profile, which will create a lot of incoming peers for this node.

```bash
node src/cli.js profile -K <key> -M <user> '{"node":{"ws":"ws://yourip:yourport"}}'
```

Make sure to have `MAX_PEERS` set to a high number (50+ recommended). The network needs a few of those public nodes, but it is strongly discouraged to produce blocks from a publicly declared node IP.

## Do a video to announce your leader node
You will need to get a lot of votes from the stake holders in order to produce blocks. A good idea for new leaders is to create a video to explain who they are, and why they run an Avalon node, and why they want to be elected. Most of the elected leaders have went through this process, and it's an easy way to gather organic votes at the beggining.

## Soft jail, absence accounting and standbys (Layer S/H)

A node that stops answering must not freeze the chain. This is what the Layer S/H
machinery does, and it changes **nothing** about your balance, stake or keys — it only
affects *eligibility*.

* **Skip attestation.** A backup that produces a block records in the block which
  scheduled leaders it skipped (`skips`, kept compatible with the legacy `missedBy`).
  Absence is therefore *proven on-chain*: nobody can mark you absent with an unsigned
  message, only a finalised block can.
* **Soft jail.** After `jailMissThreshold` (30) consecutive proven missed turns
  (~9 minutes) an account leaves the quorum denominator and the rotation. The jail
  expires on its own after `jailBlocks` (200 blocks, ~12 minutes), doubling on every
  re-jail (200/400/800) to stop a flapping node from ping-ponging with its standby.
* **No slashing, no permanent removal.** Jailing touches neither `balance`, `node_appr`
  nor keys. Permanent retirement is still the governance `DISAPPROVE_NODE_OWNER` vote.
* **Standbys (Layer H).** The rotation is the top `L` accounts by `node_appr` minus
  jailed ones; the next accounts are the *standby pool*. When a leader is jailed, the
  next standby takes its slot in the rotation at the following epoch.

### Waking your node up early (heartbeat)

If your node was jailed but is healthy again, don't wait for the automatic expiry —
send a heartbeat. It re-sends `ENABLE_NODE` (type 18) with your account's **current**
leader key: idempotent, zero fee, no balance/approval change. New nodes clear the jail
as soon as the transaction is in a finalised block; old nodes execute it exactly as
today.

```bash
# looks up the current leader key on-chain and re-sends it
node scripts/heartbeat.js -M YOUR_USERNAME -K YOUR_KEY
# or with a key file and a specific node
node scripts/heartbeat.js -M YOUR_USERNAME -F key.json -A http://localhost:3001
```

The key must be authorised for transaction type 18 on the account (the leader key
usually is; otherwise send it from the account owner's wallet). If you lost the key,
do nothing: the jail expires by itself after `jailBlocks`.

### Checking status

```bash
curl -s http://localhost:3001/consensus | jq   # leader health, eligible set, quorum, your possBlocks
curl -s http://localhost:3001/schedule  | jq   # shuffle + set/standbys (± jailed)
curl -s http://localhost:3001/leader/YOUR_USERNAME | jq '.jailed, .jailUntil, .streak'
```

`/debug/statehash` returns a hash of the derived state (head, recent blocks, eligible
set, leader health, schedule). It must be **identical on every node**; a difference is
the first sign of a divergence and should be reported before doing anything else.

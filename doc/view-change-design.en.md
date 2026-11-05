# View-change / round election — design (for the single-vote invariant)

**Status:** design (not implemented). Companion to
[`consensus-single-quorum-and-locks.en.md`](./consensus-single-quorum-and-locks.en.md) §7.
**Goal:** make strict single-vote (INV-1) compatible with halt/liveness recovery, so
the `CONSENSUS_SINGLE_VOTE` gate can become the default.

## 1. Why the gate cannot just be switched on

The gate (see the companion doc §7) lets a node vote once per `(height, phase)`. That
works in the happy path and on collisions (G1/G7/G8 pass) but **not on halt
recovery**: when the scheduled leader is down, a backup must be able to propose *the
same height*, and under latency two backups can both propose. Nodes then precommit
different "best" candidates and, forbidden from moving, can no longer converge —
G10/G11 stall.

The root cause is that Avalon has **no explicit rounds**. The "ladder" (scheduled
leader + recent producers) gives backup *slots* by wall-clock timing, but a vote is
keyed only by `(height, phase)`. A correct single-vote protocol keys the vote by
`(height, round, phase)` and changes the **round** when the current proposer is
silent — that is the missing view-change.

## 2. The model (smallest change that fits Avalon)

Keep blocks, hashes, signatures and the ladder. Add an explicit, **chain-derived**
round number per height.

- **Round / view `r`**: `r = position of the proposer in leaderLadder(h)`. `r = 0` is
  the scheduled leader; `r = 1, 2, …` are the backups, in the same deterministic
  order the ladder already defines. Every node computes the same ladder from chain
  data, so it computes the same `r` for the same proposer.
- **Proposer of round `r`** = `leaderLadder(h)[r]`. Exactly one proposer per round.
- **Round timing** (deterministic, chain-time based, not local):
  `dueAt(h, r) = block.timestamp + (r + 1) · blockTime` (+ the existing
  `skipGraceMs` for `r ≥ 1`). A node only proposes in its round, at `dueAt(h, r)`.
  This replaces the current "everyone in the ladder may fire when the head is old".
- **Votes** are keyed by `(height, round, phase)`. A node emits **at most one**
  precommit and **at most one** commit per `(height, round)` — INV-1 per round, which
  is the standard BFT invariant (one vote per height **per view**).
- **Lock:** when a node precommits `h#A` in round `r`, it sets `lock[h] = A`. In a
  later round `r' > r` it may precommit a **different** block `B` only if `B` carries
  a **precommit QC** for an earlier round (i.e. `B` is "more justified" than `A`).
  Otherwise it re-precommits `A` (or abstains). Commits always follow the node's own
  precommit for that round.

## 3. Safety (one page)

- **INV-1′ (per round):** for any node and any `(h, r)`, it emits at most one
  commit hash. With a chain-derived `eligible(h)`, a round-`r` commit QC needs
  `q = floor(2n/3)+1` distinct signers.
- **Lemma:** two different hashes cannot both get a commit QC **in the same round**
  (quorum intersection + INV-1′, same argument as the companion doc §2.3).
- **Cross-round:** because a later round's block must carry a previous round's
  precommit QC and the lock only moves to a strictly better-justified block, two
  different commit QCs at a height would require two quorums whose signers voted
  once in a round but locked incompatibly — excluded by the lock rule (this is the
  standard Tendermint lock/unlock argument, specialised to a static proposer list).
- **Liveness:** if the round-`r` proposer is silent, `dueAt(h, r+1)` opens round
  `r+1` and `leaderLadder(h)[r+1]` proposes. No wall-clock decision, no local
  liveness probe — the round is a function of block time and the ladder.

## 4. What changes in the code

| Area | Change |
|---|---|
| `src/consensusQuorum.js` | `voteKey(h, r, phase)` with an explicit `round`; `recordVote` keyed by `(h, r, phase)`; `lock` per `(h)` with the "justified by a previous QC" rule; `hasQC`/`qcHash` take the round. |
| `src/consensus.js` | compute `roundFor(height, miner)` from `leaderLadder`; `round(phase, block)` passes the round; `castVote` uses `(h, r, phase)`; the lock check reads the previous round's QC. |
| `src/chain.js` | `minerWorker` proposes only in its round at `dueAt(h, r)` (already close: the ladder timing becomes the round timing); the "halt stagger" is subsumed by `dueAt`. |
| `src/p2p.js` | consensus messages (`t:6`) already carry `h` (S0′); add the round so the receiver validates `(h, r, phase)`. |
| block format | **unchanged** — the round is derived, not stored. No flag day on the block hash. |
| activation | height-gated `config.history` entry (a flag day), opt-in via `CONSENSUS_SINGLE_VOTE=1` until the drills are green. |

## 5. Tests and drills (acceptance)

- Unit: `voteKey`/`recordVote` per round; lock refuses a competing precommit unless a
  previous-round QC justifies it; two commit QCs impossible (property test across
  rounds); round derivation from the ladder; `dueAt` staggering.
- Drills: **G1–G12 all green with the gate ON**, in particular:
  - **G10** (all leaders down): the backups take the round and the chain resumes;
  - **G11** (halt breaker): unchanged, it already votes the deterministic best with
    unanimity;
  - **G7/G8** (collision / asymmetric view): the round ordering resolves them
    without a vote split.
- Soak: random 0–3 leaders offline, random restarts, assert identical `/debug/statehash`.

## 6. Why this is a design, not a patch

It changes the vote key in the safety-critical path, adds a lock/unlock rule, and
must keep the **current, working** protocol (gate OFF) bit-identical. That is a
consensus change that needs its own flag day, a full drill pass and a soak — not a
hasty edit. This document is the concrete plan to do it safely; the gate stays
opt-in/default-off until then.

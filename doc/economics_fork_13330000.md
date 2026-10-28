# Economics hard fork #13330000 - supply-anchored pool, vote rate cap, pow determinism

Single hard fork gated at block `13330000`; every change only activates from that height.
Branch: `new_econs` - commit `46c77ff` (base: `feat/auto-force-finalize`).
Diff: 6 files, +432 / -10.

## What this fork does (summary)

1. Sizes the 8h reward pool as a percentage of total supply instead of a frozen constant.
2. Caps the DTC payout of a single vote, proportional to network activity over a reference
   window, so one account can no longer drain an idle network's whole pool.
3. Replaces `Math.pow` with exact integer arithmetic (`pow10`/`ipow`) so the reward math is
   bit-for-bit identical on every node/engine.
4. Adds a consensus supply accumulator (`eco.totalSupplyUnits`) that these two pool changes
   rely on, plus persistence and self-healing.

## 1. Reward pool as % of supply

- **`src/config.js:205-208`** - new `13330000` entry in `config.history`:

  ```js
  initialSupplyBlock: 13320066,     // anchor block (frozen, measured)
  initialSupply: 572311976.600145,  // total supply (DTC) at that block
  rewardPoolYearlyRate: 0.10,       // 10%/year -> ~52,265 DTC/window vs fixed 150001
  vtReferenceTotal: 15500000        // reference activity for the rate cap
  ```

- **`src/economics.js:87-97`** - in `rewardPool()`: if `rewardPoolYearlyRate` is a number,
  `theoricalPool = round(supply_units/1000 x rate / 1095)` instead of the constant
  `rewardPoolAmount`. `1095` = windows/year (`365x24x3600x1000 / (9600x3000)`).

- **`src/economics.js:88-92`** - guard: if the `totalSupplyUnits` accumulator is not
  bootstrapped yet -> `logr.fatal` + `process.exit(1)` (never a silent fork with a wrong pool).

### Motivation

The constant `rewardPoolAmount = 150001`/window is a paper ceiling of ~28.7%/year that was
never adjusted while the network grew from ~400M to ~572M supply; real emission ran at only
~1.7%/year because activity, not the constant, bounded it. An arbitrary, stale constant is
both invisible (wrong mental model of emission) and unmaintainable (it needs manual tuning
every time supply moves). Making the pool a % of total supply:

- fees the pool to the economic size of the network, so emission is self-adjusting;
- aligns the policy number with something meaningful (10%/year target) instead of a magic
  per-window figure;
- keeps the leader stipend (9,600/window) at ~18% of a normal pool instead of an ever-
  shrinking share.

## 2. Single-vote rate cap

- **`src/economics.js:334-341`** - in `print()`: after the `floor` and before the
  `rewardPoolMaxShare` backstop:

  ```js
  thNewCoins = Math.min(thNewCoins, eco.floor(stats.theo * |vt| / vtReferenceTotal))
  ```

  Effect: one vote pays at most `pool * vt / vtReferenceTotal`. Example: 5,000 VT on a
  network with ~zero activity -> ~16.9 DTC (previously up to ~15,000).

### Motivation

Pre-fork a whale voting on a dead network still walked away with up to 10% of the whole
8h window (the `rewardPoolMaxShare` backstop only scales with `avail`, i.e. with the same
pool the whale is emptying). That is a value-extraction bug, not a curation feature: a
single account with a large accumulated `vt` could monetize inactivity. The cap makes the
payout proportional to `vt` *normalized* by a reference level of real activity
(15,500,000 VT ~= historical p90 per 8h window), so a whale earns at most what it would
earn on a reasonably busy network. Below that reference, rewards scale down linearly; above
it the old pool-splitting math still applies. This also fixes the pre-fork quirk where the
"no votes yet" branch pays a fixed 1 DTC minimum: post-fork the first vote prints dust
(~0.003 DTC), i.e. nothing worth gaming.

### No cap on account VT (deliberate)

No limit was placed on the VT (voting power) an account can hold or accrue. VT is a
time-based stake: `GrowInt` grows it continuously at `balance / vtGrowth`
(`vtGrowth = 360000000` = +1 VT/h per DTC on average; `transaction.js:257,364`,
`chain.js:771`). That mechanism is left fully untouched because:

- capping VT would change pre-existing consensus behavior on every past block (a second,
  unrelated fork), and would open a new class of side effects (splitting, timing games);
- the abuse was in the *payout*, not the VP economy. Acting on the output (`print()`)
  caps the damage exactly where it was exploitable while leaving curation incentives and
  the time-weighted stake model intact.

## 3. Numeric determinism (`pow10`/`ipow`)

- **`src/economics.js:391-401`** - two new helpers on `eco`:
  - `pow10(p)` -> exact integer `10^p` (bit-identical to `Math.pow(10,p)` for `p<=22`, but engine-independent)
  - `ipow(base, exp)` -> repeated multiplication for integer exponents
- **9 sites `Math.pow(10,*)` -> `eco.pow10(*)`** (pre-fork neutral, same bits):
  `round`/`floor` (`:405`,`:409`), `precisionMulti` (`:241`), `tipAmt` x2 (`:253`), `rentability` x2 (`:386`).
- **`src/economics.js:153-157`** - `accountPrice`: `Math.pow(5/len, 4)` is **not** bit-identical
  to `ipow` -> the swap is **fork-gated** (pre-fork `Math.pow`, post-fork `ipow`).

### Motivation

All of these functions run inside block/transaction validation and their results are part of
the chain's consensus history. `Math.pow` is libm code: correct but not guaranteed to return
the same last ULPs on every engine, architecture or optimizer. A node that computes a reward
one ULP differently would finalize a different `dist`/`burn` and split the network. For
integer powers of ten (`n <= 22`) the result is exactly representable, so a plain
multiplication loop returns the identical bits everywhere - deterministic with zero semantic
change. `accountPrice` is the one place with a fractional base (`5/len`), where `Math.pow`
is genuinely non-reproducible; there the loop is enabled only from the fork height to avoid
changing pre-fork account prices.

## 4. Supply accounting (new consensus state)

- **`src/economics.js:22`** - new `eco.totalSupplyUnits` field (integer, 1e-3 units) = total
  supply accumulated from `initialSupplyBlock`.

- **`src/chain.js:304-320`** - at the top of `chain.output()` (which runs *after* the `config`
  refresh, so it is always at `block._id`):
  - lazy bootstrap at the anchor: `eco.totalSupplyUnits = round(initialSupply x 1000)` (cold-rebuild case)
  - otherwise `+= round(dist x 1000) - round(burn x 1000)` for every block `> initialSupplyBlock`
  - `logr.fatal` if not bootstrapped at a block != anchor

- **`src/chain.js:913-940`** - `chain.scanSupply(from,to,cb)`: sums `dist - burn` over an
  inclusive range; synchronous file-store path (`blocks.readRange`), Mongo fallback
  (`_id: {$gte,$lte}`).

### Motivation

The pool sizing needs a supply value that every node derives **identically from block data**,
because it changes what is distributed. The `/supply` endpoint is a Mongo aggregation over
account balances - a denormalized view, not consensus state. The accumulator is instead built
from `block.dist`/`block.burn`, which are consensus-validated per block, so supply becomes a
deterministic function of the chain. `initialSupply` is a one-time measured snapshot frozen at
the fork config; the exponential `dist - burn` from the anchor onward is exact integer math.
The bootstrap allows fresh nodes (which replay from block 0) to reach the same value without
trusting anything: they re-derive it from the same blocks.

## 5. Persistence and restart

- **`src/cache.js:296`** - `cache.writeToDisk` saves `totalSupplyUnits` in `state` next to
  `headBlock` (on every block).

- **`src/main.js:88-90`, `109-110`** - restore from `state` in both paths (daemon and rebuild
  resume) only if `state.headBlock` matches the head (self-healing on crash).

- **`src/main.js:122-135`** - `bootstrapSupply(targetBlock, cb)`: if the value is missing from
  state or behind the head, recompute via `chain.scanSupply(anchor+1 ... targetBlock)`;
  skipped if pre-fork or already valid.

- **`src/main.js:137-146`** - `startRebuild` wrapped by `bootstrapSupply(startBlock-1, ...)`;
  the old body is now `rebuildFrom()`.

### Motivation

Without persistence every restart (and every resume of an interrupted rebuild) would re-scan
up to ~millions of blocks before a single transaction could run. Storing the accumulator next
to `headBlock` makes restart O(1) and crash-consistent: the value is written at the same time
as the head, and the restore is accepted only when the two match. Any mismatch (crash between
block append and state write, stale state) falls back to a scan, so the accumulator can never
be served stale - correctness wins over speed, and the guard in `rewardPool()` turns any
still-missing value into a loud fatal instead of a silent wrong distribution.

## 6. Governance locked out of the anchor

- **`src/config.js:241-245`** - `allowedKeys` filters out `initialSupply`/`initialSupplyBlock`
  -> **only a new fork can correct them**, never `cache.state[1]`.

### Motivation

The anchor keys define the consensus supply from which every reward is derived. If governance
(an `effectiveBlock` override) could rewrite them mid-chain, a node that applied the override
would start accumulating from a different base than nodes that never received it, and the two
chains would quietly produce different pools and split. These are not tunable parameters -
they are invariants, exactly like a key of `history`, and must therefore change only through
the same single, atomic mechanism that created them: a new fork entry.

## 7. Tests

- **`test/supply-anchor.js`** (new, 25 checks): pre/post-fork gating, pre-fork stays identical
  (`theo` = 150001, uncapped ~750 DTC whale, `votes === 0 -> 1`), pool proportional to supply,
  fatal when the accumulator is missing, rate cap (16.86 DTC post vs 750 pre, first vote ->
  dust), `pow10` == `Math.pow` bit-identical, gated `accountPrice`, source-guards on
  `chain`/`cache`/`main`, protected scope (`decayInt.js`, `validate/float.js`,
  `tippedVote.js` untouched).

## Pre-fork invariance

The 4 new keys don't exist below `13330000`; the `pow10` swaps are bit-identical;
`votes === 0 -> 1` and `rewardPoolMaxShare` are intact. Lint: 0 errors; all 3 test suites pass.
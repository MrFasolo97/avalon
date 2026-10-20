# Migrating from `new_net` to the new code — without the new economy (fork #13330000)

**Type**: operational runbook
**Date**: 18 October 2026
**Last verified**: 20 October 2026 — every check below was re-run on HEAD `04ad87b` (the two commits above it, `/version` endpoint + release 2.0.0, touch no consensus code), and the network state was re-measured (head unchanged)
**From**: branch `new_net` (the code line the current network runs on, today halted)
**To**: the new code = `new_econs` HEAD `dcfe8b4` (=`cefabdd` plus the non-consensus commits above it: docs, javalon2 bump, `/version` endpoint, release 2.0.0), **minus** commit `46c77ff` (the economic hard fork)
**Companion**: `doc/economics_fork_13330000.md` (what the new economy does, in detail)

Checks performed for this runbook (in a throwaway worktree; re-run on 20 October 2026 on HEAD `04ad87b`, whose `src`/`test` are identical to `cefabdd`):

- reverting the econs commit **applies with no conflicts** (5 modified files + `D test/supply-anchor.js`; 6 files, +10 / −432);
- **zero residue** of econs symbols in `src/`, `test/`, `scripts/` on the reverted tree (the `doc/` folder is not scanned on purpose: the companion and migration documents legitimately discuss these tokens — see the corrected grep in S2);
- `node test/audit-fixes.js` → **19 passed, 0 failed** (also after the revert); `node test/force-finalize.js` → **All tests passed**;
- `npx eslint ./src/*` → identical to the baseline (**1 pre-existing error**: `src/http/auth/index.js:86`, `curly`; 244 warnings);
- the resulting history is `{0, 241600, 13925000}`: **the force-finalization fork stays intact** (config one-liner in S2 returns `FF@13925000: true | sigVer: 2`, and the reverted `src/` contains no `13330000` entry).

---

## 0. TL;DR

| In the migration | Out |
|---|---|
| 168 commits (173 at HEAD `dcfe8b4`: everything above `cefabdd` is non-consensus — docs, javalon2 bump, `/version` endpoint, release 2.0.0): security hardening (SSRF, NoSQLi, prototype pollution, log redaction), **anti-fork force-finalization**, halt-recovery, rate limiting, Node ≥ 24, Docker testnet, log viewer, dependency bumps (`javalon2` now `^1.1.10`) | **only** commit `46c77ff` `feat(econs): add hard fork #13330000 (supply-anchored pool, vote rate cap)` — 6 files, +432 / −10 |

Three things to keep in mind:

1. **One single dangerous moment**: the *flag day*. All leaders must run the same code **on the same day**, because the new code also changes several validators (R2).
2. **Five new defaults that break clients** if left unconfigured: `CORS_ORIGIN`, `HTTP_HOST`, the global rate limit, `TRUST_PROXY`, 1 MB body limit (S3).
3. **The network is halted**: resuming the chain *is* the cutover, and until block 13,925,000 there is no force-finalization as a safety net (S5, R15).

---

## 1. What "the new economy" is — and what it is not

### 1.1 The object to exclude

A **single commit**, `46c77ff`, among the last code commits on the branch (the only commit above it that touches code is `cefabdd`, which does not touch the economy; everything above that is non-consensus: docs, javalon2 bump, `/version` endpoint, release 2.0.0):

```
46c77ff  feat(econs): add hard fork #13330000 (supply-anchored pool, vote rate cap)
         src/cache.js           2 lines touched
         src/chain.js          43
         src/config.js         22
         src/economics.js      54
         src/main.js           34
         test/supply-anchor.js 287 (new)
         ------------------------------------------------
         6 files, +432 / -10
```

What it adds, in short (details in `doc/economics_fork_13330000.md`):

| Element | Effect from block 13,330,000 |
|---|---|
| `rewardPoolYearlyRate: 0.10` | pool 8 h = 10 %/year of total supply (~52,265 DTC) instead of the constant `rewardPoolAmount = 150001` |
| `vtReferenceTotal: 15500000` | cap on the payout of **a single vote** = `pool × \|vt\| / vtReferenceTotal` |
| `eco.totalSupplyUnits` + `chain.scanSupply()` + persistence in `cache.state` | supply accumulator (consensus state) used to compute the pool |
| `pow10` / `ipow` gated on `accountPrice` | numeric determinism (pre-fork the `Math.pow(10,n)` were already bit-identical) |
| `initialSupplyBlock: 13320066`, `initialSupply: 572311976.600145` | frozen anchor, filtered out by `allowedKeys` (governance cannot rewrite it) |

### 1.2 What is NOT the new economy (and must be kept)

Everything else on the branch, including another hard fork **that stays**:

```
   0     base config (effective values unchanged; only the internal rename blockHashSerialization → consensusSigVersion, value 1)
 241600    txLimits (already active on new_net)
 13925000  forceFinalize: true  +  consensusSigVersion: 2      <-- STAYS, do not touch it
```

`13925000` is the *next* flag day: it enables force-finalization and moves consensus message serialization to the ordered-keys version. **It must be kept even in the "no economy" migration**: it is the safety net against forks, i.e. the main reason for migrating at all.

Note: `new_net` has **no force-finalization code at all** (`consensus.js` 290 → 684 lines, 47 commits on halt/consensus/quorum, `scripts/auto_resolve_halt.sh` new, 794 lines). That, not the economy, is the substance of the migration.

### 1.3 The three exclusion variants

| Variant | How | Diff | Pros | Cons |
|---|---|---|---|---|
| **V1 — revert** (recommended) | `git revert 46c77ff` on the new code | 6 files (+10 / −432) + 1 revert commit | verified, trivial, removes dead code *and* the test | a `revert` commit in history (noise if the branch is public) |
| **V2 — linear history** | branch from `46c77ff^` + `cherry-pick` every commit above it | tree **identical** to V1 | no `revert` in the log: preferable if the branch is published for node operators | requires a cherry-pick sequence (no conflict: only `cefabdd` touches code) |
| **V3 — config entry only** | drop the `13330000` block from `config.history` | ~10 lines | minimal change; re-enabling the economy = putting one entry back | leaves dead code + an unused accumulator and **makes `test/supply-anchor.js` fail** (it must be deleted); a future merge from `new_econs` can reintroduce the entry with a silent conflict |

In all three variants the golden rule holds: **the new economy is excluded in code only, never at runtime** (no env var disables it; no `allowedKeys` turns it off).

---

## 2. Network state at the time of writing (measured)

| Datum | Value | Source |
|---|---|---|
| Head | **13,320,067** (re-measured 2026-10-20: unchanged) | `GET https://dtube.fso.ovh/count` |
| Last block | ts `2026-06-27T01:01:05Z`, miner `brianphobos`, `phash` consistent with block 13320066 | `GET /block/13320067` |
| Halted for | **~115 days** as of 2026-10-20 (the tip is not corrupted: it is a halt, not a fork at the tip) | timestamp comparison |
| Econs fork 13,330,000 | **not activated yet**: **9,933 blocks** missing ≈ **8.3 h** at 3 s block time | height difference |
| Force-finalization fork 13,925,000 | 604,933 blocks missing ≈ **21 days** of production at 3 s | height difference |
| Economy anchor | 13,320,066 = **tip − 1** | `src/config.js` |

Operational consequences:

- **This is the right moment**: while the chain is halted, excluding the econs fork is neutral (no block produced under the new rules, nothing to reconcile).
- **But it is also urgent**: whoever restarts with the code that *contains* the entry activates it after ~8 h of production. If some nodes restart with the economy and others without, it splits (R1).
- **The anchor is pinned at the current tip − 1**: the new economy was prepared for a restart *from here*. One more reason not to move those two keys if it is to be activated later (R9).

---

## 3. Preliminary decisions (to be closed before touching any node)

- **D1 — Exclusion variant**: V1 / V2 / V3 (§1.3). Proposed default: **V1**, or **V2** if the branch is to be published.
- **D2 — Who upgrades, and when**: *all* active leaders, *all* nodes serving the public API listed in `AvalonAPINodes`, the indexers. Anyone staying on `new_net` **must** be shut down before the cutover block (R1/R2).
- **D3 — Will the new economy be re-enabled in the future?** If yes: it needs a **new fork entry** with a future height and a re-measured anchor. The `initialSupply`/`initialSupplyBlock` keys are consensus invariants: they do not move, they are not hand-edited (appendix C).
- **D4 — Point of no return and rollback**: define *beforehand* the block beyond which there is no going back (S9) and who has the authority to declare it.

---

## 4. Migration steps

### S0 — Pre-flight (before touching anything) 🔴

```bash
# 1. Snapshot of the current state: commit, config, keys
cd /path/avalon && git rev-parse HEAD && git status --short
cp -a .env /backup/env.$(date +%F)                    # if it exists
cp -a scripts/start.sh /backup/start.sh.$(date +%F)   # it contains the node keys!

# 2. Data backup (do BOTH if you are unsure which storage is in use)
cp -a "$BLOCKS_DIR"/blocks.bson /backup/blocks.bson.$(date +%F)
cp -a "$BLOCKS_DIR"/*.idx /backup/ 2>/dev/null
mongodump --db "${DB_NAME:-avalon}" --out /backup/mongo-$(date +%F)   # if Mongo is used

# 3. Versions and environment
node -v          # must be >= 24 (new code: engines ">=24.0.0")
npm -v
nginx -v 2>/dev/null; grep -rn "proxy_set_header\|proxy_pass" /etc/nginx/  # reverse proxy?
```

To record on the cutover sheet: head height, head block hash, **commit** currently in production, ports (`HTTP_PORT`, `P2P_PORT`), peer list, expected tolerance in minutes.

### S1 — Build the branch without the economy 🔴

Variant **V1** (verified clean):

```bash
cd /path/avalon
git fetch --all
git log --oneline -5 new_econs        # expected: everything above cefabdd is non-consensus (docs, deps, /version, 2.0.0)
git checkout -b new_net_noecons new_econs
git revert --no-commit 46c77ff        # no conflicts, no manual intervention
git status --short                    # expected: 5 M + D test/supply-anchor.js
git diff --stat                       # expected: 6 files, 10 insertions(+), 432 deletions(-)
git commit -m "revert(econs): exclude fork #13330000 from this release"
```

Variant **V2** (same tree, linear history):

```bash
git checkout -b new_net_noecons 46c77ff^   # = 9774aca
git cherry-pick 46c77ff..new_econs         # every commit above the econs one:
                                           # only cefabdd touches code, the two
                                           # later commits are docs/deps-only
```

Equivalence check (useful in any variant):

```bash
# it must show ONLY the 6 economy files: that means your branch = new code − econs
git diff new_econs new_net_noecons --stat
```

### S2 — Static, offline verification ⚠️

```bash
export PATH="...node24/bin:$PATH"     # Node >= 24
npm ci                                # or npm install if the lockfile is out of sync

# 1. No residue of the economy
grep -rn "rewardPoolYearlyRate\|vtReferenceTotal\|initialSupplyBlock\|totalSupplyUnits\|13330000" \
     src test scripts 2>/dev/null
# expected: no output. doc/ is deliberately NOT scanned: economics_fork_13330000.md
# and the migration documents discuss these tokens on purpose (the previous version
# of this command scanned doc/ and its exclusion did not match this document's filename).

# 2. The config at the fork height no longer activates anything, and the rest stays
node -e 'global.logr=new Proxy({},{get:()=>()=>{}});global.cache={state:{}};
const c=require("./src/config.js");
const p=c.read(13330000), f=c.read(13925000);
console.log("econs:",p.rewardPoolYearlyRate,p.vtReferenceTotal,p.initialSupplyBlock,
            "| pool:",p.rewardPoolAmount,"| FF@13925000:",f.forceFinalize,"| sigVer:",f.consensusSigVersion)'
# expected: econs: undefined undefined undefined | pool: 150001 | FF@13925000: true | sigVer: 2

# 3. Quality gates
npm run lint                      # expected: 1 pre-existing error (auth/index.js:86) + 244 warnings
node test/audit-fixes.js          # expected: 19 passed, 0 failed
node test/force-finalize.js       # expected: All tests passed
# test/supply-anchor.js: it must NOT exist (the revert deletes it; in V3 delete it by hand)

# 4. Once the gates are green, certify the commit as the release
git tag -a v2.0.0 -m "release 2.0.0 (new code without econs)"
git push origin v2.0.0           # from now on every operator runs: git checkout v2.0.0
```

### S3 — Config, environment, proxy 🔴

The new code adds **18 environment variables** (re-counted 2026-10-20: the tree goes from 45 to 63 `process.env` references) and **removes none**. Five of them change the *default* behavior compared to `new_net` and can break clients if ignored:

| Variable | New default | `new_net` | Why it matters |
|---|---|---|---|
| `CORS_ORIGIN` | **`false`** → no CORS headers | `cors()` = `*` | 🔴 **the web client (dtube2) can no longer read cross-origin API responses**. Must be set (e.g. `*`, or the client origin) |
| `HTTP_HOST` | **`127.0.0.1`** | `0.0.0.0` | 🔴 API unreachable from outside / from the container unless set explicitly (`docker-compose.yml` already passes it) |
| global rate limit | **50 req/s per IP** (new) | absent | heavy traffic (feeds, indexers, scripts) gets `429`; `/transact` has a separate limiter at **5 req/s** |
| `TRUST_PROXY` | unset → `X-Forwarded-For` **ignored** | header trusted | 🔴 behind nginx *all* clients share one bucket → mass `429`s, and admin sessions appear bound to the proxy IP. With a wrong value, spoofing reopens |
| body parser | **1 MB** | unlimited | large payloads → `413` |

Of the 18 new variables, only ~10 affect the daemon runtime (4 of them are the security/auth must-configs: `ADMIN_TOKEN`, `LOG_ADMIN_TOKEN`, `TRUST_PROXY`, `CORS_ORIGIN`; 4 are abuse limits: `CONTENT_MAX_COMMENTS`, `CONTENT_MAX_RESULTS`, `IMG_MAX_BYTES`, `IMG_MAX_PIXELS`; 2 are the in-node log viewer: `LOG_FULL`, `LOG_PAGE`), 6 are parameters of the halt-recovery script only (`BSON_PATH`, `IDX_PATH`, `REMOVE_COUNT`, `NEW_HEIGHT`, `DRY_RUN`, `TMP_COLL`), 1 is runtime ops (`SKIP_EARLY_CHECK_BLOCKS`) and 1 is testnet-only (`BOOTSTRAP_HOST`).

🔴 **Discoverability gap to close before the cutover**: **none** of the new variables is declared in `scripts/start.sh` (it declares only 12 exports), even though the README points there for "the list of available environment variables". Append a commented-out block to `scripts/start.sh` (or ship an `.env.example`) listing the 18 new variables with their defaults, so operators can actually find them.

Other new variables, to be evaluated: `IMG_MAX_BYTES` (10 MB), `IMG_MAX_PIXELS` (20 MPixels), `CONTENT_MAX_COMMENTS` (2000), `CONTENT_MAX_RESULTS` (10000), `LOG_ADMIN_TOKEN` / `LOG_FULL` / `LOG_PAGE` (in-node log viewer), and the variables used only by the halt scripts (`BSON_PATH`, `IDX_PATH`, `REMOVE_COUNT`, `NEW_HEIGHT`, `DRY_RUN`, `SKIP_EARLY_CHECK_BLOCKS`, `TMP_COLL`, `BOOTSTRAP_HOST`).

Authentication: in the new code `requireAuth()` protects `/debug`, `/recover`, `/logs`, `/mineBlock`. Careful: **on a node with no token configured those endpoints are reachable** (`cefabdd`) → set `ADMIN_TOKEN`/`LOG_ADMIN_TOKEN` before exposing the node.

Behind a reverse proxy:

```nginx
proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
# then in the node's .env:
TRUST_PROXY=1        # "1" = trust the first hop; 0/false = do not trust (default)
CORS_ORIGIN='*'      # or the exact origin of the web client
HTTP_HOST=0.0.0.0
```

Docker: `docker/docker-compose.yml` lost `version:` and now passes `HTTP_HOST=0.0.0.0`. **Careful**: `docker/Dockerfile` still installs **Node 18** (`deb.nodesource.com/setup_18.x`) and `docker/testnet/Dockerfile` uses `FROM node:18`, while `package.json` requires **`node >= 24`** (the runtime check in `main.js` accepts `>= 18`). An internal inconsistency in the new code: align the images to Node 24 **before** the cutover (R8).

### S4 — Dry run on a local testnet ⚠️

Before touching mainnet, reproduce the migration on `docker/testnet` (3 miners + bootstrap, ports 3101-3104 / 6101-6104):

1. build the `new_net_noecons` branch (`docker compose build`);
2. chain from scratch: verify that blocks are produced and that `Hard Fork #13330000` **never appears** in the logs;
3. **determinism test**: full rebuild from genesis on the new-code-without-economy and compare around a hundred block hashes with a `new_net` node → they must match (validators changed, R2);
4. force-finalization test (two near-simultaneous `/mineBlock` on different miners);
5. test of a control node syncing from scratch (replay + accumulator not involved).

### S5 — Flag day: mainnet cutover 🔴

Non-negotiable order: **first everything stops, then truncate/resume, then restart with one single code version**.

```bash
# 1. Freeze: stop ALL leaders (coordinated, chat/voice open)
#    - no node may stay on new_net
# 2. Halt diagnosis (always dry-run first)
DRY_RUN=1 ./scripts/auto_resolve_halt.sh
#    The script truncates blocks (BSON or Mongo) and rewrites the state.
#    Guardrails to know: MAX_REMOVE_BLOCKS (10), MAX_TOTAL_REMOVE (30) and
#    .avalon_halt/state.json → if the chain has not advanced since the last truncation
#    the script REFUSES to truncate again ("Manual intervention required").
# 3. Start the new version on all nodes (same commit!)
cd /path/avalon
export HTTP_HOST=0.0.0.0 CORS_ORIGIN='*' TRUST_PROXY=1 ADMIN_TOKEN=... LOG_ADMIN_TOKEN=...
nohup ./scripts/start.sh > /var/log/avalon.log 2>&1 &   # or systemd / pm2 / screen
```

### S6 — Post-cutover verification (checklist)

```bash
curl -s localhost:3001/count                      # head ADVANCING (13,320,068+)
curl -s localhost:3001/block/13320068 | head -c 200   # phash = hash of 13320067
curl -s localhost:3001/supply | head -c 200           # sanity (endpoint unchanged, not econs)
curl -s localhost:3001/version         # expected: {"version":"2.0.0"} — IDENTICAL on every node
grep -c "Hard Fork #13330000" /var/log/avalon.log     # expected: 0 (forever)
grep "Hard Fork #" /var/log/avalon.log | tail -3      # only 241600 expected (and 13925000 from the future fork)
```

Plus, on the control node: rebuild from genesis → same head **and same hash** as the other nodes. Payout/vote format: unchanged (pool = 150001). First full day of observation: `/count` monotonic, no growing `possBlocks`, stable peers. Every operator runs `curl -s localhost:3001/version` and posts the result in the cutover chat: all nodes must answer `2.0.0`.

### S7 — Clients, indexers, embed

- **No client change is needed to exclude the economy**: the fork touches no HTTP endpoint (`46c77ff` does not modify `src/http/**`) and `/supply` stays as it was.
- **But**: `CORS_ORIGIN` must be set on *all* public nodes, otherwise dtube2 (browser) cannot read responses.
- `client/settings.js` → `AvalonAPINodes` (`api.avalonblocks.com`, `dtube.fso.ovh`, `avalon.luminade.fun`, `dtube.tekraze.com`, `testnet.dtube.fso.ovh`, plus a local dev entry `localhost:3001`): every one of these nodes must be upgraded and configured, otherwise the client keeps talking to old instances.
- Rate limit: `/transact` 5 req/s per IP and 50 req/s globally → check flows that send many transactions in a burst (batches of votes/uploads from dtube2) and add client-side retry/backoff.
- `javalon2`: the node moves from `^1.1.7` to `^1.1.10` (bumped 2026-10-20, commit `04ad87b`; 1.1.10 adds a DMCA-endpoint fallback fix and compatible dependency bumps), but **does not use it for consensus validation** (it uses `secp256k1` directly: no chain impact; it is only required by `scripts/mega_generic_test.js`). The bump changes `signVerify` on the JS side (hash reconstruction + rejection of missing `pubKey`/`signature`/`hash`): check third-party scripts/tools that signed with the old formulation.
- `dtube-embed`, `ipfs-caching`, `DTubeGo` are not involved in this migration.

### S8 — Watch and second flag day (13,925,000)

- By **13,925,000** (604,933 blocks ≈ 21 days at 3 s from the current head) **all nodes must run the new code**: that fork enables `forceFinalize` and moves `consensusSigVersion` to 2 (ordered-keys serialization). A node left behind does not produce/validate the same signatures → fork or halt.
- Until that block the network has force-finalization **disabled**: a new halt can only be resolved with `auto_resolve_halt.sh`.
- To monitor: `Hard Fork #13925000` in the logs at the right time, peer health, any multiple `possBlocks`.
- **Post-migration backlog** (dependency audit 2026-10-20): bump `sharp` `^0.32.6` → `^0.35.5` (high: libvips/libheif CVEs on the user-image processing endpoint; validate with an upload+resize test) and `apidoc` `^1.2.0` → `^0.29.0` (dev-only). One commit, AFTER the cutover — deliberately outside the flag-day delta.

### S9 — Rollback

- **Immediate rollback** (before producing blocks with the new code): stop → `git checkout` the previous commit → restart. Cost: the minutes of downtime.
- 🔴 **After the new code has validated blocks**: going back to `new_net` means **truncating to the cutover block**, because `new_net` does not know about the validation fixes introduced by the new code (R2/R3). It requires the S0 backup and the same `auto_resolve_halt.sh`.
- Save so you can go back: `blocks.bson`/Mongo dump, previous commit, `.env`, `.avalon_halt/state.json`, logs for the period.

---

## 5. Risks

| # | Risk | Impact | Prob. | Mitigation |
|---|---|---|---|---|
| **R1** | Exclusion applied to only some nodes → at block 13,330,000 some apply the fork and others do not: different `dist`/pool, **split chain** | 🔴 critical | medium | flag day with all leaders; S2 verification (one-liner on every node) + `grep "Hard Fork #13330000"` = 0 + `curl /version` = 2.0.0 on every node; no `new_net` node online |
| **R2** | The new code changes **validators** (`validate/json.js`, `float.js`, `integer.js`, `string.js`, bandwidth check on create-account, block size bounds, JSON with `.`/`$` keys rejected): a block/tx accepted by the old code may be rejected by the new one | 🔴 fork or impossible rebuild | high if the cutover is not coordinated | S4 testnet with a control rebuild and hash comparison; simultaneous cutover; no mixed nodes |
| **R3** | Rollback after post-cutover blocks: the old version cannot validate the new chain | 🔴 data loss | medium | define the point of no return in D4; S0 backup; targeted truncation S9 |
| **R4** | `CORS_ORIGIN` not set (default `false`) → the web client cannot read the APIs | 🔴 broken client | high | set it on all public nodes (S3, S7) |
| **R5** | `HTTP_HOST` default `127.0.0.1` → API unreachable from outside | 🔴 service down | medium | set `HTTP_HOST=0.0.0.0` (S3) and verify from outside, not just from localhost |
| **R6** | Global rate limit 50 r/s + `TRUST_PROXY` unset behind a proxy: one bucket for everybody → mass `429`s; admin sessions bound to the proxy IP | 🟠 degradation/abuse | high | correct `TRUST_PROXY` + nginx headers; consider limits in nginx; monitor `429`s |
| **R7** | Rate limit on `/transact` (5 r/s) breaks dtube2 batch flows | 🟠 lost tx | medium | client backoff/retry; check vote/upload flows |
| **R8** | Node: `engines >= 24` but Docker images on **Node 18** (`docker/Dockerfile`, `docker/testnet/Dockerfile`) and runtime check `>= 18` | 🟠 unsupported install/runtime | medium | align images to Node 24 before the cutover; `npm ci` with Node ≥ 24 during validation |
| **R9** | Re-enabling the economy later by touching `initialSupplyBlock`/`initialSupply` (frozen anchor, filtered by `allowedKeys`) | 🔴 silent fork | low | new fork entry with a future height and a measured anchor; never move existing keys (appendix C) |
| **R10** | `eco.totalSupplyUnits` not bootstrapped → `logr.fatal` + `process.exit(1)` at the first block of the fork (for a node crossing the anchor without restarting) | 🟠 node dies | low (excluded in this migration) | this is why the anchor sits at the current tip: restart all nodes as part of the resume |
| **R11** | Unresolved halt: force-finalization is **not active** until 13,925,000; the script guardrails (max 10 blocks per pass, 30 total, `.avalon_halt` state) may refuse the truncation | 🔴 chain halted | medium | `DRY_RUN=1` first, plan the manual intervention, S0 backup, agreed maintenance window |
| **R12** | Without the new economy these stay open: 28.7 %/year emission ceiling with a constant pool of `150001`, and **pool drainage by a single whale** on an inactive network (value-extraction bug, `economics_fork_13330000.md` §2) | 🟠 economic | certain | explicit, dated business decision (D3): re-enable with a later fork |
| **R13** | `scripts/start.sh` contains a **plaintext private key** (`NODE_OWNER_PRIV=34Ep…`) on both branches, and history holds "remove private keys" commits that were later undone | 🔴 security | certain | rotate the node key before circulating this document or the branch; do not version the real `start.sh` |
| **R14** | Dependency bumps (`mongodb` 4.2→4.17, `sharp`, `secp256k1`, `express`, now `javalon2` ^1.1.10): different behavior/indexes on existing DBs | 🟠 runtime errors | medium | test on a copy of the DB; read the logs on first start; `npm ci` from the lockfile |
| **R15** | The new code *is* an anti-halt release (consensus.js 290→684 lines) but force-finalization is disabled until 13,925,000: the stability of the resume depends on new logic never yet exercised in production | 🟠 new halt | medium | force-finalization testnet (S4); `auto_resolve_halt.sh` ready; close observation (S8) |

---

## 6. Definition of done

- [ ] Branch `new_net_noecons` built (V1 or V2) and `git diff new_econs <branch> --stat` shows **only** the 6 economy files
- [ ] Residue `grep` and the S2 config one-liner → expected outcome (no econs keys, `pool: 150001`, `FF@13925000: true`, `sigVer: 2`)
- [ ] `npm run lint` + `test/audit-fixes.js` + `test/force-finalize.js` green as per baseline
- [ ] Node ≥ 24 on all nodes and in the Docker images
- [ ] Tag `v2.0.0` pushed on the certified commit; `curl /version` returns `2.0.0` on every node
- [ ] `CORS_ORIGIN`, `HTTP_HOST`, `TRUST_PROXY`, `ADMIN_TOKEN`/`LOG_ADMIN_TOKEN` set and verified **from outside the local network**
- [ ] New env vars declared in `scripts/start.sh` (commented block) so operators can discover them
- [ ] Testnet dry run: rebuild from genesis with matching hashes + force-finalization tested
- [ ] Backup of blocks, DB, `.env`, previous commit in a safe, verified place
- [ ] All leaders stopped, none on `new_net`, cutover chat open
- [ ] After the cutover: `/count` advances, chain hashes consistent on all nodes, **zero** `Hard Fork #13330000` in the logs
- [ ] Shared calendar with the network: everyone on the new code by block **13,925,000**
- [ ] Private key in `scripts/start.sh` rotated

---

## 7. ⏱ Execution time estimates

Hands-on time per step, estimated against the real node layout (mainnet: `blocks.bson` 4.2 GB + 102 MB index, Mongo ~2.7 GB):

| Step | Hands-on | Basis |
|---|---|---|
| **S0 pre-flight** | **~15 min** | blocks.bson/index copy ≈ 1–2 min (4.3 GB local disk / 1 Gbit), `mongodump` 2.7 GB ≈ 2–3 min, git/env/key snapshots ~5 min |
| **S1 no-economics branch** | **~5 min** | `revert --no-commit`, status/diff, commit |
| **S2 static verification** | **~10–15 min** | `npm ci` 1–5 min (warm cache), greps + config one-liner + lint + 2 test suites |
| **S3 config/proxy** | **~30 min per node** | `.env` + new commented block in `start.sh` + nginx (`X-Forwarded-For`) + verification from outside |
| **S4 testnet dry run** | **~1–2 h first run**, ~45 min on repeat | `docker compose build` 15–30 min first time; chain from scratch, determinism rebuild, force-finalization test |
| **S5 flag day** | **~45–60 min window** | stop all leaders 10–15, `DRY_RUN=1` diagnosis 5–10, truncate/restart 10–15, first-block verification 10–15 |
| **S6 post-cutover** | **~15 min + 1–4 h unattended** | curl checklist; the genesis rebuild on the control node runs in background (13.3 M blocks) |
| **S7 clients/indexers** | **~1 h** | `CORS_ORIGIN` on every public node in `AvalonAPINodes` (~10–15 min each) + dtube2 batch-flow checks |
| **S8 watch** | **~15 min/day × ~21 days** | until 13,925,000, light monitoring |
| **S9 rollback plan** | **~30 min** | D4 decision + backups already covered by S0 |

Totals:
- **One operator on their own node: ~4–6 h hands-on** (~1 h of which is the cutover window), plus 1–4 h of unattended rebuild and ~21 days of light observation.
- **Realistic calendar: 2 working days** — one for S0–S4 (testnet dry run), one for the flag day S5–S6 — plus the window coordinated with the other leaders.
- The critical manual work is concentrated in **S0–S3 + S5 (~2 h)**: the rest is waiting or monitoring.

---

## Appendix A — What is in the new code (measured 2026-10-20)

168 commits / 102 files / +5131 −801 measured at `cefabdd` (the code tip); at HEAD `dcfe8b4`: 173 commits / 105 files / +5566 −810 — everything above `cefabdd` is non-consensus (docs, javalon2 bump, `/version` endpoint, release 2.0.0; the extra files vs `cefabdd` are the refreshed `doc/v1.5.2-upgrade.md`, this runbook and `src/http/version/`).

| Area | Examples |
|---|---|
| Consensus / anti-fork | force-finalization with quorum, backoff, verified signature, broadcast; `forceFinalizeFallback` (default `false`: the chain stops instead of risking a fork); `consensusSigVersion: 2` gated at 13,925,000 |
| Halt recovery | `scripts/auto_resolve_halt.sh` (794 lines), BSON/Mongo truncation, anti-loop guardrails |
| HTTP security | SSRF (`src/http/ssrf.js`, IP/TLS pinning), input validation, query caps, global and per-endpoint rate limits, shared `requireAuth`, IP-bound sessions, log/credential redaction |
| P2P network | websocket payload cap, dedicated rate limiter, TTL on `blockSenders`, O(1) cleanup |
| Cache/block robustness | atomic state writes, Mongo queue error handling, truncated BSON handled, `sanitizeQuery` |
| Validators | `float`/`integer`/`string`/`json` (NaN/Infinity, `.`/`$` keys, zero bounds), JSON size in bytes |
| Platform | Node ≥ 24, multi-node `docker/testnet`, in-node log viewer, `/version` endpoint, `javalon2` 1.1.10 |
| Economy (the only excluded part) | commit `46c77ff` |

## Appendix B — Hard fork timeline

| Height | Content | Status |
|---|---|---|
| 0 | base config (`rewardPoolAmount: 150001`, `rewardPoolMaxShare: 0.1`, …) | active |
| 241600 | `txLimits` | active |
| 13,320,067 | current head (chain halted since 2026-06-27; re-measured 2026-10-20: unchanged) | — |
| **13,330,000** | **economy: pool % supply + vote cap + accumulator** | **to be excluded (never activated: 9,933 blocks missing ≈ 8.3 h at 3 s)** |
| 13,925,000 | `forceFinalize: true`, `consensusSigVersion: 2` | stays: second flag day (~21 days of production) |

## Appendix C — Economy invariants (if it is ever re-enabled)

- `initialSupplyBlock: 13320066` / `initialSupply: 572311976.600145` are **frozen measurements** and are **filtered by `allowedKeys`**: governance cannot rewrite them, only a new fork entry can.
- Never move those keys between history entries: it would change `config.read(n)` for blocks already produced.
- `bootstrapSupply()` (upgrade/restart) rebuilds the accumulator with `chain.scanSupply(anchor+1 … head)` from BSON or Mongo: a node that restarts after the anchor repairs itself; a node that *crosses* the anchor **without** restarting ends in `logr.fatal` + `process.exit(1)`.
- Re-enabling the economy = a new fork with the desired future height (anchor 13,320,066 can stay; the cost is the scan).

## Appendix D — Quick commands

```bash
# Does my branch really exclude the economy?  (expected: 6 files)
git diff new_econs HEAD --stat

# Any residue?  (src/test/scripts only — see S2 for why doc/ is excluded)
grep -rn "rewardPoolYearlyRate\|vtReferenceTotal\|initialSupplyBlock\|totalSupplyUnits" src test scripts

# Config at the fork height + next fork intact
node -e 'global.logr=new Proxy({},{get:()=>()=>{}});global.cache={state:{}};const c=require("./src/config.js");
const p=c.read(13330000),f=c.read(13925000);console.log(p.rewardPoolYearlyRate,p.vtReferenceTotal,p.initialSupplyBlock,p.rewardPoolAmount,f.forceFinalize,f.consensusSigVersion)'

# Network state
curl -s https://dtube.fso.ovh/count

# Same release on this node? (expected: 2.0.0)
curl -s localhost:3001/version

# Has the node activated the economy? (must stay empty)
grep "Hard Fork #13330000" /var/log/avalon.log
```

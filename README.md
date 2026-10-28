# AVALON

## Get a node running

#### Dependencies
* [MongoDB](https://mongodb.com)
* [NodeJS](https://nodejs.org/en/download/) **≥24.0.0** (LTS)
* [ntpd](https://linux.die.net/man/8/ntpd) or any NTP alternative for your system. ntpd comes pre-installed on most linux distributions

## Install and run an Avalon node for Linux
* `npm install` to install nodejs dependencies
* `chmod +x scripts/start.sh`
* `./scripts/start.sh`

### Environment Variables
The `start.sh` shows the list of available environment variables you can set to make avalon behave slightly differently from the default install.

## Install and run an Avalon node for Windows
* `npm install` to install nodejs dependencies
* Get your own keys with `node src/cli.js keypair`
* Save your keys
* Add your keys to `scripts/start.bat`
* Define the path to your directory in `scripts/start.bat`
* Run `scripts/start.bat`
* Note: to restore a genesis.zip file you may need to download the [mongo databasetools](https://www.mongodb.com/try/download/database-tools?tck=docs_databasetools) and put the mongorestore.exe binary into your main directory.

## Tests

A small smoke-test suite covers recent behavioral fixes (including admin auth). Run it with:

```
node test/audit-fixes.js
```


## [Syncing your node](./doc/syncing-your-node.md)
## [Become a leader and produce blocks](./doc/leader-101.md)
## [Debian 10 quick install procedure](./doc/debian-10.md)
## [Public testnet guide (multi-operator)](./doc/public-testnet.md)

## Get helped
We have a Discord channel dedicated to node owners (aka leaders), where you can get support to get set up. Join [discord.gg/QsBnrwqsSV](https://discord.gg/QsBnrwqsSV) and go to `DTube Chain -> #leader-candidates`

## Using Avalon
Once you have a node running, there are many ways to interact with Avalon:

### With the CLI tool
You can use the CLI tool to transact with Avalon. Simply try `node src/cli.js --help` or `node src/cli.js <command> --help` for full help.

### Using Javalon2
[javalon2](https://www.npmjs.com/package/javalon2) is the JavaScript wrapper for Avalon's API. It works in both browser and Node.js.

### HTTP API
Avalon's API uses 100% JSON. The GET calls will allow you to fetch the public information which is already available through the d.tube UI.

Examples:
* Account data: `/account/:username`, e.g. `http://localhost:3001/account/rt-international` or `https://api.avalonblocks.com/account/rt-international`
* Video data: `/content/:username/:link`, e.g. `http://localhost:3001/content/rt-international/QmdjVMdeTtTEy1CJTDbtjuaiRKMP6H364Dv4n7FsWGpnPH`

### Full list of API endpoints
[https://docs.google.com/spreadsheets/d/1ORoHjrdq5V5OkTChijTUOEYRzTujVXTzCyNYt-ysVhw/edit?usp=drive_web&ouid=109732502499946497195](https://docs.google.com/spreadsheets/d/1ORoHjrdq5V5OkTChijTUOEYRzTujVXTzCyNYt-ysVhw/edit?usp=drive_web&ouid=109732502499946497195)

This lists all the available API endpoints for Avalon. We also have recommended security practises if you want to open your node's API to the world. You can do it easily with nginx and [avalon-nginx-config](https://github.com/dtube/avalon-nginx-config).

### Sending Transactions to the network (POST /transact)
Once you have an account and balance (create one with `node src/cli.js account <pub_key> <new_user>` or through a DTube frontend), your account will start generating bandwidth and voting power (respectively the `bw` and `vt` fields in your account data). You can consume those resources by transacting.

Every transaction will have a bandwidth cost, calculated based on the number of bytes required for the storage of your transaction inside a block.
Certain transaction types will require you to spend voting power, such as publishing a content, voting or tagging a content.

To transact, you need to use the /transact POST call of the Avalon API. All the examples here are for the CLI tool, but the same can be achieved with [javalon2](https://www.npmjs.com/package/javalon2) in JavaScript.

Necessary for all transactions:
* *key*: your private key
* * Use -K MyKeyHere to use a plain-text key
* * Or use -F file.json to use a key inside a file to sign (this will prevent your key from showing on the screen too much)
* *user*: your username

#### Vote for a leader
* *target*: the node owner to approve
```
node src/cli.js vote-leader -K <key> -M <user> <target>

// alice votes for bob as a leader
node src/cli.js vote-leader -K 5DPwDJqTvMuykHimmZxThfKttPSNLzJjpbNtkGNnjPAf -M alice bob
```

#### Unvote a leader
* *target*: the leader to remove your vote from
```
node src/cli.js vote-leader -K <key> -M <user> <target>

// charlie does not want to vote for daniel as a leader anymore
node src/cli.js unvote-leader -F charlie_key.txt -M charlie daniel
```

#### Transfer tokens
* *receiver*: username of the receiver of the transfer
* *amount*: number of tokens to transfer to the receiver. Warning! 1 DTC in UI = 100 tokens
* *memo*: arbitrary short text content
```
node src/cli.js transfer -K <bob_key> -M <user> <receiver> <amount> <memo>
// bob sends 50 DTC to charles
node src/cli.js transfer -K HkUbQ5YpejWVSPt8Qgz8pkPGwkDrMn3XECd4Asn3ANB3 -M bob charles 50 'thank you'
```

#### Add a post / Commenting
* *link*: a short string to be used as the index of the content
* *parent_author*: the username of the author of the parent post (use empty string `''` for a top-level post)
* *parent_link*: the link of the parent post (use empty string `''` for a top-level post)
* *json*: arbitrary JSON input. example: `{"string":"aye","array":[1,2,3]}`
* *tag*: arbitrary short text content
* *vt*: the number of vote tokens to spend on this vote
```
node src/cli.js comment -K <key> -M <user> <link> <parent_author> <parent_link> <json> <vt> <tag>
```

#### Vote a post
* *link*: the link of the post to vote on
* *author*: the username of the author to vote on
* *vt*: the number of vote tokens to spend on this vote
* *tag*: arbitrary short text content
```
node src/cli.js vote -K <key> -M <user> <link> <author> <vt> <tag>
```

#### Edit your user json object
* *json*: arbitrary JSON input. example: `{"string":"aye","array":[1,2,3]}`
```
node src/cli.js profile -K <key> -M <user> <json>
```

#### Follow a user
* *target*: the user to follow
```
node src/cli.js follow -K <key> -M <user> <target>
```

#### Unfollow a user
* *target*: the user to unfollow
```
node src/cli.js unfollow -K <key> -M <user> <target>
```

#### Signing a raw transaction

To create a transaction and export it to a file, you can use the `sign` CLI tool
```
node src/cli.js sign <priv_key> <user> <tx> > tmptx.json
```
For example to approve a node owner and publishing it only 5 seconds later:
```
node src/cli.js sign -K 4L1C3553KRETK3Y -M alice '{"type":1,"data":{"target":"miner1"}}' > tmptx.json
sleep 5
curl -H "Content-type:application/json" --data @tmptx.json http://localhost:3001/transact
```

### Admin Authentication

Several privileged endpoints (such as `/mineBlock`, `/recover`, `/debug` and `/logs`) are protected by bearer/query tokens. Avalon checks the following environment variables: `ADMIN_TOKEN`, `LOG_ADMIN_TOKEN`, `MINE_TOKEN`, `DEBUG_TOKEN`, `RECOVER_TOKEN`.

* When **no** admin token is configured, these endpoints accept plain requests. This keeps unconfigured development nodes usable without a login popup.
* When one or more tokens are configured, requests must include the token either as a query parameter (`?token=<TOKEN>`) or as an `Authorization: Bearer <TOKEN>` header. HTML browsers receive a login popup; API clients receive a `401` JSON error.

Set the relevant token in `scripts/start.sh` (or your environment) before exposing the API to the public.

### Other POST Calls

#### Mine Block
Will force the node to try to produce a block even if it's unscheduled. Useful for block #1 and for development.

With no admin token configured:
```
curl http://localhost:3001/mineBlock
```

With an admin token configured:
```
curl http://localhost:3001/mineBlock?token=$ADMIN_TOKEN
```

#### Add peer
Manually force connection to a peer without having to restart the node
```
curl -H "Content-type:application/json" --data '{"peer" : "ws://localhost:6001"}' http://localhost:3001/addPeer
```

### Data storage

### JSON content limits

Arbitrary JSON in transactions (`comment`, `profile`, `playlistJson`, etc.) is validated against a size limit (`jsonMaxBytes` in `src/config.js`, currently 60,000 bytes) and a bandwidth cap (`bwMax`, currently 64,000 bytes). Object keys cannot contain `.` or `$`. This is enough for rich metadata such as multi-resolution video descriptors or provider links, but keep payloads compact to avoid transaction rejection.

### MongoDB
Avalon saves the state of the chain into mongodb after each block. You can easily query mongodb directly to get any data you want, that wouldn't be provided by the API itself.
```
mongo <db_name>
db.accounts.findOne({name:'master'})
db.blocks.findOne({_id: 0})
```
However be sure not to write to any collection used by avalon in this database (namely the accounts, blocks and contents). If you do, your node will irremediably fork sooner or later.

### Elastic Search
Avalon can also copy the accounts and contents into an elastic search database with [monstache](https://github.com/rwynn/monstache). A configuration file for monstache is provided in the root of this repository. Once running you can do text queries on accounts or contents like so: 

```
# search contents
curl http://localhost:9200/avalon.contents/_search?q=football
# search accounts
curl http://localhost:9200/avalon.accounts/_search?q=satoshi
```
Please refer to Elastic Search documentation for more complex queries.

> Note: there is no guaranteed public Elastic Search mirror for the current network; run your own `monstache` instance if you need full-text indexing.

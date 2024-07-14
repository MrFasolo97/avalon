# New net node setup guide

[Why a new codebase?](https://github.com/MrFasolo97/avalon/blob/new_net/doc/new-net.md#why-a-new-codebase)

1. Clone the new node code
```
git clone https://github.com/MrFasolo97/avalon/ new_avalon && cd new_avalon && git checkout new_net
```
2. Get genesis
```
mkdir genesis && cd genesis && wget https://dtube.fso.ovh/genesis_new_dtube.zip && mv genesis_new_dtube.zip genesis.zip && cd ..
```
3. Install node dependencies
```
npm i
```
4. Copy and edit start script
- Add your leader keys
- Add needed peers: ws://dtube.fso.ovh:6003
- Add other peers you might know
- Make and set a blocks.bson directory
```
cp scripts/start.sh ./start.sh && nano ./start.sh
```
5. start the node
```
./start.sh
```
6. (OPTIONAL) If you are willing to join mining, enable your mining key with either:
```
node src/cli.js enable-node <pub_mining_key> -M <username> -K <private_key_with_enable_node_permission> && history -c
```
or
```
node src/cli.js --api http://127.0.0.1:3001 enable-node <pub_mining_key> -M <username> -K <private_key_with_enable_node_permission> && history -c
```
or
```
node src/cli.js --api https://dtube.fso.ovh enable-node <pub_mining_key> -M <username> -K <private_key_with_enable_node_permission> && history -c
```
Note: Don't forget to use `history -c` if you used the -K parameter, or your private **key will be in the server command history!** This will work only if the chain is already running.

And don't forget to announce your mining node on a video and on our [Discord](https://discord.gg/QsBnrwqsSV) too!
## Why a new codebase?

The chain halted for almost 1 month, with most leaders either disappearing or becoming unavailable. Fixing the network was very hard, as we needed at least 10 (2/3 of 15) leaders running a working node among the top 15 leaders.

This new codebase is essentially a new network, with a new genesis block, but all the data from the last block of the old network is included in this genesis. All the leaders had their mining keys deactivated, and the number of mining leaders was reduced from 15 to a more realistic 8. We had about 7 leaders either mining or replying to messages from shortly before the halt until now. This will allow us to reach 2/3 of the needed nodes more easily, as 2/3 of 8 is smaller than 2/3 of 15, and we won't have to consider old leaders who aren’t replying or fixing their nodes (basically they’ve disappeared), until they come back (they can return and re-enable their mining keys pretty easily).

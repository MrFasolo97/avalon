FROM node:18

EXPOSE 6001
EXPOSE 3001

WORKDIR /avalon

RUN apt-get update && apt-get install -y --no-install-recommends curl vim && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install

COPY src/ src/
COPY docker/testnet/scripts/ scripts/

# Patch masterDaoTxs for testnet so the master (dtube) can transfer/enable/vote
RUN sed -i "s/masterDaoTxs: \[[^]]*\]/masterDaoTxs: [0,1,2,3,4,5,6,7,8,10,11,12,13,14,15,17,18,19,20,21,23,24,25,26,27,28,29,30,32]/" /avalon/src/config.js
# Activate forceFinalize at block 100 for testnet testing
RUN node /avalon/scripts/patch-config.js

RUN mkdir -p /avalon/log /avalon/genesis /avalon/blocks
RUN chmod +x /avalon/scripts/testnet-*.sh || true

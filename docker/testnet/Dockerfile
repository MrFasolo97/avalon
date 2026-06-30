FROM node:18

EXPOSE 6001
EXPOSE 3001

WORKDIR /avalon

RUN apt-get update && apt-get install -y --no-install-recommends curl vim && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install

COPY src/ src/
COPY docker/testnet/scripts/ scripts/

RUN mkdir -p /avalon/log /avalon/genesis /avalon/blocks
RUN chmod +x /avalon/scripts/testnet-*.sh || true

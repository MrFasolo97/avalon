FROM node:24

EXPOSE 6001
EXPOSE 3001

WORKDIR /avalon

RUN apt-get update && apt-get install -y --no-install-recommends curl vim libvips-dev && rm -rf /var/lib/apt/lists/*
ENV SHARP_IGNORE_GLOBAL_LIBVIPS=0

COPY package*.json ./
RUN npm install

COPY src/ src/
COPY docker/testnet/scripts/ scripts/

# Apply testnet config patch (Layer S/H active at block 100, master DAO permissions)
RUN node /avalon/scripts/patch-config-testnet.js

RUN mkdir -p /avalon/log /avalon/genesis /avalon/blocks
RUN chmod +x /avalon/scripts/testnet-*.sh || true

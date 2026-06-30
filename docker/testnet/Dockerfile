FROM mongo:6.0.2

EXPOSE 6001
EXPOSE 3001

RUN echo 'debconf debconf/frontend select Noninteractive' | debconf-set-selections
RUN rm /bin/sh && ln -s /bin/bash /bin/sh

RUN apt-get update && apt-get install -y -q --no-install-recommends \
        apt-transport-https \
        build-essential \
        ca-certificates \
        libssl-dev \
        wget \
        unzip \
        curl \
        vim \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://deb.nodesource.com/setup_18.x | bash - && apt-get install -y nodejs

WORKDIR /avalon

COPY package*.json ./
RUN npm install

COPY src/ src/
COPY keys/ keys/
COPY docker/testnet/scripts/ scripts/
COPY docker/testnet/config/ config/

RUN mkdir -p /avalon/log /avalon/genesis /avalon/blocks
RUN chmod +x /avalon/scripts/testnet-*.sh || true

#!/bin/bash

# R6: bake the reviewed commit into the image so /version and NODE_STATUS
# identify the exact artifact. Images built without a checkout fall back to
# "unknown" at runtime rather than reporting a stale hardcoded hash.
GIT_COMMIT="${GIT_COMMIT:-$(git rev-parse --short HEAD 2>/dev/null || echo unknown)}"

docker build --build-arg "GIT_COMMIT=$GIT_COMMIT" -t avalon .
# alternative: docker-compose build (pass GIT_COMMIT=$GIT_COMMIT in the environment)

sleep 5

docker rm avalon
docker run -it -v $HOME/avalon/blocks:/avalon/blocks -v $HOME/avalon/mongodb:/var/lib/mongodb -p 3001:3001 -p 6001:6001 --name avalon avalon:latest ./scripts/start_dtube.sh
# alternative: docker-compose down && docker-compose up

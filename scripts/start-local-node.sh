#!/usr/bin/env bash
set -euo pipefail

echo "Starting local nwaku (Relay + LightPush + Filter + Store)..."
echo "Copy the multiaddr from logs and pass it to --bootstrap."

docker run --rm -it \
  -p 60000:60000 \
  -p 9000:9000/udp \
  statusteam/nim-waku:v0.20.0 \
  --listen-address=0.0.0.0 \
  --tcp-port=60000 \
  --relay=true \
  --lightpush=true \
  --filter=true \
  --store=true

#!/usr/bin/env bash
# Installs a staged model (see stage.sh) into Scrypted and attaches it to cameras.
#
# Scrypted's ONNX plugin only accepts http(s) model URLs (its downloader checks an
# HTTP status code, which file:// URLs do not have), so for the few seconds the
# install takes this serves the staged files from INSIDE the Scrypted container on
# 127.0.0.1 -- reachable by Scrypted alone, never by the LAN. Scrypted copies the
# model into its own plugin storage on creation and loads it from there ever after.
#
#   SCRYPTED_USER=... SCRYPTED_PASS=... deploy/install.sh wildlife-atlanta \
#     "Front Door Camera,Back Door Camera,Bird Camera,Backyard Camera" ["Bird Classifier"]
set -euo pipefail
name=${1:?usage: install.sh <staged-model-name> <cameras> [classifier-to-replace]}
cameras=${2:?cameras required}
replace=${3:-}
host=${SSH_HOST:-unraid}
container=${SCRYPTED_CONTAINER:-scrypted}
port=${SERVE_PORT:-18765}
cd "$(dirname "$0")"

ssh "$host" "docker exec -d $container python3 -m http.server $port --bind 127.0.0.1 --directory /server/volume/models"
trap 'ssh "$host" "docker exec $container pkill -f \"http.server $port\"" || true' EXIT
sleep 2
node install.mjs --url "http://127.0.0.1:$port/$name/config.json" --cameras "$cameras" ${replace:+--replace "$replace"}

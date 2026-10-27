#!/bin/sh
set -eu
if [ ! -f /data/config/config.yaml ]; then
  cp /app/config.example.yaml /data/config/config.yaml
fi
exec /app/md-editor "$@"

#!/bin/sh
# Startup script for dsh-superagent.
# Starts the dsh-superagent service (superagent profile) on boot.
#
# Required environment:
#   PATH must include /home/dahoiv/div/.local-npm/bin (dsh binary)
#   DSH_HOME=/home/dahoiv/div/.dsh

set -u

export PATH="/home/dahoiv/div/.local-npm/bin:$PATH"
export DSH_HOME="/home/dahoiv/div/.dsh"

REPO="/home/dahoiv/div/dsh-superagent-prototype"
LOG="$REPO/.artifacts/dsh-superagent-boot.log"

mkdir -p "$REPO/.artifacts"

# Start dsh in the background, detached from the terminal.
nohup dsh --profile superagent --no-open >> "$LOG" 2>&1 &

echo "$(date -Is) dsh-superagent started (PID $!)" >> "$LOG"

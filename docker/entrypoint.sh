#!/bin/bash

set -eo pipefail

if [ -f "/workspace/creamy-reqs.txt" ]; then
    echo "Installing additional requirements from /workspace/creamy-reqs.txt"
    uv pip install -r /workspace/creamy-reqs.txt -p /app/.venv/bin/python
fi

source /app/.venv/bin/activate
/app/.venv/bin/creamy install
if [ -f "/workspace/startup.sh" ]; then
    exec bash /workspace/startup.sh
else
    exec /app/.venv/bin/creamy gateway
fi

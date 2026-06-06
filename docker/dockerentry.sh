#!/usr/bin/env bash
#
# Container bootstrap for Creamy.
#
#   1. install any user-supplied extra requirements
#   2. activate the image's prebuilt virtualenv
#   3. sync plugins, then hand control to the gateway
#      (or a user-provided startup script, if present)
#
# Paths can be overridden via the CREAMY_VENV / CREAMY_WORKSPACE env vars.

set -eo pipefail

VENV_DIR="${CREAMY_VENV:-/app/.venv}"
WORKSPACE="${CREAMY_WORKSPACE:-/workspace}"
PYTHON_BIN="${VENV_DIR}/bin/python"
CREAMY_BIN="${VENV_DIR}/bin/creamy"

log() { printf '[creamy] %s\n' "$*"; }

# 1. Pull in extra dependencies a user dropped into the workspace.
extra_reqs="${WORKSPACE}/creamy-reqs.txt"
if [[ -f "${extra_reqs}" ]]; then
    log "installing extra requirements from ${extra_reqs}"
    uv pip install -r "${extra_reqs}" -p "${PYTHON_BIN}"
fi

# 2. Enter the environment baked into the image.
# shellcheck disable=SC1091
source "${VENV_DIR}/bin/activate"

# 3. Make sure plugins are in sync before serving.
log "syncing plugins"
"${CREAMY_BIN}" install

# 4. Launch: prefer a custom startup script, otherwise run the gateway.
startup="${WORKSPACE}/startup.sh"
if [[ -f "${startup}" ]]; then
    log "handing off to ${startup}"
    exec bash "${startup}"
fi

log "starting gateway"
exec "${CREAMY_BIN}" gateway

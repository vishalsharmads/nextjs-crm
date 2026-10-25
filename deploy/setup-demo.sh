#!/usr/bin/env bash
# Install (or switch) the demo to one industry: wipes the demo database and its uploaded files, then
# installs the industry's template with sample data and one demo user per role.
#
#   deploy/setup-demo.sh law-firms
#
# Runs only on a demo instance: DEMO_MODE=true, a database whose name contains "demo" (crm_demo) and
# an upload folder whose path contains "demo" (STORAGE_DIR=./storage-demo). Set them in .env or inline:
#
#   DEMO_MODE=true DATABASE_URL=mysql://crm:pass@127.0.0.1:3306/crm_demo STORAGE_DIR=./storage-demo deploy/setup-demo.sh coworking
#
# Restart the app afterwards (or pass RESTART_FILE=tmp/restart.txt on Passenger hosts).
set -euo pipefail
INDUSTRY="${1:?industry, e.g. coworking, law-firms, real-estate}"
cd "$(dirname "$0")/.."
npm run demo:reset -- --industry="$INDUSTRY" --yes ${RESTART_FILE:+--restart-file="$RESTART_FILE"}

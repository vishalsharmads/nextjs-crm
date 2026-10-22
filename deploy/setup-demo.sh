#!/usr/bin/env bash
# Prepare a demo instance for one industry: install the blueprint with sample data and one demo
# user per role. Run once per industry, each with its own database (and, on a server, its own
# checkout, .env, vhost and systemd unit).
#
#   DATABASE_URL=mysql://crm:pass@127.0.0.1:3306/crm_demo_coworking deploy/setup-demo.sh coworking
#   DATABASE_URL=mysql://crm:pass@127.0.0.1:3306/crm_demo_visa      deploy/setup-demo.sh visa-consultancy
#
# Then start it with DEMO_MODE=true so the demo accounts show on the sign-in screen.
# Never run this against a client instance.
set -euo pipefail
BLUEPRINT="${1:?blueprint key (generic, coworking, visa-consultancy)}"
: "${DATABASE_URL:?set DATABASE_URL to an empty database for this demo}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@demo.test}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-DemoAccess2026!}"
cd "$(dirname "$0")/.."
npm run install:instance -- --blueprint="$BLUEPRINT" --admin-email="$ADMIN_EMAIL" --admin-password="$ADMIN_PASSWORD" --sample-data
npm run cli -w @app/api -- demo:seed --password="$ADMIN_PASSWORD"
echo
echo "Demo for \"$BLUEPRINT\" is ready. Start it with DEMO_MODE=true (and its own PORT if several run on one machine)."

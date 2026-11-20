#!/bin/sh
# Applies database migrations, then hands over to the web server.
#
# set -e means a failed migration stops the container before it serves a
# single request. Coolify then marks the deploy failed and leaves the previous
# version running, which is what we want: a half-migrated database serving
# traffic is worse than a deploy that did not happen.
set -e

echo "TAWD: running database migrations"
node /app/apps/web/scripts/migrate.js

echo "TAWD: starting web server"
exec "$@"

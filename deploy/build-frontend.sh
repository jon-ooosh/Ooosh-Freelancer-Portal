#!/bin/bash
# =============================================================
# Build the OP frontend without taking the live site down.
# =============================================================
# Used by every deploy path: .github/workflows/deploy.yml, deploy/deploy.sh,
# and by hand:  bash /var/www/ooosh-portal/deploy/build-frontend.sh
# (run `npm install` in frontend/ first, as the deploy paths do).
#
# Why (11 Nov 2026 outage): nginx serves frontend/dist, and Vite empties its
# output folder before it writes. Two automatic deploys plus a manual build
# ran at once, the 4 GB server ran out of memory, the build was killed half
# way, and nginx had no site to serve - staff.oooshtours.co.uk showed a 500.
#
# So this script:
#   1. lets only ONE frontend build run at a time (a second one waits);
#   2. builds into dist-new/ and only swaps it in once the build succeeded,
#      so a failed build leaves the old site up;
#   3. keeps the previous build in dist-prev/ - to roll back:
#        cd /var/www/ooosh-portal/frontend && mv dist dist-bad && mv dist-prev dist
# =============================================================

set -euo pipefail

cd "$(dirname "$0")/../frontend"

# One build at a time. Waits up to 20 minutes for another build to finish.
exec 9>/tmp/ooosh-frontend-build.lock
if ! flock -w 1200 9; then
  echo "!!! Another frontend build is still running after 20 minutes - not building."
  exit 1
fi

rm -rf dist-new
# `npm run build` is `tsc -b && vite build`; the extra flags go to vite.
npm run build -- --outDir dist-new --emptyOutDir

# Only reached if the build succeeded (set -e). Swap it in.
rm -rf dist-prev
if [ -d dist ]; then mv dist dist-prev; fi
mv dist-new dist

echo "Frontend built and live (previous build kept in frontend/dist-prev)."

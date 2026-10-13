#!/bin/sh
# Copy the app into dist/<path>/ so it's served at yourdomain.com/<path>/
# Usage: sh build.sh [path]   (default: tack)
set -e
cd "$(dirname "$0")"
BASE="${1:-tack}"
rm -rf dist
mkdir -p "dist/$BASE"
cp index.html app.js styles.css LICENSE "dist/$BASE/"
echo "Built dist/$BASE/"

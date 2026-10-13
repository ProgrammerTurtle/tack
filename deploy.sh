#!/bin/sh
# Build and publish Tack to Cloudflare. First time: npx wrangler login
set -e
cd "$(dirname "$0")"
sh build.sh tack
npx --yes wrangler@4 deploy

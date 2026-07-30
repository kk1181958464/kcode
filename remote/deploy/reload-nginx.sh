#!/usr/bin/env sh
set -eu

/www/server/nginx/sbin/nginx -t
/www/server/nginx/sbin/nginx -s reload

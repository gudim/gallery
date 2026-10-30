#!/bin/sh
# Creates missing Authelia secrets in /config/secrets; never touches existing ones (a new storage
# key would make the DB unreadable, a new signing key would void issued tokens). Run as root by the
# authelia-secrets service before every start; hands /config to uid 1000, which Authelia runs as.
set -eu
dir=/config/secrets
mkdir -p "$dir"
chmod 700 "$dir"
cd "$dir"

rand() {
    [ -s "$1" ] && return
    authelia crypto rand --length 64 --charset alphanumeric | sed 's/^Random Value: //' > "$1.new"
    mv "$1.new" "$1"
}

rand session_secret
rand storage_key
rand oidc_hmac
rand oidc_client_secret

# Authelia keeps only the digest; the plain secret goes into Gallery's OAuth settings.
if [ ! -s oidc_client_secret.digest ]; then
    authelia crypto hash generate pbkdf2 --variant sha512 --password "$(cat oidc_client_secret)" \
        | sed 's/^Digest: //' > oidc_client_secret.digest.new
    mv oidc_client_secret.digest.new oidc_client_secret.digest
fi

if [ ! -s oidc_jwks.pem ]; then
    authelia crypto pair rsa generate --bits 2048 --directory "$dir" \
        --file.private-key oidc_jwks.pem.new --file.public-key oidc_jwks.pub.pem >/dev/null
    mv oidc_jwks.pem.new oidc_jwks.pem
fi

chmod 600 ./*
chown -R 1000:1000 /config

# Dev OIDC: Authelia for Gallery's dev stack

A local Authelia behind Caddy (`tls internal`) as the OIDC provider for `mise dev`, the same
pattern as travel-album's `compose.dev.yaml`. Issuer: `https://auth.gallery.localhost:9444`
(travel-album uses 9443, so both can run). Browsers resolve `*.localhost` to 127.0.0.1;
immich-server reaches the same URL through a network alias on the `gallery-dev-oidc` network and
trusts Caddy's root CA via `NODE_EXTRA_CA_CERTS`.

## Start order (from the repo root)

```bash
# 1. Authelia + Caddy (creates secrets, the gallery-dev-oidc network and the Caddy CA volume)
docker compose -f deployment/trips/dev-oidc/compose.yml up -d --wait

# 2. Gallery's dev stack with the override (instead of plain `mise dev`)
docker compose -f docker/docker-compose.dev.yml -f deployment/trips/dev-oidc/gallery-dev.override.yml up
```

Step 1 must come first: the override uses its network and volume as `external`, and
`NODE_EXTRA_CA_CERTS` is read once when node starts. If immich-server started before Caddy issued
its CA, restart it: `docker restart immich_server`.

Stop: `docker compose -f deployment/trips/dev-oidc/compose.yml down` (add `-v` to wipe secrets,
sessions and the CA; new ones are generated on the next start, so re-enter the client secret).

## Client secret

```bash
docker compose -f deployment/trips/dev-oidc/compose.yml exec -T authelia cat /config/secrets/oidc_client_secret
```

Generated once into the `gallery-dev-oidc-authelia` volume by `init-secrets.sh`; later starts keep it.

## Gallery admin: Administration → Settings → Authentication → OAuth

| Setting                      | Value                                   |
| ---------------------------- | --------------------------------------- |
| Issuer URL                   | `https://auth.gallery.localhost:9444`   |
| Client ID                    | `immich`                                |
| Client secret                | output of the command above             |
| Scope                        | `openid profile email`                  |
| Token endpoint auth method   | `client_secret_post` (Immich's default) |
| Signing algorithm            | `RS256` (default)                       |
| Auto register                | on                                      |
| Auto launch, mobile override | off                                     |

Redirect URIs registered in Authelia: `app.immich:///oauth-callback`,
`http://localhost:{2283,3000}/auth/login`, `http://localhost:{2283,3000}/user-settings`. PKCE (S256)
is required; Immich sends it whenever discovery advertises it.

The mobile app cannot use this issuer as is: a phone neither resolves `auth.gallery.localhost`
nor trusts Caddy's CA.

## Dev users (`users.dev.yml`)

| User    | Email                     | Password      |
| ------- | ------------------------- | ------------- |
| `owner` | `owner@gallery.localhost` | `gallery-dev` |
| `anna`  | `anna@gallery.localhost`  | `gallery-dev` |

On first OAuth sign-in Immich links an existing local user with the same email, otherwise
auto-register creates one.

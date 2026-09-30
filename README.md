# SneakySpeedTest

A temporary desktop browser test comparing resourcepack delivery through the production custom domain and the R2 development domain. Participants run the test, review the disclosure and optional username, then explicitly submit. There is no login, dashboard, or automatic deletion.

## Run locally

Requires Node.js 22 or newer. There are no third-party runtime dependencies.

```sh
npm ci
cp .env.example .env
# Fill in PocketBase credentials in .env if submissions are needed.
npm start
```

Open http://localhost:3000. Without PocketBase environment variables the download test and local report export still work, but submission is disabled. A local `.env` is loaded automatically and ignored by Git and Docker.

## PocketBase

Server environment variables:

| Variable | Purpose |
| --- | --- |
| `POCKETBASE_HOST` | Existing instance URL, such as `https://db.rawb.tv` |
| `POCKETBASE_USERNAME` | `_superusers` identity, server-side only |
| `POCKETBASE_PASSWORD` | Password, server-side only |
| `POCKETBASE_COLLECTION` | Defaults to `sneakyspeedtest` |
| `TRUST_PROXY_HEADERS` | Defaults to `false`. Set `true` only behind the trusted Cloudflare/Traefik path |
| `PORT` | Defaults to `3000` locally, `8080` in the image |
| `PRODUCTION_DOWNLOAD_URL` | Optional replacement for the production resourcepack URL |
| `COMPARISON_DOWNLOAD_URL` | Optional replacement for the R2 development resourcepack URL |

The agreed collection is `sneakyspeedtest`, ID `pbc_1703016921`. Prepare an existing collection once:

```sh
npm run setup:db
```

The command adds missing fields and a unique submission ID index, preserving existing fields, records, and API rules. Runtime startup never changes the schema. Keep public API rules locked; the server authenticates as `_superusers`. Credentials are never sent to the client, included in the image, or committed. Supply ongoing credentials through your container environment; the temporary implementation credentials are not deployment configuration.

Top-level fields are `submission_id`, `username`, `status`, `country`, `asn`, `production_mbps`, `comparison_mbps`, and `results`. The JSON field contains all individual samples, endpoint URLs, test order, configuration ID, browser information, background-tab flag, client timestamps, and server submission timestamp. Summary speeds use successful samples only. A zero summary field can mean no successful samples; the JSON summary distinguishes this with `null`. Partial speeds remain in the individual samples.

Submit retries use the same UUID and the unique index, so a lost response does not create duplicates. A successful submission is immutable; run a new test for another report. No results or request IPs are written to local files or application logs. Dani will remove the deployment and delete its data after about two weeks; no cleanup job runs.

## Measurement

Four sequential range downloads: 16 MiB from each endpoint in each of two rounds, with a 30-second deadline per sample. Round one order is random; round two reverses it. Round two uses the next 16 MiB segment. Planned usage is 64 MiB. Browsers and networking may transfer a little extra buffered data when cancelled.

Downloads stream into a byte counter and are discarded. The browser cache is bypassed with `cache: 'no-store'`; URLs are unchanged and have no cache-busting query. This also sends browser cache-control directives, which may affect intermediary cache treatment. Capture the returned cache status rather than assuming an edge cache hit. We require `206` responses, check the returned range when exposed, and reject unexpected payload sizes instead of accidentally timing an entire pack. Credentials are omitted and redirects are rejected.

Each sample records elapsed request time, time until headers, time until the first readable body chunk, byte count, average Mbps, body-transfer Mbps, status, and accessible response headers. Overall route speeds divide successful bytes by their combined total request time. Browser first-chunk timing includes browser buffering and is not an exact network TTFB. DNS/TLS timings and packet loss are not measured. Hidden-tab runs are flagged, not silently discarded. Browser measurements do not reproduce Minecraft exactly, and the throttled R2 development endpoint is a diagnostic comparison, not a production hosting recommendation.

## Cloudflare setup

Set bucket CORS:

```json
[
  {
    "AllowedOrigins": ["http://localhost:3000", "https://speedtest.rawb.tv"],
    "AllowedMethods": ["HEAD", "GET"],
    "ExposeHeaders": ["CF-Ray", "CF-Cache-Status", "Content-Range", "ETag"]
  }
]
```

One bounded `Range` is CORS-safelisted, so it does not need an explicit allowed header or preflight. After changing CORS, purge the cached production resourcepack URL so old responses without CORS headers are not reused. Both origins must return `Access-Control-Allow-Origin`; missing exposed headers do not block the speed measurement but leave edge/cache details unknown. See [Cloudflare CORS documentation](https://developers.cloudflare.com/r2/buckets/cors/).

Enable [IP geolocation](https://developers.cloudflare.com/network/ip-geolocation/) for the site to receive `CF-IPCountry`. Add a Request Header Transform Rule scoped to `http.host eq "speedtest.rawb.tv"`, set dynamic header `X-Visitor-ASN` to:

```text
to_string(ip.src.asnum)
```

See [Cloudflare's ASN header example](https://developers.cloudflare.com/changelog/post/2026-09-22-concat-argument-limit/). Preserve these headers through Traefik. Set `TRUST_PROXY_HEADERS=true` only if the container is reachable solely through your trusted proxy path and the origin is protected against requests bypassing Cloudflare. The application reads country and ASN, never reads the visitor IP, and uses no external IP lookup. Missing or invalid metadata becomes unknown. ASN identifies a network, not necessarily the player's retail ISP.

The page discloses what the application stores. Infrastructure access logs and Cloudflare processing are outside the application; configure their retention separately if needed. There are no analytics, tracking cookies, local storage, or background submissions.

## Docker and deployment

```sh
docker build -t sneakyspeedtest:latest .
```

Adapt `docker-compose.example.yml` to your existing Traefik network, entrypoint, TLS resolver, registry, and environment management. The service listens on port 8080 and needs no volume. The example exposes no host port. Container health checks `/healthz` for process liveness; it does not claim PocketBase is reachable.

`.github/workflows/deploy.yml` follows OverlayV1: verify on Node 22, fetch `/Registry` credentials via Infisical OIDC, publish `$REGISTRY_HOST/sneakyspeedtest:latest`, then fetch `/Watchtower` and trigger Watchtower. Configure repository secrets `INFISICAL_IDENTITY_ID` and `INFISICAL_DOMAIN`, and authorize this repository in the Infisical OIDC identity. It uses project `lords-of-minecraft`, environment `prod`. No secret values were copied from OverlayV1.

Production container creation, DNS/routing, and production environment variables are managed manually by Dani.

Until both Infisical repository secrets are set, pushes run the tests and skip image publishing and Watchtower with a notice.

## Verify

```sh
npm test
```

Tests cover range measurement, cancellation/timeouts, partial results, submission validation, proxy metadata, HTTP routes, and PocketBase retry/idempotency behavior without using the live database.

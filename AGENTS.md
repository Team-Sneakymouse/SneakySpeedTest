# AGENTS.md

## Repo-specific rules

- **No runtime schema changes.** Schema lives only in `lib/schema.mjs` and `scripts/setup-db.mjs` (`npm run setup:db`), never in server startup.
- **Privacy.** Never log results, IPs or credentials, and never send PocketBase credentials to the client. `server.mjs` logs fixed strings only.
- **Idempotent submit.** Keep `submission_id` (UUID) with its unique index so retries don't duplicate; successful submissions are immutable.
- **Zero runtime dependencies.** Don't add npm dependencies. A push to `main` deploys via the CI workflow, so run `npm test` first.
- **Keep the CSP strict.** No inline scripts or styles; `server.mjs` sets `script-src 'self'`.
- **`TRUST_PROXY_HEADERS` must stay `false`** unless behind a trusted proxy, or country/ASN can be spoofed. Keep the 64 KiB cap in `readJson`.
- Temporary project: the README plans removal about two weeks after deploy.

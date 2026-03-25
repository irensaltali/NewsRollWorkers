# NewsRoll Workers

Cloudflare Workers backend for:

- multi-source news feed ingestion and media generation
- protected admin dashboard APIs and admin domain asset hosting
- async media generation manifests backed by R2
- RevenueCat entitlement sync
- APNs installation registration

## Local setup

1. `cd NewsRollWorkers`
2. `cp .dev.vars.example .dev.vars`
3. `npm install`
4. `wrangler d1 migrations apply newsroll --local`
5. `npm test`
6. `npm run dev`

For the admin surface:

1. `cd ../NewsRollAdmin`
2. `npm install`
3. `npm run dev`
4. In another terminal: `cd ../NewsRollWorkers && npm run dev:admin`

## Notes

- No user login required — all access is via anonymous installation tokens.
- Multi-source ingestion is currently a stub; future work adds RSS, Reddit, and other source adapters.
- AI routes require `OPENAI_API_KEY` in every deployed environment.
- Admin routes are served by the dedicated `newsroll-admin` worker on `admin.newsroll.app` and `admin-staging.newsroll.app`.
- Admin access uses a DB-backed username/password session stored in D1.

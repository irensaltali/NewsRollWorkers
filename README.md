# NewsRoll Workers

Cloudflare Workers backend for:

- multi-source news feed ingestion and media generation
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

## Notes

- No user login required — all access is via anonymous installation tokens.
- Multi-source ingestion is currently a stub; future work adds RSS, Reddit, and other source adapters.
- AI routes require `OPENAI_API_KEY` in every deployed environment.

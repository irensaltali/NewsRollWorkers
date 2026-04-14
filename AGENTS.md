# Repository Guidelines

## Project Structure & Module Organization
`src/` contains shared application logic for the Workers backend: API handlers, AI integration, DB access, feed generation, analytics, and media pipeline helpers. `workers/` holds deployable Cloudflare Worker entrypoints and Wrangler configs for `api`, `ingest`, and `processor`; keep worker-specific code close to its `index.mjs` and `wrangler.jsonc`. `tests/` contains Node test suites such as `api.test.mjs` and `media-worker.test.mjs`. Supporting material lives in `docs/`, `data/`, and `shaped/`. D1 SQL migrations for the API worker live under `workers/api/migrations/`.

## Build, Test, and Development Commands
Use `npm install` for local dependencies and `cp .dev.vars.example .dev.vars` to create local env vars. Run `wrangler d1 migrations apply newsroll --local` before local API work. Main commands:

- `npm run dev` starts the API worker locally.
- `npm run dev:media` runs the media worker config locally.
- `npm test` runs all suites with Node’s built-in test runner.
- `npm run deploy:staging` deploys the staging API worker.
- `npm run deploy` runs `deploy.sh production` and deploys the production workers.

## Coding Style & Naming Conventions
This repo uses ESM JavaScript (`.mjs`). Follow the existing style: 2-space indentation in source files, double quotes, semicolons, and small focused helpers. Use `camelCase` for functions and variables, `UPPER_SNAKE_CASE` for env bindings, and descriptive worker/module names such as `media-pipeline.mjs` or `event-analytics.mjs`. No formatter or linter is configured, so match surrounding code closely.

## Testing Guidelines
Write tests with `node:test` and `node:assert/strict`. Place new coverage in `tests/` with the `*.test.mjs` pattern. Prefer focused unit tests around modules in `src/`, plus request-level tests for worker routes when behavior changes. Run `npm test` before opening a PR; add or update fixtures when API payloads, feed data, or auth behavior change.

## Commit & Pull Request Guidelines
Recent history follows Conventional Commit style: `feat:`, `fix:`, `refactor:`, `chore:`. Keep subjects imperative and scoped to one change. PRs should describe the affected worker or module, note any new secrets, bindings, queues, or migrations, and include example requests or responses for API changes. Link the related issue when available and call out staging or production deployment impact explicitly.

## Security & Configuration Tips
Never commit `.dev.vars` or live secrets. Keep local values in `.dev.vars`, and use `wrangler secret put` for deployed environments. If you change Wrangler bindings, routes, KV, R2, queues, or Durable Objects, update the relevant `workers/*/wrangler.jsonc` file and mention the operational change in the PR.

# White-label Server Reseller Bot

A reusable Telegram bot template for selling cloud servers through a reseller API. Each deployment is isolated: one Telegram bot token, one reseller API key, one brand and one local customer database.

## What it includes

- Fully white-label customer UI: no upstream provider name is shown to customers.
- Live plan catalog from the reseller API.
- Configurable percentage/fixed markup and price rounding.
- Local customer wallets.
- Manual top-up workflow with receipt review by admins.
- Server purchase, ownership mapping, list/details, power on/off, traffic, password reset and deletion.
- Background provisioning watcher that delivers IP/root credentials once the server is ready.
- SQLite persistence.
- Docker deployment.

## Setup

```bash
cp .env.example .env
npm install
npm test
npm start
```

For Docker:

```bash
cp .env.example .env
docker compose up -d --build
```

## Required environment variables

- `BOT_TOKEN`: Telegram bot token.
- `ADMIN_IDS`: comma-separated Telegram numeric IDs for bot admins.
- `UPSTREAM_API_URL`: reseller API base URL ending in `/api/v1`.
- `UPSTREAM_API_KEY`: API key for this reseller deployment.

Branding, pricing, payment text, plan filtering and provisioning options are configured in `.env.example`.

## Deployment model

Use one clone/container per reseller. Do not share one API key between unrelated sellers. The upstream key must never be sent to Telegram clients and must stay only in the bot server environment.

The bot keeps downstream customer balances and server ownership locally, while the upstream reseller account remains the payer/owner seen by the core API.

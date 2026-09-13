# Mahan Cloud Telegram VPS Bot

Production-ready, white-label Telegram reseller bot. Customer messages show only the configured brand; the upstream provider name and API key never reach the Telegram UI.

## Supported upstream API

The bot is implemented against the reseller API in `hamoon-private`:

- Base URL: `https://pay.hamooncloud.ir/api/v1`
- Authentication: `Authorization: Bearer $HAMOON_API_KEY`
- Account: `GET /me`, `/wallet`, `/usage`, `/prices`
- Servers: list, detail, create, power on/off, reset root password, traffic and permanent delete.

The API does **not** expose a reboot endpoint in v1; consequently the bot does not pretend that restart works. The user can safely power off then power on.

## Features

- Main menu: buy server, my servers, wallet, top-up and support.
- Live plan/pricing catalogue from the reseller API; no hard-coded upstream pricing.
- Percentage or fixed reseller margin, with price rounding.
- Local SQLite customer wallet, manual deposit receipt and atomic admin approval/rejection.
- Local ownership map: every server action verifies its Telegram owner before calling the API.
- Provisioning watcher sends IP and one-time root password when the server becomes active.
- Power on/off, password reset, traffic display, status and two-step irreversible deletion.
- Admin panel: users, active servers, pending deposits, customer balances and upstream connectivity/balance. `/credit <telegramId> <amount>` credits a customer manually.
- Docker deployment with a persistent `./data` volume and safe API error handling.

## Deploy

```bash
git clone https://github.com/hsdarestani/hmbots.git
cd hmbots
cp .env.example .env
# Set BOT_TOKEN, HAMOON_API_KEY and payment-card details
docker compose up -d --build
docker compose logs -f bot
```

For non-Docker development:

```bash
npm ci
npm test
npm start
```

## Required environment

- `BOT_TOKEN`
- `HAMOON_API_KEY`

Defaults are already set for Mahan Cloud, admin `1478447415`, support `@MBA_200007`, and the production API URL. Override `ADMIN_IDS`, `BRAND_NAME`, or `SUPPORT_USERNAME` only for another white-label deployment.

Use `PROFIT_TYPE=percentage` and `PROFIT_VALUE=30` for a 30% margin (e.g. 300,000 becomes 390,000). Use `PROFIT_TYPE=fixed` for a fixed currency margin.

Never commit a real `.env` or forward a bot API key/root password.

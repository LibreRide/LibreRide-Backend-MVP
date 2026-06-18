# LibreRide Backend MVP

Cloudflare-first backend starter for LibreRide Miami MVP.

## What is included

* Cloudflare Worker API
* Durable Object ride sessions with WebSocket support
* Supabase/PostgreSQL schema with PostGIS
* Driver location and online/offline endpoints
* Rider ride request endpoint
* Admin driver approval endpoints
* Stripe webhook starter
* Wrangler deployment configuration

## Requirements

* Node.js 20+
* Cloudflare account
* Supabase project
* Stripe account
* Wrangler CLI access

## Setup

```bash
npm install
cp .env.example .dev.vars
```

Fill `.dev.vars` for local development.

For Cloudflare production secrets:

```bash
wrangler secret put SUPABASE\\\_URL
wrangler secret put SUPABASE\\\_SERVICE\\\_ROLE\\\_KEY
wrangler secret put STRIPE\\\_SECRET\\\_KEY
wrangler secret put STRIPE\\\_WEBHOOK\\\_SECRET
wrangler secret put MAPBOX\\\_ACCESS\\\_TOKEN
```

## Database

1. Open Supabase SQL Editor.
2. Paste and run `sql/schema.sql`.
3. Enable Supabase Auth.
4. Create initial admin user manually in Supabase Auth and insert matching row in `users` with role `admin`.

## Local development

```bash
npm run dev
```

Health check:

```bash
curl http://localhost:8787/health
```

## Deploy

```bash
npx wrangler login
npm run deploy
```

## Important notes

This is an MVP scaffold. Before production launch you still need:

* Full RLS policies
* Stripe Checkout/Billing session creation endpoints
* Stripe Connect driver onboarding endpoint
* Mapbox distance/duration integration
* Twilio/Firebase notification implementation
* Complete driver/rider mobile apps
* Legal/compliance review for Miami-Dade operations


# LeadHunt — Project Context

## What This Is
A lead generation tool that finds local businesses without websites on Google Maps, then uses AI to generate professional websites for them as a sales pitch.

## Business Model
- Find businesses with no website using Google Maps API
- Generate a custom website for them with one click using Claude AI
- Pitch the website to the business owner for £200–£500
- Future: sell as a SaaS subscription + sell a course on how to use it

## Live URLs
- **Frontend (Netlify):** (https://astounding-bubblegum-cff1c5.netlify.app/)
- **Backend (Render):** https://leadhunt-server.onrender.com
- **GitHub repo:** https://github.com/Kolide460/leadhunt-server

## Tech Stack
- **Frontend:** Single HTML file (business-finder.html) hosted on Netlify
- **Backend:** Node.js + Express server hosted on Render (free tier)
- **Database:** SQLite via better-sqlite3 (file: leadhunt.db, set DB_PATH env var to persist across Render deploys)
- **Auth:** Email/password with bcryptjs, HMAC-signed tokens (90-day expiry)
- **APIs used:**
  - Google Places API (Text Search + Place Details + Photos)
  - Anthropic Claude API (website generation + logo generation)

## Auth & Subscription Tiers
- **Free:** 2 searches, no card required — register with email/password
- **Starter:** £29/month — unlimited searches
- **Pro:** £79/month — unlimited searches + priority support
- **Agency:** £199/month — unlimited searches + team features

## Backend Endpoints
- `POST /register` — create account (email + password)
- `POST /auth` — login (email + password) → returns token
- `GET /usage` — current tier + searches used (requires auth)
- `GET /search?query=` — searches Google Maps (increments usage)
- `GET /details?place_id=` — gets rich business data (hours, reviews, photos)
- `GET /photo?ref=&maxwidth=` — gets Google Places photo URL
- `GET /scrape?url=` — scrapes existing website for logo, social media, email
- `POST /generate-logo` — generates SVG logo using Claude
- `POST /generate` — generates full website HTML using Claude
- `POST /create-checkout-session` — creates Stripe checkout session
- `GET /payment-success?session_id=` — confirms payment + upgrades user in DB
- `POST /webhook` — Stripe webhook (handles cancellations, renewals)
- `GET /debug` — checks API keys are loaded

## Environment Variables on Render
- `PLACES_KEY` = Google Places API key
- `ANTHROPIC_KEY` = Anthropic API key
- `TOKEN_SECRET` = HMAC secret for auth tokens (required in prod)
- `DB_PATH` = path to SQLite file (e.g. `/data/leadhunt.db` — use Render disk)
- `STRIPE_SECRET_KEY` = Stripe secret key
- `STRIPE_PRICE_STARTER` = Stripe price ID for Starter tier
- `STRIPE_PRICE_PRO` = Stripe price ID for Pro tier
- `STRIPE_PRICE_AGENCY` = Stripe price ID for Agency tier
- `STRIPE_WEBHOOK_SECRET` = Stripe webhook signing secret
- `FRONTEND_URL` = frontend URL for Stripe redirect (default: https://leadhunts.netlify.app)

## Current Features
- Search businesses by type and location
- Filter for businesses with no website
- Shows name, address, phone, rating
- Generates full HTML website with:
  - Real opening hours from Google
  - Real customer reviews
  - Real business photos as hero/gallery
  - AI-generated SVG logo if no logo found
  - Social media links scraped from existing site
  - Clickable phone number
  - Mobile responsive design
- Download generated website as HTML file

## Known Issues / Things To Improve
- Preview iframe broken on Netlify due to CSP (shows success screen + download instead)
- Render free tier has ephemeral filesystem — use a Render persistent disk and set DB_PATH to keep SQLite across deploys
- Want to add a dashboard to track leads contacted
- Want to improve logo generation quality
- Need a proper domain

## Deployment Process
- Backend: push server.js to GitHub → Render auto-deploys
- Frontend: drag business-finder.html onto netlify.com/drop

## Files
- `business-finder.html` — the entire frontend
- `server/server.js` — the backend
- `server/package.json` — backend dependencies

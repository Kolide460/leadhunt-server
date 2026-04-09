const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const bcrypt = require('bcryptjs');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

const app = express();
const PORT = process.env.PORT || 3000;
const PLACES_KEY = process.env.PLACES_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
const TIER_LIMITS = {
  free:    { searches: 4,   websites: 2   },
  basic:   { searches: 30,  websites: 15  },
  starter: { searches: 30,  websites: 15  }, // legacy alias for basic
  pro:     { searches: 200, websites: 100 },
  agency:  { searches: 200, websites: 100 }, // legacy alias for pro
};
const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

// TOKEN_SECRET — must be set in prod or all sessions reset on restart
const TOKEN_SECRET = process.env.TOKEN_SECRET || (() => {
  if (process.env.NODE_ENV === 'production') {
    console.warn('[WARN] TOKEN_SECRET not set — sessions will reset on every restart. Add it to Render env vars.');
  }
  return crypto.randomBytes(32).toString('hex');
})();

// ── DATABASE ──────────────────────────────────────────────────────────────────
let db;
try {
  const Database = require('better-sqlite3');
  const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'leadhunt.db');
  db = new Database(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      tier TEXT NOT NULL DEFAULT 'free',
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT,
      subscription_status TEXT,
      searches_used INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  // Migrate: add usage columns for existing databases
  try { db.exec(`ALTER TABLE users ADD COLUMN websites_used INTEGER NOT NULL DEFAULT 0`); } catch(_) {}
  try { db.exec(`ALTER TABLE users ADD COLUMN usage_period_start INTEGER NOT NULL DEFAULT 0`); } catch(_) {}
  console.log('[DB] SQLite initialized:', DB_PATH);
} catch(e) {
  console.error('[DB] Failed to initialize database:', e.message);
  process.exit(1);
}

const stmts = {
  getUser:             db.prepare('SELECT * FROM users WHERE id = ?'),
  getUserByEmail:      db.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE'),
  getUserBySub:        db.prepare('SELECT * FROM users WHERE stripe_subscription_id = ?'),
  insertUser:          db.prepare('INSERT INTO users (id, email, password_hash, tier, searches_used, websites_used, usage_period_start, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 0, ?, ?, ?)'),
  incrementSearches:   db.prepare('UPDATE users SET searches_used = searches_used + 1, updated_at = ? WHERE id = ?'),
  incrementWebsites:   db.prepare('UPDATE users SET websites_used = websites_used + 1, updated_at = ? WHERE id = ?'),
  resetUsage:          db.prepare('UPDATE users SET searches_used = 0, websites_used = 0, usage_period_start = ?, updated_at = ? WHERE id = ?'),
  updateTier:          db.prepare('UPDATE users SET tier = ?, stripe_customer_id = ?, stripe_subscription_id = ?, subscription_status = ?, updated_at = ? WHERE id = ?'),
  updateSubStatus:     db.prepare('UPDATE users SET subscription_status = ?, tier = ?, updated_at = ? WHERE stripe_subscription_id = ?'),
};

// ── SECURITY ─────────────────────────────────────────────────────────────────
let helmet;
try { helmet = require('helmet'); } catch(e) { helmet = null; }
if (helmet) app.use(helmet());

const ALLOWED_ORIGINS = [
  'https://leadhunts.netlify.app',
  'https://astounding-bubblegum-cff1c5.netlify.app',
  'http://localhost:3000',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
  'null', // file:// in some browsers
];

app.use(cors({
  origin(origin, cb) {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'X-Auth-Token', 'stripe-signature'],
}));

// Raw body needed for Stripe webhook signature verification
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '2mb' }));

// Rate limiting
let rateLimit;
try { rateLimit = require('express-rate-limit'); } catch(e) { rateLimit = null; }

const makeLimit = (windowMs, max) => rateLimit
  ? rateLimit({ windowMs, max, standardHeaders: true, legacyHeaders: false })
  : (_req, _res, next) => next();

const generalLimiter = makeLimit(15 * 60 * 1000, 200); // 200 req / 15 min
const searchLimiter  = makeLimit(60 * 1000, 20);        // 20 req / min
const authLimiter    = makeLimit(15 * 60 * 1000, 20);   // 20 attempts / 15 min

app.use(generalLimiter);

// ── TOKEN UTILS ───────────────────────────────────────────────────────────────
function signToken(payload) {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', TOKEN_SECRET).update(data).digest('base64url');
  return `${data}.${sig}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot === -1) return null;
  const data = token.slice(0, dot);
  const sig  = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', TOKEN_SECRET).update(data).digest('base64url');
  if (sig !== expected) return null;
  try {
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString());
    if (payload.expiresAt && Date.now() > payload.expiresAt) return null;
    return payload;
  } catch { return null; }
}

// ── IN-MEMORY SEARCH CACHE ────────────────────────────────────────────────────
const searchCache = new Map();
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

function getCached(key) {
  const entry = searchCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL) { searchCache.delete(key); return null; }
  return entry.data;
}

function setCache(key, data) {
  if (searchCache.size >= 500) searchCache.delete(searchCache.keys().next().value);
  searchCache.set(key, { data, timestamp: Date.now() });
}

// ── AUTH MIDDLEWARE ───────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const token = req.headers['x-auth-token'];
  const payload = verifyToken(token);
  if (!payload?.userId) return res.status(401).json({ error: 'Not authenticated. Please log in.' });
  const user = stmts.getUser.get(payload.userId);
  if (!user) return res.status(401).json({ error: 'Account not found. Please log in again.' });
  req.user = user;
  next();
}

function checkUsageLimit(type) {
  return (req, res, next) => {
    const { tier, usage_period_start } = req.user;
    const limits = TIER_LIMITS[tier] || TIER_LIMITS.free;

    // Reset monthly usage if the current period has expired (or never started)
    if (Date.now() - (usage_period_start || 0) >= MONTH_MS) {
      const now = Date.now();
      stmts.resetUsage.run(now, now, req.user.id);
      req.user.searches_used = 0;
      req.user.websites_used = 0;
      req.user.usage_period_start = now;
    }

    if (type === 'search' && req.user.searches_used >= limits.searches) {
      return res.status(402).json({
        error: 'Monthly lead search limit reached',
        limit_type: 'searches',
        used: req.user.searches_used,
        limit: limits.searches,
        tier,
        upgrade: true,
      });
    }
    if (type === 'website' && req.user.websites_used >= limits.websites) {
      return res.status(402).json({
        error: 'Monthly website generation limit reached',
        limit_type: 'websites',
        used: req.user.websites_used,
        limit: limits.websites,
        tier,
        upgrade: true,
      });
    }
    next();
  };
}

// ── POST /register ────────────────────────────────────────────────────────────
app.post('/register', authLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Invalid email address.' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });

  const existing = stmts.getUserByEmail.get(email.trim());
  if (existing) return res.status(409).json({ error: 'An account with this email already exists.' });

  const id = crypto.randomUUID();
  const password_hash = await bcrypt.hash(password, 12);
  const now = Date.now();
  stmts.insertUser.run(id, email.toLowerCase().trim(), password_hash, 'free', now, now, now);

  const token = signToken({ userId: id, createdAt: now, expiresAt: now + 90 * 24 * 60 * 60 * 1000 });
  const limits = TIER_LIMITS.free;
  res.json({ token, tier: 'free', searches: { used: 0, limit: limits.searches, remaining: limits.searches }, websites: { used: 0, limit: limits.websites, remaining: limits.websites } });
});

// ── POST /auth ────────────────────────────────────────────────────────────────
app.post('/auth', authLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });

  const user = stmts.getUserByEmail.get(email.trim());
  if (!user) {
    // Constant-time response to prevent email enumeration
    await bcrypt.hash('dummy', 12);
    return res.status(401).json({ error: 'Invalid email or password.' });
  }

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return res.status(401).json({ error: 'Invalid email or password.' });

  const now = Date.now();
  const token = signToken({ userId: user.id, createdAt: now, expiresAt: now + 90 * 24 * 60 * 60 * 1000 });
  const limits = TIER_LIMITS[user.tier] || TIER_LIMITS.free;
  const searches_used = now - (user.usage_period_start || 0) >= MONTH_MS ? 0 : user.searches_used;
  const websites_used = now - (user.usage_period_start || 0) >= MONTH_MS ? 0 : (user.websites_used || 0);
  res.json({
    token,
    tier: user.tier,
    searches: { used: searches_used, limit: limits.searches, remaining: Math.max(0, limits.searches - searches_used) },
    websites: { used: websites_used, limit: limits.websites, remaining: Math.max(0, limits.websites - websites_used) },
  });
});

// ── GET /usage ────────────────────────────────────────────────────────────────
app.get('/usage', requireAuth, (req, res) => {
  const { tier, searches_used, websites_used, usage_period_start } = req.user;
  const limits = TIER_LIMITS[tier] || TIER_LIMITS.free;
  const now = Date.now();
  const periodExpired = now - (usage_period_start || 0) >= MONTH_MS;
  const s = periodExpired ? 0 : (searches_used || 0);
  const w = periodExpired ? 0 : (websites_used || 0);
  res.json({
    tier,
    searches:  { used: s, limit: limits.searches,  remaining: Math.max(0, limits.searches  - s) },
    websites:  { used: w, limit: limits.websites,   remaining: Math.max(0, limits.websites  - w) },
    period_start:    usage_period_start || null,
    period_resets_at: usage_period_start ? usage_period_start + MONTH_MS : null,
  });
});

// ── STRIPE ────────────────────────────────────────────────────────────────────
let stripe = null;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
if (STRIPE_SECRET_KEY) {
  try { stripe = require('stripe')(STRIPE_SECRET_KEY); }
  catch(e) { console.warn('Stripe failed to load:', e.message); }
}

app.post('/create-checkout-session', requireAuth, async (req, res) => {
  if (!stripe) {
    return res.status(503).json({ error: 'Payments not configured. Add STRIPE_SECRET_KEY and price IDs to Render env vars.' });
  }
  const PRICE_MAP = {
    basic:   process.env.STRIPE_PRICE_BASIC || process.env.STRIPE_PRICE_STARTER,
    starter: process.env.STRIPE_PRICE_BASIC || process.env.STRIPE_PRICE_STARTER, // legacy
    pro:     process.env.STRIPE_PRICE_PRO,
  };
  const { tier = 'basic' } = req.body || {};
  const priceId = PRICE_MAP[tier];
  if (!priceId) {
    return res.status(503).json({ error: `Add STRIPE_PRICE_${tier.toUpperCase()} to Render env vars.` });
  }
  try {
    const FRONTEND = process.env.FRONTEND_URL || 'https://leadhunts.netlify.app';
    const sessionParams = {
      payment_method_types: ['card'],
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${FRONTEND}?payment=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${FRONTEND}?payment=cancelled`,
      metadata: { userId: req.user.id, tier },
      subscription_data: { metadata: { userId: req.user.id, tier } },
    };
    if (req.user.stripe_customer_id) {
      sessionParams.customer = req.user.stripe_customer_id;
    } else {
      sessionParams.customer_email = req.user.email;
    }
    const session = await stripe.checkout.sessions.create(sessionParams);
    res.json({ checkoutUrl: session.url });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/payment-success', requireAuth, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Payments not configured' });
  const { session_id } = req.query;
  try {
    const session = await stripe.checkout.sessions.retrieve(session_id, { expand: ['subscription'] });
    if (session.payment_status !== 'paid') {
      return res.status(402).json({ error: 'Payment not confirmed' });
    }
    const tier = session.metadata?.tier || 'basic';
    const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id;
    const subscriptionId = typeof session.subscription === 'string'
      ? session.subscription
      : session.subscription?.id;
    stmts.updateTier.run(tier, customerId, subscriptionId, 'active', Date.now(), req.user.id);
    res.json({ tier });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /webhook — Stripe subscription lifecycle ──────────────────────────────
app.post('/webhook', async (req, res) => {
  const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
  if (!stripe || !WEBHOOK_SECRET) return res.status(200).json({ received: true });

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], WEBHOOK_SECRET);
  } catch(e) {
    console.error('[Webhook] Signature verification failed:', e.message);
    return res.status(400).send(`Webhook Error: ${e.message}`);
  }

  // Price ID → tier reverse map (built at request time so env vars are resolved)
  const PRICE_TO_TIER = Object.fromEntries(
    Object.entries({
      basic:   process.env.STRIPE_PRICE_BASIC || process.env.STRIPE_PRICE_STARTER,
      starter: process.env.STRIPE_PRICE_BASIC || process.env.STRIPE_PRICE_STARTER,
      pro:     process.env.STRIPE_PRICE_PRO,
    }).filter(([, v]) => v).map(([k, v]) => [v, k === 'starter' ? 'basic' : k])
  );

  try {
    switch(event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        if (session.payment_status !== 'paid') break;

        // Retrieve line items to get the actual price ID — don't trust metadata.tier alone
        const sessionWithItems = await stripe.checkout.sessions.retrieve(session.id, {
          expand: ['line_items'],
        });
        const priceId = sessionWithItems.line_items?.data?.[0]?.price?.id;
        const tier = PRICE_TO_TIER[priceId] || session.metadata?.tier;

        if (!tier) {
          console.error('[Webhook] checkout.session.completed: unknown price ID', priceId, '— no tier mapped');
          break;
        }

        const userId = session.metadata?.userId;
        const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id;
        const subscriptionId = typeof session.subscription === 'string'
          ? session.subscription
          : session.subscription?.id;

        if (userId) {
          stmts.updateTier.run(tier, customerId, subscriptionId, 'active', Date.now(), userId);
          console.log('[Webhook] checkout.session.completed: user', userId, '→', tier, '(price:', priceId, ')');
        } else if (subscriptionId) {
          stmts.updateSubStatus.run('active', tier, Date.now(), subscriptionId);
          console.log('[Webhook] checkout.session.completed: subscription', subscriptionId, '→', tier);
        } else {
          console.warn('[Webhook] checkout.session.completed: no userId or subscriptionId in session', session.id);
        }
        break;
      }
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        stmts.updateSubStatus.run('cancelled', 'free', Date.now(), sub.id);
        console.log('[Webhook] Subscription cancelled, user downgraded to free:', sub.id);
        break;
      }
      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const tier = sub.metadata?.tier;
        if (sub.status === 'active' && tier) {
          stmts.updateSubStatus.run('active', tier, Date.now(), sub.id);
        } else if (sub.status === 'past_due' || sub.status === 'unpaid') {
          stmts.updateSubStatus.run(sub.status, 'free', Date.now(), sub.id);
          console.log('[Webhook] Subscription', sub.status, '— user downgraded:', sub.id);
        }
        break;
      }
      case 'invoice.payment_succeeded': {
        const invoice = event.data.object;
        if (invoice.subscription) {
          const sub = await stripe.subscriptions.retrieve(invoice.subscription);
          const tier = sub.metadata?.tier;
          if (tier) stmts.updateSubStatus.run('active', tier, Date.now(), sub.id);
        }
        break;
      }
    }
  } catch(e) {
    console.error('[Webhook] Handler error:', e.message);
  }

  res.json({ received: true });
});

// ── GET /search ───────────────────────────────────────────────────────────────
app.get('/search', requireAuth, checkUsageLimit('search'), searchLimiter, async (req, res) => {
  try {
    const { query } = req.query;
    const cacheKey = (query || '').toLowerCase().trim();
    const cached = getCached(cacheKey);
    if (cached) return res.json(cached);

    const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}&key=${PLACES_KEY}`;
    const response = await fetch(url);
    const data = await response.json();

    // Increment usage only on live (non-cached) responses
    stmts.incrementSearches.run(Date.now(), req.user.id);

    setCache(cacheKey, data);
    res.json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /details ──────────────────────────────────────────────────────────────
app.get('/details', requireAuth, async (req, res) => {
  try {
    const { place_id } = req.query;
    const fields = [
      'name','formatted_address','website','rating','user_ratings_total',
      'formatted_phone_number','international_phone_number','opening_hours',
      'reviews','photos','types','business_status','price_level',
      'editorial_summary','takeout','delivery','dine_in','reservable','url'
    ].join(',');
    const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${place_id}&fields=${fields}&key=${PLACES_KEY}`;
    const response = await fetch(url);
    const data = await response.json();
    res.json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /photo ────────────────────────────────────────────────────────────────
app.get('/photo', requireAuth, async (req, res) => {
  try {
    const { ref, maxwidth } = req.query;
    const w = maxwidth || 1200;
    const url = `https://maps.googleapis.com/maps/api/place/photo?maxwidth=${w}&photo_reference=${ref}&key=${PLACES_KEY}`;
    const response = await fetch(url);
    res.json({ photo_url: response.url });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /scrape ───────────────────────────────────────────────────────────────
app.get('/scrape', requireAuth, async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) return res.json({ error: 'No URL provided' });

    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/91.0 Safari/537.36' },
      signal: AbortSignal.timeout(8000)
    });

    const html = await response.text();
    const extracted = {
      instagram: extractSocial(html, 'instagram.com'),
      facebook: extractSocial(html, 'facebook.com'),
      twitter: extractSocial(html, 'twitter.com') || extractSocial(html, 'x.com'),
      tiktok: extractSocial(html, 'tiktok.com'),
      email: extractEmail(html),
      description: extractDescription(html),
      logo: extractBestLogo(html, url),
    };
    res.json(extracted);
  } catch(e) {
    res.json({ error: e.message, instagram: null, facebook: null, email: null, description: null, logo: null });
  }
});

function extractSocial(html, domain) {
  const regex = new RegExp(`https?://(?:www\\.)?${domain.replace('.', '\\.')}/[\\w.@/%-]+`, 'i');
  const match = html.match(regex);
  return match ? match[0].split('"')[0].split("'")[0].replace(/\/$/, '') : null;
}
function extractEmail(html) {
  const match = html.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  return match ? match[0] : null;
}
function extractDescription(html) {
  const m = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']{10,})["']/i)
    || html.match(/<meta[^>]+content=["']([^"']{10,})["'][^>]+name=["']description["']/i);
  return m ? m[1].substring(0, 400) : null;
}
function extractBestLogo(html, baseUrl) {
  const ogImage = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
  if (ogImage && ogImage[1]) return resolveUrl(ogImage[1], baseUrl);
  const logoImg = html.match(/<img[^>]+(?:class|id|alt)=["'][^"']*logo[^"']*["'][^>]+src=["']([^"']+)["']/i)
    || html.match(/<img[^>]+src=["']([^"']*logo[^"']*)["']/i);
  if (logoImg && logoImg[1]) return resolveUrl(logoImg[1], baseUrl);
  const favicon = html.match(/<link[^>]+rel=["'](?:shortcut )?icon["'][^>]+href=["']([^"']+)["']/i);
  if (favicon && favicon[1]) return resolveUrl(favicon[1], baseUrl);
  return null;
}
function resolveUrl(href, baseUrl) {
  if (!href) return null;
  if (href.startsWith('http')) return href;
  try { return new URL(href, baseUrl).href; } catch { return null; }
}

// ── POST /generate-logo ───────────────────────────────────────────────────────
app.post('/generate-logo', requireAuth, async (req, res) => {
  try {
    const { name, biztype } = req.body;
    const IDEOGRAM_KEY = process.env.IDEOGRAM_KEY;
    if (!IDEOGRAM_KEY) return res.status(500).json({ error: 'IDEOGRAM_KEY not set' });

    const prompt = `Professional business logo for "${name}", a ${biztype} business. Clean, modern, minimal design. White background. Suitable for use on a website header.`;

    const response = await fetch('https://api.ideogram.ai/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Api-Key': IDEOGRAM_KEY },
      body: JSON.stringify({
        image_request: { prompt, aspect_ratio: 'ASPECT_1_1', model: 'V_2', style_type: 'DESIGN', magic_prompt_option: 'ON' }
      })
    });

    const data = await response.json();
    const imageUrl = data.data?.[0]?.url;
    if (!imageUrl) return res.status(500).json({ error: 'No image returned from Ideogram', raw: data });
    res.json({ imageUrl });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /generate-image ──────────────────────────────────────────────────────
app.post('/generate-image', requireAuth, async (req, res) => {
  try {
    const { prompt, size = '1024x1024' } = req.body;
    const IDEOGRAM_KEY = process.env.IDEOGRAM_KEY;
    if (!IDEOGRAM_KEY) return res.status(500).json({ error: 'Ideogram API key not configured on server' });

    const aspectMap = {
      '1024x1024': 'ASPECT_1_1',
      '1792x1024': 'ASPECT_16_9',
      '1024x1792': 'ASPECT_9_16',
    };
    const aspect_ratio = aspectMap[size] || 'ASPECT_1_1';

    const response = await fetch('https://api.ideogram.ai/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Api-Key': IDEOGRAM_KEY },
      body: JSON.stringify({
        image_request: { prompt, aspect_ratio, model: 'V_2', style_type: 'DESIGN', magic_prompt_option: 'ON' }
      })
    });

    const data = await response.json();
    const imageUrl = data.data?.[0]?.url;
    if (!imageUrl) return res.status(500).json({ error: 'No image returned from Ideogram', raw: data });
    res.json({ dataUri: imageUrl });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /debug ────────────────────────────────────────────────────────────────
app.get('/debug', (req, res) => {
  res.json({
    has_anthropic_key: !!ANTHROPIC_KEY,
    key_preview: ANTHROPIC_KEY ? ANTHROPIC_KEY.substring(0, 10) + '...' : 'NOT SET',
    has_places_key: !!PLACES_KEY,
    stripe_enabled: !!stripe,
    cached_queries: searchCache.size,
    db_path: process.env.DB_PATH || path.join(__dirname, 'leadhunt.db'),
  });
});

// ── POST /generate ────────────────────────────────────────────────────────────
app.post('/generate', requireAuth, checkUsageLimit('website'), async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'ANTHROPIC_KEY not set' });

    // Count generation immediately so limits can't be gamed by disconnecting mid-stream
    stmts.incrementWebsites.run(Date.now(), req.user.id);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    let anthropicRes;
    try {
      anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01'
        },
        signal: AbortSignal.timeout(300000),
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 16000,
          stream: true,
          messages: [{ role: 'user', content: prompt }]
        })
      });
    } catch(fetchErr) {
      res.write(`event: error\ndata: ${JSON.stringify({ error: fetchErr.message })}\n\n`);
      res.end();
      return;
    }

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text();
      res.write(`event: error\ndata: ${JSON.stringify({ error: errText })}\n\n`);
      res.end();
      return;
    }

    const decoder = new TextDecoder();
    let buffer = '';

    try {
      for await (const chunk of anthropicRes.body) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6);
          if (raw === '[DONE]') continue;
          try {
            const evt = JSON.parse(raw);
            if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
              res.write(`data: ${JSON.stringify({ text: evt.delta.text })}\n\n`);
            } else if (evt.type === 'message_delta' && evt.delta?.stop_reason) {
              res.write(`data: ${JSON.stringify({ stop_reason: evt.delta.stop_reason })}\n\n`);
            } else if (evt.type === 'error') {
              res.write(`event: error\ndata: ${JSON.stringify({ error: evt.error })}\n\n`);
            }
          } catch(e) { /* skip malformed SSE event */ }
        }
      }
    } finally {
      res.end();
    }

  } catch(e) {
    if (!res.headersSent) {
      res.status(500).json({ error: e.message });
    } else {
      try { res.write(`event: error\ndata: ${JSON.stringify({ error: e.message })}\n\n`); res.end(); } catch(_) {}
    }
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

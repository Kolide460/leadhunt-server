const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

const app = express();
const PORT = process.env.PORT || 3000;
const PLACES_KEY = process.env.PLACES_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
const ACCESS_PASSWORD = process.env.ACCESS_PASSWORD;
const FREE_SEARCH_LIMIT = 10;

// TOKEN_SECRET — must be set in prod or all sessions reset on restart
const TOKEN_SECRET = process.env.TOKEN_SECRET || (() => {
  if (process.env.NODE_ENV === 'production') {
    console.warn('[WARN] TOKEN_SECRET not set — sessions will reset on every restart. Add it to Render env vars.');
  }
  return crypto.randomBytes(32).toString('hex');
})();

// ── SECURITY ─────────────────────────────────────────────────────────────────
let helmet;
try { helmet = require('helmet'); } catch(e) { helmet = null; }
if (helmet) app.use(helmet());

const ALLOWED_ORIGINS = [
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
  allowedHeaders: ['Content-Type', 'X-Auth-Token'],
}));

app.use(express.json({ limit: '2mb' }));

// Rate limiting
let rateLimit;
try { rateLimit = require('express-rate-limit'); } catch(e) { rateLimit = null; }

const makeLimit = (windowMs, max) => rateLimit
  ? rateLimit({ windowMs, max, standardHeaders: true, legacyHeaders: false })
  : (_req, _res, next) => next();

const generalLimiter = makeLimit(15 * 60 * 1000, 200); // 200 req / 15 min
const searchLimiter  = makeLimit(60 * 1000, 20);        // 20 req / min
const authLimiter    = makeLimit(60 * 1000, 10);        // 10 login attempts / min

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

// ── IN-MEMORY USAGE TRACKING ──────────────────────────────────────────────────
const usageMap = new Map(); // sessionId → { searches: number }

function getUsage(sessionId) {
  if (!usageMap.has(sessionId)) usageMap.set(sessionId, { searches: 0 });
  return usageMap.get(sessionId);
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
  if (!ACCESS_PASSWORD) return next(); // auth disabled if no password set
  const token = req.headers['x-auth-token'];
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'Not authenticated. Please log in.' });
  req.session = payload;
  next();
}

function checkUsageLimit(req, res, next) {
  if (!req.session) return next();
  const { sessionId, tier } = req.session;
  if (tier === 'pro') return next();
  const usage = getUsage(sessionId);
  if (usage.searches >= FREE_SEARCH_LIMIT) {
    return res.status(402).json({
      error: 'Free search limit reached',
      upgrade: true,
      used: usage.searches,
      limit: FREE_SEARCH_LIMIT,
    });
  }
  next();
}

// ── POST /auth ────────────────────────────────────────────────────────────────
app.post('/auth', authLimiter, (req, res) => {
  if (!ACCESS_PASSWORD) {
    // Dev mode — no password required
    const token = signToken({ sessionId: crypto.randomUUID(), tier: 'free', createdAt: Date.now() });
    return res.json({ token, tier: 'free', used: 0, limit: FREE_SEARCH_LIMIT, remaining: FREE_SEARCH_LIMIT });
  }
  const { password } = req.body || {};
  if (!password || password !== ACCESS_PASSWORD) {
    return res.status(401).json({ error: 'Incorrect password' });
  }
  const sessionId = crypto.randomUUID();
  const token = signToken({ sessionId, tier: 'free', createdAt: Date.now() });
  res.json({ token, tier: 'free', used: 0, limit: FREE_SEARCH_LIMIT, remaining: FREE_SEARCH_LIMIT });
});

// ── GET /usage ────────────────────────────────────────────────────────────────
app.get('/usage', requireAuth, (req, res) => {
  if (!req.session) {
    return res.json({ tier: 'free', used: 0, limit: FREE_SEARCH_LIMIT, remaining: FREE_SEARCH_LIMIT });
  }
  const { sessionId, tier } = req.session;
  if (tier === 'pro') return res.json({ tier: 'pro', used: 0, limit: null, remaining: null });
  const usage = getUsage(sessionId);
  res.json({
    tier: 'free',
    used: usage.searches,
    limit: FREE_SEARCH_LIMIT,
    remaining: FREE_SEARCH_LIMIT - usage.searches,
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
    starter: process.env.STRIPE_PRICE_STARTER,
    pro:     process.env.STRIPE_PRICE_PRO,
    agency:  process.env.STRIPE_PRICE_AGENCY,
  };
  const { tier = 'starter' } = req.body || {};
  const priceId = PRICE_MAP[tier];
  if (!priceId) {
    return res.status(503).json({ error: `Add STRIPE_PRICE_${tier.toUpperCase()} to Render env vars.` });
  }
  try {
    const FRONTEND = process.env.FRONTEND_URL || 'https://astounding-bubblegum-cff1c5.netlify.app';
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${FRONTEND}?payment=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${FRONTEND}?payment=cancelled`,
      metadata: { sessionId: req.session?.sessionId },
    });
    res.json({ checkoutUrl: session.url });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/payment-success', requireAuth, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Payments not configured' });
  const { session_id } = req.query;
  try {
    const session = await stripe.checkout.sessions.retrieve(session_id);
    if (session.payment_status !== 'paid') {
      return res.status(402).json({ error: 'Payment not confirmed' });
    }
    const sessionId = req.session?.sessionId || crypto.randomUUID();
    const token = signToken({
      sessionId,
      tier: 'pro',
      createdAt: Date.now(),
      expiresAt: Date.now() + 31 * 24 * 60 * 60 * 1000,
    });
    res.json({ token, tier: 'pro' });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /search ───────────────────────────────────────────────────────────────
app.get('/search', requireAuth, checkUsageLimit, searchLimiter, async (req, res) => {
  try {
    const { query } = req.query;
    const cacheKey = (query || '').toLowerCase().trim();
    const cached = getCached(cacheKey);
    if (cached) return res.json(cached);

    const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}&key=${PLACES_KEY}`;
    const response = await fetch(url);
    const data = await response.json();

    // Increment usage only on live (non-cached) responses
    if (req.session) {
      const usage = getUsage(req.session.sessionId);
      usage.searches++;
    }

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
    auth_enabled: !!ACCESS_PASSWORD,
    stripe_enabled: !!stripe,
    cached_queries: searchCache.size,
  });
});

// ── POST /generate ────────────────────────────────────────────────────────────
app.post('/generate', requireAuth, async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'ANTHROPIC_KEY not set' });

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

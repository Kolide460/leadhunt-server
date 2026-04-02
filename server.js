const express = require('express');
const cors = require('cors');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

const app = express();
const PORT = process.env.PORT || 3000;
const PLACES_KEY = process.env.PLACES_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;

app.use(cors());
app.use(express.json());

// Text Search
app.get('/search', async (req, res) => {
  try {
    const { query } = req.query;
    const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}&key=${PLACES_KEY}`;
    const response = await fetch(url);
    const data = await response.json();
    res.json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Rich Place Details
app.get('/details', async (req, res) => {
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

// Scrape business website for social media, email, description
app.get('/scrape', async (req, res) => {
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
      logo: extractLogo(html, url),
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

function extractLogo(html, baseUrl) {
  const m = html.match(/<link[^>]+rel=["'](?:shortcut )?icon["'][^>]+href=["']([^"']+)["']/i);
  if (!m) return null;
  const href = m[1];
  if (href.startsWith('http')) return href;
  try { return new URL(href, baseUrl).href; } catch { return null; }
}

// Debug
app.get('/debug', (req, res) => {
  res.json({
    has_anthropic_key: !!ANTHROPIC_KEY,
    key_preview: ANTHROPIC_KEY ? ANTHROPIC_KEY.substring(0, 10) + '...' : 'NOT SET',
    has_places_key: !!PLACES_KEY
  });
});

// Generate website
app.post('/generate', async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'ANTHROPIC_KEY not set' });
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 8000,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    const data = await response.json();
    res.json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

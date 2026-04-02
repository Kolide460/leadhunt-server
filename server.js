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

// Get a Google Places photo URL
app.get('/photo', async (req, res) => {
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

// Scrape existing website for logo, social media, email
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

// Generate SVG logo using Claude
app.post('/generate-logo', async (req, res) => {
  try {
    const { name, biztype, colors } = req.body;
    if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'ANTHROPIC_KEY not set' });

    const prompt = `Design a professional SVG logo for a ${biztype} business called "${name}".

Requirements:
- Output ONLY a valid SVG element, nothing else — no explanation, no markdown, no backticks
- The SVG should be viewBox="0 0 300 100" (wide format, like a header logo)
- Include a small relevant icon/symbol on the left
- Business name text on the right of the icon
- Use colors appropriate for a ${biztype} business: ${colors || 'professional and trustworthy'}
- Clean, modern, professional design
- Output the raw SVG starting with <svg and ending with </svg>`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    const data = await response.json();
    let svg = data.content?.map(b => b.text || '').join('') || '';
    svg = svg.replace(/```svg/g, '').replace(/```xml/g, '').replace(/```/g, '').trim();
    res.json({ svg });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Generate a single branding image via DALL-E 3
// Requires OPENAI_KEY environment variable on Render
app.post('/generate-image', async (req, res) => {
  try {
    const { prompt, size = '1024x1024' } = req.body;
    const OPENAI_KEY = process.env.OPENAI_KEY;
    if (!OPENAI_KEY) return res.status(500).json({ error: 'OPENAI_KEY not set on server. Add it in Render environment variables.' });

    const response = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_KEY}`
      },
      body: JSON.stringify({
        model: 'dall-e-3',
        prompt,
        n: 1,
        size,
        quality: 'standard',
        response_format: 'b64_json'
      })
    });

    const data = await response.json();
    if (data.error) return res.status(500).json({ error: data.error.message });

    const b64 = data.data[0].b64_json;
    res.json({ dataUri: `data:image/png;base64,${b64}` });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Debug
app.get('/debug', (req, res) => {
  res.json({
    has_anthropic_key: !!ANTHROPIC_KEY,
    key_preview: ANTHROPIC_KEY ? ANTHROPIC_KEY.substring(0, 10) + '...' : 'NOT SET',
    has_places_key: !!PLACES_KEY
  });
});

// Generate website / branding kit
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
        model: 'claude-sonnet-4-6',
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

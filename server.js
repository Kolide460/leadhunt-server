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

// Generate logo using Ideogram API
app.post('/generate-logo', async (req, res) => {
  try {
    const { name, biztype } = req.body;
    const IDEOGRAM_KEY = process.env.IDEOGRAM_KEY;
    if (!IDEOGRAM_KEY) return res.status(500).json({ error: 'IDEOGRAM_KEY not set' });

    const prompt = `Professional business logo for "${name}", a ${biztype} business. Clean, modern, minimal design. White background. Suitable for use on a website header.`;

    const response = await fetch('https://api.ideogram.ai/generate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Api-Key': IDEOGRAM_KEY
      },
      body: JSON.stringify({
        image_request: {
          prompt,
          aspect_ratio: 'ASPECT_1_1',
          model: 'V_2',
          style_type: 'DESIGN',
          magic_prompt_option: 'ON'
        }
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

// Generate a single branding image via Ideogram
app.post('/generate-image', async (req, res) => {
  try {
    const { prompt, size = '1024x1024' } = req.body;
    const IDEOGRAM_KEY = process.env.IDEOGRAM_KEY;
    if (!IDEOGRAM_KEY) return res.status(500).json({ error: 'Ideogram API key not configured on server' });

    // Map pixel dimensions to Ideogram aspect ratio tokens
    const aspectMap = {
      '1024x1024': 'ASPECT_1_1',
      '1792x1024': 'ASPECT_16_9',
      '1024x1792': 'ASPECT_9_16',
    };
    const aspect_ratio = aspectMap[size] || 'ASPECT_1_1';

    const response = await fetch('https://api.ideogram.ai/generate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Api-Key': IDEOGRAM_KEY
      },
      body: JSON.stringify({
        image_request: {
          prompt,
          aspect_ratio,
          model: 'V_2',
          style_type: 'DESIGN',
          magic_prompt_option: 'ON'
        }
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

// Debug
app.get('/debug', (req, res) => {
  res.json({
    has_anthropic_key: !!ANTHROPIC_KEY,
    key_preview: ANTHROPIC_KEY ? ANTHROPIC_KEY.substring(0, 10) + '...' : 'NOT SET',
    has_places_key: !!PLACES_KEY
  });
});

// Generate website / branding kit — streams response as SSE to prevent timeout
app.post('/generate', async (req, res) => {
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

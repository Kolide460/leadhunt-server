const express = require('express');
const cors = require('cors');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

const app = express();
const PORT = process.env.PORT || 3000;
const PLACES_KEY = process.env.PLACES_KEY;

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

// Place Details
app.get('/details', async (req, res) => {
  try {
    const { place_id } = req.query;
    const fields = 'name,formatted_address,website,rating,user_ratings_total,formatted_phone_number';
    const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${place_id}&fields=${fields}&key=${PLACES_KEY}`;
    const response = await fetch(url);
    const data = await response.json();
    res.json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// AI Image generation — proxies Pollinations.ai and returns base64 data URI
// Falls back gracefully: always returns the direct URL so the browser can load it
app.get('/generate-image', async (req, res) => {
  const { prompt, w = 400, h = 400, seed = 42 } = req.query;
  const pollinationsUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=${w}&height=${h}&nologo=true&model=flux&seed=${seed}`;

  try {
    const fetchPromise = fetch(pollinationsUrl);
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Pollinations timeout after 25s')), 25000)
    );

    const response = await Promise.race([fetchPromise, timeoutPromise]);

    if (!response.ok) throw new Error(`Pollinations HTTP ${response.status}`);

    const buffer = await response.arrayBuffer();
    const base64 = Buffer.from(buffer).toString('base64');
    const mime = response.headers.get('content-type') || 'image/jpeg';
    res.json({ dataUri: `data:${mime};base64,${base64}`, url: pollinationsUrl });
  } catch(e) {
    console.error('[generate-image] failed:', e.message, '| prompt:', prompt.substring(0, 60));
    // Return the direct URL as fallback — browser can load it even if server-side proxy failed
    res.json({ error: e.message, url: pollinationsUrl });
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

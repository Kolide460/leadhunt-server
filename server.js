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

// Debug endpoint - check if API key is loaded
app.get('/debug', (req, res) => {
  res.json({
    has_anthropic_key: !!ANTHROPIC_KEY,
    key_preview: ANTHROPIC_KEY ? ANTHROPIC_KEY.substring(0, 10) + '...' : 'NOT SET',
    has_places_key: !!PLACES_KEY
  });
});

// Generate website via Anthropic
app.post('/generate', async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!ANTHROPIC_KEY) {
      return res.status(500).json({ error: 'ANTHROPIC_KEY environment variable not set on server' });
    }
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

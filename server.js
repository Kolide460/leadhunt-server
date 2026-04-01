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

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

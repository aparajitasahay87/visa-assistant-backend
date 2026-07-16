const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const { Redis } = require('@upstash/redis');

const app = express();
app.use(cors());
app.use(express.json());

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const CACHE_TTL_SECONDS = 24 * 60 * 60; // 24 hours

async function getCached(key) {
  return await redis.get(key); // @upstash/redis auto-parses JSON
}

async function setCached(key, data) {
  await redis.set(key, data, { ex: CACHE_TTL_SECONDS });
}

app.post('/api/visa-map', async (req, res) => {
  const { passport } = req.body;
  if (!passport) return res.status(400).json({ error: 'passport is required' });

  const cacheKey = `map:${passport}`;
  const cached = await getCached(cacheKey);
  if (cached) return res.json({ ...cached, _cache: 'hit' });

  try {
    const response = await fetch('https://visa-requirement.p.rapidapi.com/v2/visa/map', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-rapidapi-host': 'visa-requirement.p.rapidapi.com',
        'x-rapidapi-key': process.env.RAPIDAPI_KEY
      },
      body: JSON.stringify({ passport })
    });
    const data = await response.json();
    await setCached(cacheKey, data);
    res.json({ ...data, _cache: 'miss' });
  } catch (err) {
    res.status(500).json({ error: 'Visa map lookup failed' });
  }
});

app.post('/api/visa-check', async (req, res) => {
  const { passport, destination } = req.body;
  if (!passport || !destination) {
    return res.status(400).json({ error: 'passport and destination are required' });
  }

  const cacheKey = `check:${passport}-${destination}`;
  const cached = await getCached(cacheKey);
  if (cached) return res.json({ ...cached, _cache: 'hit' });

  try {
    const response = await fetch('https://visa-requirement.p.rapidapi.com/v2/visa/check', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-rapidapi-host': 'visa-requirement.p.rapidapi.com',
        'x-rapidapi-key': process.env.RAPIDAPI_KEY
      },
      body: JSON.stringify({ passport, destination })
    });
    const data = await response.json();
    await setCached(cacheKey, data);
    res.json({ ...data, _cache: 'miss' });
  } catch (err) {
    res.status(500).json({ error: 'Visa lookup failed' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Running on port ${PORT}`));
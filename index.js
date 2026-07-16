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

// Shared helper: checks cache first, calls RapidAPI on a miss, and — importantly —
// only caches genuinely successful responses. Quota-exceeded / error messages from
// RapidAPI must never be cached, or they'd keep being served for 24 hours even after
// the quota resets or the underlying issue is fixed.
async function fetchVisaData(url, body, cacheKey) {
  const cached = await getCached(cacheKey);
  if (cached) {
    return { data: cached, cacheStatus: 'hit', ok: true };
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-rapidapi-host': 'visa-requirement.p.rapidapi.com',
      'x-rapidapi-key': process.env.RAPIDAPI_KEY
    },
    body: JSON.stringify(body)
  });

  const data = await response.json();

  // RapidAPI returns HTTP 200 even for some error cases (like quota messages),
  // so checking response.ok alone isn't enough — also check for an error-shaped
  // body (a top-level "message" field, no "data" field) before deciding to cache.
  const looksLikeError = !response.ok || (data && data.message && !data.data);

  if (!looksLikeError) {
    await setCached(cacheKey, data);
  }

  return { data, cacheStatus: 'miss', ok: !looksLikeError };
}

// Bulk endpoint for the map/grid view — ONE call covers all 210 destinations for a
// given passport, instead of one call per country.
app.post('/api/visa-map', async (req, res) => {
  const { passport } = req.body;
  if (!passport) return res.status(400).json({ error: 'passport is required' });

  const cacheKey = `map:${passport}`;
  try {
    const result = await fetchVisaData(
      'https://visa-requirement.p.rapidapi.com/v2/visa/map',
      { passport },
      cacheKey
    );

    if (!result.ok) {
      return res.status(503).json({
        error: 'Visa data temporarily unavailable, please try again later',
        details: result.data,
        _cache: result.cacheStatus
      });
    }

    res.json({ ...result.data, _cache: result.cacheStatus });
  } catch (err) {
    res.status(500).json({ error: 'Visa map lookup failed' });
  }
});

// Single-pair detail endpoint — used only when a user clicks one specific country
// to see the full detail card, not for the bulk map/grid view.
app.post('/api/visa-check', async (req, res) => {
  const { passport, destination } = req.body;
  if (!passport || !destination) {
    return res.status(400).json({ error: 'passport and destination are required' });
  }

  const cacheKey = `check:${passport}-${destination}`;
  try {
    const result = await fetchVisaData(
      'https://visa-requirement.p.rapidapi.com/v2/visa/check',
      { passport, destination },
      cacheKey
    );

    if (!result.ok) {
      return res.status(503).json({
        error: 'Visa data temporarily unavailable, please try again later',
        details: result.data,
        _cache: result.cacheStatus
      });
    }

    res.json({ ...result.data, _cache: result.cacheStatus });
  } catch (err) {
    res.status(500).json({ error: 'Visa lookup failed' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Running on port ${PORT}`));
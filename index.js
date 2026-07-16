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

// 30 days — visa rules change infrequently, and this aligns the cache lifetime with
// the monthly RapidAPI quota cycle, so a given passport/destination pair should only
// ever cost one real API call per ~month, not once every 24 hours.
const CACHE_TTL_SECONDS = 4 * 30 * 24 * 60 * 60;

// Soft warning threshold — RapidAPI free tier is 120 requests/month.
const QUOTA_WARNING_THRESHOLD = 100;

async function getCached(key) {
  return await redis.get(key);
}

async function setCached(key, data) {
  await redis.set(key, data, { ex: CACHE_TTL_SECONDS });
}

// Tracks real (non-cached) RapidAPI calls per calendar month, so we can warn before
// hitting the quota ceiling instead of finding out from a failed request.
async function incrementMonthlyCallCount() {
  const monthKey = new Date().toISOString().slice(0, 7); // e.g. "2026-07"
  const key = `api_calls:${monthKey}`;
  const count = await redis.incr(key);
  await redis.expire(key, 35 * 24 * 60 * 60);
  return count;
}

// Shared helper: checks cache first, calls RapidAPI on a miss, and — importantly —
// only caches genuinely successful responses.
async function fetchVisaData(url, body, cacheKey) {
  const cached = await getCached(cacheKey);
  if (cached) {
    return { data: cached, cacheStatus: 'hit', ok: true, monthlyCallCount: null };
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
  const looksLikeError = !response.ok || (data && data.message && !data.data);

  let monthlyCallCount = null;
  if (!looksLikeError) {
    await setCached(cacheKey, data);
    monthlyCallCount = await incrementMonthlyCallCount();
  }

  return { data, cacheStatus: 'miss', ok: !looksLikeError, monthlyCallCount };
}

function buildResponse(res, result, errorMessage) {
  if (!result.ok) {
    return res.status(503).json({
      error: errorMessage,
      details: result.data,
      _cache: result.cacheStatus
    });
  }

  const payload = { ...result.data, _cache: result.cacheStatus };
  if (result.monthlyCallCount !== null && result.monthlyCallCount >= QUOTA_WARNING_THRESHOLD) {
    payload._quotaWarning = `Approaching monthly RapidAPI quota: ${result.monthlyCallCount}/120 calls used this month.`;
  }
  res.json(payload);
}

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
    buildResponse(res, result, 'Visa map data temporarily unavailable, please try again later');
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
  try {
    const result = await fetchVisaData(
      'https://visa-requirement.p.rapidapi.com/v2/visa/check',
      { passport, destination },
      cacheKey
    );
    buildResponse(res, result, 'Visa data temporarily unavailable, please try again later');
  } catch (err) {
    res.status(500).json({ error: 'Visa lookup failed' });
  }
});

// Check current monthly usage without making a real visa call.
app.get('/api/quota-status', async (req, res) => {
  const monthKey = new Date().toISOString().slice(0, 7);
  const count = (await redis.get(`api_calls:${monthKey}`)) || 0;
  res.json({ month: monthKey, realApiCallsThisMonth: count, quotaLimit: 120 });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Running on port ${PORT}`));
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

// Static ISO code -> country name lookup. The /v2/visa/map endpoint only returns
// color-grouped ISO codes (e.g. "red": "AD,AF,AR,..."), with no country names — so
// this reference data is maintained locally (never changes, no API needed) and used
// to enrich the map response into a display-ready per-country list before sending it
// to the frontend. Extend this list as needed; this is intentionally a small,
// hand-maintained subset covering the countries currently relevant (the 9 demo
// corridors plus a few common ones), not the full 210 — extend as new corridors are
// added.
const COUNTRY_NAMES = {
  JP: 'Japan', SE: 'Sweden', RU: 'Russian Federation', CZ: 'Czech Republic',
  CH: 'Switzerland', ID: 'Indonesia', ES: 'Spain', AR: 'Argentina',
  NL: 'Netherlands', US: 'United States', GB: 'United Kingdom', CA: 'Canada',
  AU: 'Australia', DE: 'Germany', FR: 'France', IT: 'Italy', SG: 'Singapore',
  TH: 'Thailand', AE: 'United Arab Emirates', CN: 'China', IN: 'India'
};

// Converts the raw { colors: { red: "AD,AF,...", ... } } shape from /v2/visa/map into
// a flat, display-ready array of { code, name, color } objects — easier for the
// frontend to render directly without re-parsing comma-separated strings itself.
function enrichMapResponse(rawData) {
  const colors = rawData?.data?.colors || {};
  const enriched = [];

  for (const [color, codeList] of Object.entries(colors)) {
    if (!codeList) continue;
    const codes = codeList.split(',');
    for (const code of codes) {
      enriched.push({
        code,
        name: COUNTRY_NAMES[code] || code, // falls back to the raw code if not in our list yet
        color
      });
    }
  }

  return {
    passport: rawData?.data?.passport,
    countries: enriched,
    meta: rawData?.meta
  };
}

// 4 months (~120 days) — visa rules change infrequently (the historic-data test earlier
// showed only a handful of changes over 2+ years for one country pair), so a longer TTL
// meaningfully cuts real API calls without much staleness risk. Reviewed periodically per
// maintenance.md, not left forever.
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
  // Auto-expire the counter after ~35 days so old months don't linger forever
  await redis.expire(key, 35 * 24 * 60 * 60);
  return count;
}

// Shared helper: checks cache first, calls RapidAPI on a miss, and — importantly —
// only caches genuinely successful responses. Quota-exceeded / error messages from
// RapidAPI must never be cached, or they'd keep being served long after the
// underlying issue is fixed or the quota resets.
// DEMO_MODE: when true, the backend NEVER calls the real RapidAPI, regardless of
// cache state. Only pre-seeded cache entries are served; anything else returns a
// clear "not available in demo" response. This fully protects the RapidAPI quota
// during demos/testing, at the cost of only supporting the seeded countries.
// Toggle via the DEMO_MODE environment variable ("true"/"false"); defaults to true
// as a safety net so quota can't be silently exhausted again by a frontend bug.
const DEMO_MODE = process.env.DEMO_MODE !== 'false';

async function fetchVisaData(url, body, cacheKey) {
  const cached = await getCached(cacheKey);
  if (cached) {
    return { data: cached, cacheStatus: 'hit', ok: true, monthlyCallCount: null };
  }

  if (DEMO_MODE) {
    return {
      data: { error: 'not_in_demo_cache' },
      cacheStatus: 'miss',
      ok: false,
      monthlyCallCount: null,
      demoModeBlocked: true
    };
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

  // RapidAPI can return HTTP 200 even for error cases (like quota messages), so
  // checking response.ok alone isn't enough — also check for an error-shaped body.
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
    if (result.demoModeBlocked) {
      return res.status(404).json({
        error: 'This passport/destination pair is not available in demo mode. Only pre-seeded countries are supported right now.',
        _cache: result.cacheStatus,
        demoMode: true
      });
    }
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

// Bulk endpoint for the map/grid view — ONE call covers all 210 destinations for a
// given passport, instead of one call per country. The frontend should call this
// ONCE per citizenship value (e.g. on input blur/submit), not on every render, and
// should NOT call /api/visa-check for every country afterward — only when a user
// clicks a specific country for its full detail card (duration, embassy link, etc.),
// since those richer fields are not included in this map response.
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
      return buildResponse(res, result, 'Visa map data temporarily unavailable, please try again later');
    }

    // Enrich raw color-bucketed response into a flat, display-ready list before
    // sending to the frontend, since the raw shape has no country names.
    const enriched = enrichMapResponse(result.data);
    const payload = { data: enriched, _cache: result.cacheStatus };
    if (result.monthlyCallCount !== null && result.monthlyCallCount >= QUOTA_WARNING_THRESHOLD) {
      payload._quotaWarning = `Approaching monthly RapidAPI quota: ${result.monthlyCallCount}/120 calls used this month.`;
    }
    res.json(payload);
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
    buildResponse(res, result, 'Visa data temporarily unavailable, please try again later');
  } catch (err) {
    res.status(500).json({ error: 'Visa lookup failed' });
  }
});

// Simple endpoint to check current monthly usage without making a real visa call —
// useful for a debug/status check from the frontend or just curl/PowerShell.
app.get('/api/quota-status', async (req, res) => {
  const monthKey = new Date().toISOString().slice(0, 7);
  const count = (await redis.get(`api_calls:${monthKey}`)) || 0;
  res.json({ month: monthKey, realApiCallsThisMonth: count, quotaLimit: 120 });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Running on port ${PORT}`));
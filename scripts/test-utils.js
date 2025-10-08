// scripts/test-utils.js (CommonJS)
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const BASE_URL = process.env.BASE_URL || 'http://localhost:5001';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

if (!ADMIN_TOKEN) {
  throw new Error('Missing ADMIN_TOKEN in .env or environment');
}

function headers() {
  return {
    'Content-Type': 'application/json',
    'x-admin-token': ADMIN_TOKEN,
  };
}

let _fetchReady = null;
async function ensureFetch() {
  if (typeof fetch !== 'undefined') return;
  if (!_fetchReady) {
    _fetchReady = import('node-fetch').then(mod => { global.fetch = mod.default; });
  }
  await _fetchReady;
}

async function api(path, opts = {}) {
  await ensureFetch();
  const url = new URL(path, BASE_URL);
  const res = await fetch(url, {
    method: opts.method || 'GET',
    headers: { ...headers(), ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    const msg = data.error || data.message || res.statusText;
    throw new Error(`${opts.method || 'GET'} ${url.pathname} → ${msg}`);
  }
  return data;
}

// simple colored log helpers
const log = (m) => console.log(`\x1b[36m•\x1b[0m ${m}`);
const ok  = (m) => console.log(`\x1b[32m✅ ${m}\x1b[0m`);
const bad = (m) => console.error(`\x1b[31m❌ ${m}\x1b[0m`);
const warn= (m) => console.warn(`\x1b[33m⚠️ ${m}\x1b[0m`);

// test result collection for JUnit
const _results = [];

async function step(name, fn) {
  log(name);
  const t0 = Date.now();
  try {
    const result = await fn();
    const dt = Date.now() - t0;
    ok(`${name} (${dt}ms)`);
    _results.push({ name, timeMs: dt, status: 'passed' });
    return result;
  } catch (e) {
    const dt = Date.now() - t0;
    _results.push({ name, timeMs: dt, status: 'failed', message: e && e.message ? String(e.message) : 'Error' });
    throw e;
  }
}

function timestampId(prefix = 'QA') {
  return `${prefix}_${Date.now()}`;
}

// Simple artifact bag to share across steps
const artifacts = {
  assignedCodes: [],
  notes: [],
};

function writeJUnit(suiteName, fileName = 'artifacts/junit.xml') {
  const safe = (s) => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
  const total = _results.length;
  const failures = _results.filter(r => r.status === 'failed').length;
  const timeSec = (_results.reduce((a, r) => a + r.timeMs, 0) / 1000).toFixed(3);

  const cases = _results.map(r => {
    const name = safe(r.name);
    const t = (r.timeMs / 1000).toFixed(3);
    if (r.status === 'failed') {
      const msg = safe(r.message || 'Failure');
      return `<testcase classname="${safe(suiteName)}" name="${name}" time="${t}">
  <failure message="${msg}">${msg}</failure>
</testcase>`;
    }
    return `<testcase classname="${safe(suiteName)}" name="${name}" time="${t}" />`;
  }).join('\n');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="${safe(suiteName)}" tests="${total}" failures="${failures}" errors="0" time="${timeSec}">
${cases}
</testsuite>
`;
  fs.mkdirSync(path.dirname(fileName), { recursive: true });
  fs.writeFileSync(fileName, xml);
  return { total, failures, timeSec };
}

module.exports = {
  BASE_URL,
  ADMIN_TOKEN,
  headers,
  api,
  log,
  ok,
  bad,
  warn,
  step,
  timestampId,
  artifacts,
  writeJUnit,
};

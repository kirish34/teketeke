// scripts/parse-k6-summary.js
// Usage: node scripts/parse-k6-summary.js artifacts/k6-smoke.json
// Emits a concise markdown summary to stdout and (if available) $GITHUB_STEP_SUMMARY

const fs = require('fs');
const path = require('path');

function pct(n) {
  if (n == null || isNaN(n)) return '—';
  return (Number(n) * 100).toFixed(2) + '%';
}
function ms(n) {
  if (n == null || isNaN(n)) return '—';
  return Number(n).toFixed(2) + ' ms';
}
function bytes(n) {
  if (n == null || isNaN(n)) return '—';
  const x = Number(n);
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0, v = x;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(2)} ${units[i]}`;
}

function readJSON(p) {
  const txt = fs.readFileSync(p, 'utf8');
  try { return JSON.parse(txt); } catch (e) {
    throw new Error(`Invalid JSON at ${p}: ${e.message}`);
  }
}

function getMetric(m, name) { return m && m[name] ? m[name] : {}; }

function getTrend(metric) {
  const v = metric.values || {};
  return { p95: v['p(95)'], p99: v['p(99)'], min: v.min, max: v.max, med: v.med, avg: v.avg };
}

function getRate(metric) {
  const v = metric.values || {};
  if (typeof v.rate === 'number') return v.rate;
  if (typeof v.fails === 'number' && typeof v.count === 'number' && v.count > 0) {
    return v.fails / v.count;
  }
  return null;
}

function getCounter(metric) {
  const v = metric.values || {};
  return v.count ?? v.value ?? null;
}

function getGauge(metric) {
  const v = metric.values || {};
  return v.max ?? v.value ?? null;
}

(function main() {
  const file = process.argv[2] || '';
  if (!file) {
    console.error('Usage: node scripts/parse-k6-summary.js <path-to-k6-summary.json>');
    process.exit(2);
  }
  if (!fs.existsSync(file)) {
    console.error(`Summary file not found: ${file}`);
    process.exit(2);
  }

  const json = readJSON(file);
  const metrics = json.metrics || {};

  const httpDur = getTrend(getMetric(metrics, 'http_req_duration'));
  const failedRate = getRate(getMetric(metrics, 'http_req_failed'));
  const dataRecv = getCounter(getMetric(metrics, 'data_received'));
  const dataSent = getCounter(getMetric(metrics, 'data_sent'));
  const iters = getCounter(getMetric(metrics, 'iterations'));
  const vusMax = getGauge(getMetric(metrics, 'vus_max'));

  const mode = process.env.MODE || (file.includes('spike') ? 'spike' : file.includes('smoke') ? 'smoke' : 'load');

  const md = [
    `### k6 results (${mode})`,
    '',
    `**File:** \`${path.basename(file)}\``,
    '',
    '| Metric | Value |',
    '|---|---:|',
    `| p95 latency | ${ms(httpDur.p95)} |`,
    `| p99 latency | ${ms(httpDur.p99)} |`,
    `| Error rate | ${pct(failedRate)} |`,
    `| Iterations | ${iters ?? '—'} |`,
    `| Max VUs | ${vusMax ?? '—'} |`,
    `| Data received | ${bytes(dataRecv)} |`,
    `| Data sent | ${bytes(dataSent)} |`,
    '',
  ].join('\n');

  console.log(md);

  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    fs.appendFileSync(summaryPath, md + '\n');
  }
})();


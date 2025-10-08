// node scripts/guard-k6.js artifacts/k6-smoke.json 800 0.02
const fs = require('fs');

const [,, file, p95Limit = '800', errLimit = '0.02'] = process.argv;
if (!file || !fs.existsSync(file)) {
  console.error('Usage: node scripts/guard-k6.js <summary.json> [p95_ms] [err_rate]');
  process.exit(2);
}

const json = JSON.parse(fs.readFileSync(file, 'utf8'));
const m = json.metrics || {};
const p95 = m.http_req_duration?.values?.['p(95)'] ?? null;
const err = m.http_req_failed?.values?.rate ?? 0;

const bad = (p95 != null && p95 > +p95Limit) || (err > +errLimit);
if (bad) {
  console.error(`❌ Perf gate failed: p95=${p95?.toFixed?.(2)}ms (limit ${p95Limit}ms), `+
                `err=${(err*100).toFixed(2)}% (limit ${(Number(errLimit)*100)}%)`);
  process.exit(1);
}
console.log(`✅ Perf gate ok: p95=${p95?.toFixed?.(2)}ms, err=${(err*100).toFixed(2)}%`);


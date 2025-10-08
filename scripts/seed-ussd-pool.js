/* scripts/seed-ussd-pool.js */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE in env');
  process.exit(1);
}

function sumDigits(str) { return (str || '').split('').reduce((a, c) => a + (Number(c) || 0), 0); }
function digitalRoot(n) { let s = sumDigits(String(n)); while (s > 9) s = sumDigits(String(s)); return String(s); }

async function main() {
  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, { auth: { persistSession: false } });

  const envName = String(process.env.SEED_ENV || '').toLowerCase();
  const defStart = envName === 'staging' ? '300' : '110';
  const defCount = envName === 'staging' ? '30'  : '30';
  const startRaw = parseInt(process.env.SEED_START || defStart, 10);
  const countRaw = parseInt(process.env.SEED_COUNT || defCount, 10);
  const safeStart = Number.isFinite(startRaw) ? startRaw : 110;
  const safeCount = Number.isFinite(countRaw) && countRaw > 0 ? countRaw : 30;
  const rows = [];
  for (let i = safeStart; i < safeStart + safeCount; i++) {
    const base = String(i).padStart(3, '0');
    rows.push({ base, checksum: digitalRoot(base), allocated: false });
  }

  const { error } = await sb.from('ussd_pool').upsert(rows, { onConflict: 'base' });
  if (error) {
    console.error('Seed failed:', error.message || error);
    process.exit(1);
  }
  console.log(`Seeded/ensured ${rows.length} USSD bases (${safeStart}..${safeStart + safeCount - 1}) [SEED_ENV=${envName || 'default'}]`);
}

main().catch((e) => { console.error(e); process.exit(1); });

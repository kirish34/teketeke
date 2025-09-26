// server.js (CommonJS, dashboards-ready)
// npm i express cors morgan @supabase/supabase-js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const { createClient } = require('@supabase/supabase-js');

const {
  PORT = 5001,
  NODE_ENV = 'development',
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  SUPABASE_SERVICE_ROLE,
  ADMIN_TOKEN = 'changeme_admin_token',
  DEV_AUTOPAY = 'true', // set to 'false' in production
} = process.env;

const DEV_AUTOPAY_ON = DEV_AUTOPAY === 'true' || NODE_ENV !== 'production';

// ---- Supabase clients ----
const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });
const sbAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, { auth: { persistSession: false } });

// ---- App setup ----
const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(morgan(NODE_ENV === 'production' ? 'combined' : 'dev'));

// serve dashboards (put your html files in ./public)
app.use(express.static('public'));

// ---- Helpers ----
const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;
const startOfDayISO = (d = new Date()) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).toISOString();
const endOfDayISO = (d = new Date()) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).toISOString();

function parseRange(query) {
  // ?date=YYYY-MM-DD OR ?from=YYYY-MM-DD&to=YYYY-MM-DD (inclusive days)
  if (query.from || query.to) {
    const from = query.from ? new Date(query.from) : new Date();
    const to = query.to ? new Date(query.to) : new Date();
    return { from: startOfDayISO(from), to: endOfDayISO(to) };
  }
  if (query.date) {
    const d = new Date(query.date);
    return { from: startOfDayISO(d), to: endOfDayISO(d) };
  }
  return { from: startOfDayISO(), to: endOfDayISO() }; // today
}

async function getRuleset(sacco_id) {
  const { data, error } = await sb.from('sacco_settings').select('*').eq('sacco_id', sacco_id).maybeSingle();
  if (error) throw error;
  return data || { sacco_id, fare_fee_flat_kes: 2.5, savings_percent: 5, sacco_daily_fee_kes: 50, loan_repay_percent: 0 };
}

async function hasPaidSaccoFeeToday(matatu_id) {
  const today = startOfDayISO();
  const { data, error } = await sb
    .from('ledger_entries')
    .select('id, created_at')
    .eq('matatu_id', matatu_id)
    .eq('type', 'SACCO_FEE')
    .gte('created_at', today);
  if (error) throw error;
  return (data || []).length > 0;
}

function computeSplits({ amount, rules, takeDailyFee }) {
  const fare = round2(amount);
  const serviceFee = round2(rules.fare_fee_flat_kes ?? 2.5); // charged to passenger (Sky Yalla)
  const savings = round2((rules.savings_percent / 100) * fare);
  const loanRepay = round2((rules.loan_repay_percent / 100) * fare);
  const saccoDaily = takeDailyFee ? round2(rules.sacco_daily_fee_kes) : 0;

  const parts = [
    { type: 'FARE', amount_kes: fare },
    { type: 'SERVICE_FEE', amount_kes: serviceFee }
  ];
  if (saccoDaily > 0) parts.push({ type: 'SACCO_FEE', amount_kes: saccoDaily });
  if (savings > 0) parts.push({ type: 'SAVINGS', amount_kes: savings });
  if (loanRepay > 0) parts.push({ type: 'LOAN_REPAY', amount_kes: loanRepay });
  return parts;
}

// ---- Health ----
app.get('/health', (req, res) => res.json({ ok: true, env: NODE_ENV, time: new Date().toISOString() }));

// ---- Minimal session stubs (replace with Supabase Auth when ready) ----
app.get('/api/auth/session', (req, res) => res.json({ loggedIn: true, role: 'SACCO_ADMIN', cashierId: 'CASHIER-001' }));
app.post('/api/auth/logout', (req, res) => res.json({ ok: true }));

// ---- Admin guard (optional) ----
function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (!token || token !== ADMIN_TOKEN) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

/* =======================================================================
   ADMIN: SACCOS / MATATUS / CASHIERS / RULESETS  (Create/Update/Delete)
   =======================================================================*/
app.post('/api/admin/register-sacco', requireAdmin, async (req, res) => {
  try {
    const { name, contact_name, contact_phone, contact_email, default_till } = req.body || {};
    if (!name) return res.status(400).json({ success: false, error: 'name required' });
    const { data, error } = await sbAdmin
      .from('saccos')
      .insert([{ name, contact_name, contact_phone, contact_email, default_till }])
      .select()
      .single();
    if (error) throw error;
    await sbAdmin.from('sacco_settings').upsert({ sacco_id: data.id }).eq('sacco_id', data.id);
    res.json({ success: true, id: data.id });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/admin/update-sacco', requireAdmin, async (req, res) => {
  try {
    const { id, ...fields } = req.body || {};
    if (!id) return res.status(400).json({ success: false, error: 'id required' });
    const { error } = await sbAdmin.from('saccos').update(fields).eq('id', id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.delete('/api/admin/delete-sacco/:id', requireAdmin, async (req, res) => {
  try {
    const { error } = await sbAdmin.from('saccos').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/admin/register-matatu', requireAdmin, async (req, res) => {
  try {
    const { sacco_id, number_plate, owner_name, owner_phone, vehicle_type, tlb_number, till_number } = req.body || {};
    if (!sacco_id || !number_plate) return res.status(400).json({ success: false, error: 'sacco_id & number_plate required' });
    const { data, error } = await sbAdmin
      .from('matatus')
      .insert([{ sacco_id, number_plate, owner_name, owner_phone, vehicle_type, tlb_number, till_number }])
      .select()
      .single();
    if (error) throw error;
    res.json({ success: true, id: data.id });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/admin/update-matatu', requireAdmin, async (req, res) => {
  try {
    const { id, ...fields } = req.body || {};
    if (!id) return res.status(400).json({ success: false, error: 'id required' });
    const { error } = await sbAdmin.from('matatus').update(fields).eq('id', id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.delete('/api/admin/delete-matatu/:id', requireAdmin, async (req, res) => {
  try {
    const { error } = await sbAdmin.from('matatus').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/admin/cashier', requireAdmin, async (req, res) => {
  try {
    const { sacco_id, branch_id = null, matatu_id = null, name, phone = null, ussd_code } = req.body || {};
    if (!sacco_id || !name || !ussd_code) return res.status(400).json({ success: false, error: 'sacco_id, name, ussd_code required' });
    const { data, error } = await sbAdmin.from('cashiers').insert([{ sacco_id, branch_id, matatu_id, name, phone, ussd_code }]).select().single();
    if (error) throw error;
    res.json({ success: true, cashier: data });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/admin/rulesets/:saccoId', requireAdmin, async (req, res) => {
  try { res.json({ success: true, rules: await getRuleset(req.params.saccoId) }); }
  catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/admin/rulesets', requireAdmin, async (req, res) => {
  try {
    const { sacco_id, fare_fee_flat_kes = 2.5, savings_percent = 5, sacco_daily_fee_kes = 50, loan_repay_percent = 0 } = req.body || {};
    if (!sacco_id) return res.status(400).json({ success: false, error: 'sacco_id required' });
    const payload = {
      sacco_id,
      fare_fee_flat_kes: round2(fare_fee_flat_kes),
      savings_percent: Number(savings_percent),
      sacco_daily_fee_kes: round2(sacco_daily_fee_kes),
      loan_repay_percent: Number(loan_repay_percent),
      updated_at: new Date().toISOString()
    };
    const { error } = await sbAdmin.from('sacco_settings').upsert(payload).eq('sacco_id', sacco_id);
    if (error) throw error;
    res.json({ success: true, rules: payload });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

/* =======================================================================
   ADMIN: Lists for UI (GET only)
   =======================================================================*/
app.get('/api/admin/saccos', requireAdmin, async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    let query = sb.from('saccos').select('id,name,contact_name,contact_phone,contact_email,created_at').order('created_at', { ascending: false });
    if (q) query = query.ilike('name', `%${q}%`);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ items: data || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/matatus', requireAdmin, async (req, res) => {
  try {
    const { sacco_id } = req.query;
    let query = sb.from('matatus')
      .select('id, sacco_id, number_plate, owner_name, owner_phone, vehicle_type, tlb_number, till_number, created_at')
      .order('created_at', { ascending: false });
    if (sacco_id) query = query.eq('sacco_id', sacco_id);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ items: data || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/transactions', requireAdmin, async (req, res) => {
  try {
    const { sacco_id, status, limit = 50 } = req.query;
    let query = sb.from('transactions')
      .select('id,sacco_id,matatu_id,cashier_id,passenger_msisdn,fare_amount_kes,service_fee_kes,status,mpesa_receipt,created_at')
      .order('created_at', { ascending: false }).limit(Number(limit));
    if (sacco_id) query = query.eq('sacco_id', sacco_id);
    if (status)   query = query.eq('status', status);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ items: data || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* =======================================================================
   POS LISTENER (amount prefill) — Conductor/Counter devices
   =======================================================================*/
app.post('/api/pos/latest', async (req, res) => {
  try {
    const { cashier_id, amount } = req.body || {};
    if (!cashier_id || !amount) return res.status(400).json({ success: false, error: 'cashier_id & amount required' });
    const { error } = await sbAdmin.from('pos_latest').upsert({
      cashier_id, amount_kes: round2(amount), updated_at: new Date().toISOString()
    });
    if (error) throw error;
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/pos/latest/:cashierId', async (req, res) => {
  try {
    const { data, error } = await sb.from('pos_latest').select('amount_kes, updated_at').eq('cashier_id', req.params.cashierId).maybeSingle();
    if (error) throw error;
    res.json(data || {});
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

/* =======================================================================
   PRICING PREVIEW (fee quote)
   =======================================================================*/
app.post('/api/fees/quote', async (req, res) => {
  try {
    const { sacco_id, matatu_id, amount } = req.body || {};
    if (!sacco_id || !amount) return res.status(400).json({ success: false, error: 'sacco_id & amount required' });
    const rules = await getRuleset(sacco_id);
    const dailyDone = matatu_id ? await hasPaidSaccoFeeToday(matatu_id) : false;
    const splits = computeSplits({ amount, rules, takeDailyFee: !dailyDone });
    res.json({ success: true, splits });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

/* =======================================================================
   CASHIER FLOW (initiate, callback, status)
   =======================================================================*/
app.post('/api/cashier/initiate', async (req, res) => {
  try {
    const { amount, msisdn, sacco_id, matatu_id, cashier_id, ussd_code } = req.body || {};
    if (!amount || !msisdn || !sacco_id) return res.status(400).json({ success: false, error: 'amount, msisdn, sacco_id required' });

    const checkout_id = 'CHK-' + Math.random().toString(36).slice(2);
    const tx = {
      sacco_id, matatu_id: matatu_id || null, cashier_id: cashier_id || null, ussd_code: ussd_code || null,
      passenger_msisdn: msisdn, fare_amount_kes: round2(amount), status: 'PENDING',
      mpesa_checkout_id: checkout_id, created_at: new Date().toISOString()
    };
    const { data, error } = await sbAdmin.from('transactions').insert([tx]).select().single();
    if (error) throw error;

    // Simulate async success after 5s (remove when real callback is wired)
    setTimeout(async () => {
      try {
        await handleMpesaCallback({
          checkout_id,
          success: true,
          amount,
          msisdn,
          sacco_id,
          matatu_id: matatu_id || null,
          cashier_id: cashier_id || null,
          ussd_code: ussd_code || null,
          receipt: 'R' + Math.random().toString(36).slice(2)
        });
      } catch (e) { console.error('[simulate callback] ', e.message); }
    }, 5000);

    res.json({ success: true, txId: data.id, checkout_id });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/cashier/callback/mpesa', async (req, res) => {
  try {
    await handleMpesaCallback(req.body || {});
    res.json({ success: true });
  } catch (err) {
    console.error('[mpesa callback] error:', err.message);
    res.status(200).json({ success: false, error: err.message }); // avoid endless retries
  }
});

async function handleMpesaCallback(payload) {
  const { checkout_id, success, amount, msisdn, sacco_id, matatu_id, cashier_id, ussd_code, receipt } = payload;
  if (!checkout_id || amount == null || !sacco_id) throw new Error('checkout_id, amount, sacco_id required');

  const baseTx = {
    sacco_id, matatu_id, cashier_id, ussd_code,
    passenger_msisdn: msisdn || null,
    fare_amount_kes: round2(amount),
    service_fee_kes: 2.5, // snapshot of current policy
    status: success ? 'SUCCESS' : 'FAILED',
    mpesa_checkout_id: checkout_id,
    mpesa_receipt: receipt || null,
    created_at: new Date().toISOString()
  };

  const { data: upserted, error: upErr } = await sbAdmin
    .from('transactions')
    .upsert(baseTx, { onConflict: 'mpesa_checkout_id' })
    .select()
    .single();
  if (upErr) throw upErr;
  if (!success) return;

  const rules = await getRuleset(sacco_id);
  const dailyDone = matatu_id ? await hasPaidSaccoFeeToday(matatu_id) : false;
  const splits = computeSplits({ amount, rules, takeDailyFee: !dailyDone });

  const entries = splits.map(s => ({
    transaction_id: upserted.id,
    sacco_id,
    matatu_id,
    type: s.type,
    amount_kes: s.amount_kes,
    created_at: new Date().toISOString()
  }));
  const { error: ledErr } = await sbAdmin.from('ledger_entries').insert(entries);
  if (ledErr) throw ledErr;
}

// >>> REPLACED: status with dev auto-settle <<<
app.get('/api/cashier/status/:id', async (req, res) => {
  try {
    const key = req.params.id;

    // try by primary id first, then by checkout id
    let { data: tx, error } = await sb
      .from('transactions')
      .select('id, status, created_at')
      .eq('id', key)
      .maybeSingle();

    if (!tx) {
      const r = await sb
        .from('transactions')
        .select('id, status, created_at')
        .eq('mpesa_checkout_id', key)
        .maybeSingle();
      tx = r.data; error = r.error;
    }
    if (error || !tx) return res.status(404).json({ final: true, status: 'FAILED', error: 'not found' });

    // DEV AUTO-PAY: if still pending and older than ~3s, mark SUCCESS
    if (DEV_AUTOPAY_ON && (tx.status === 'PENDING' || tx.status === 'Pending')) {
      const ageMs = Date.now() - new Date(tx.created_at).getTime();
      if (ageMs > 3000) {
        await sbAdmin.from('transactions').update({ status: 'SUCCESS' }).eq('id', tx.id);
        tx.status = 'SUCCESS';
      }
    }

    const status = tx.status || 'PENDING';
    const final = ['SUCCESS', 'FAILED', 'TIMEOUT', 'CANCELLED'].includes(status);
    res.json({ final, status, checkout_id: key });
  } catch (err) {
    res.status(200).json({ final: true, status: 'FAILED', error: err.message });
  }
});

/* =======================================================================
   MATATU STAFF VIEW: last payments by till (public read)
   =======================================================================*/
// >>> REPLACED: return [] when till not set (quiet logs)
app.get('/api/matatu/payments', async (req, res) => {
  try {
    const tillRaw = (req.query.till ?? '').toString().trim();
    const till = tillRaw.toLowerCase();

    // If page hasn't saved a till yet, just return an empty list (no 400 spam)
    if (!tillRaw || till === 'null' || till === 'undefined') {
      return res.json([]);
    }

    const { data: m, error: mErr } = await sb
      .from('matatus')
      .select('id')
      .eq('till_number', tillRaw)
      .maybeSingle();
    if (mErr) throw mErr;
    if (!m) return res.json([]); // unknown till

    const { data: txs, error: tErr } = await sb
      .from('transactions')
      .select('id, passenger_msisdn, fare_amount_kes, created_at')
      .eq('matatu_id', m.id)
      .eq('status', 'SUCCESS')
      .order('created_at', { ascending: false })
      .limit(20);
    if (tErr) throw tErr;

    const txIds = (txs || []).map(t => t.id);
    if (!txIds.length) return res.json([]);

    const { data: leds, error: lErr } = await sb
      .from('ledger_entries')
      .select('transaction_id, type, amount_kes')
      .in('transaction_id', txIds);
    if (lErr) throw lErr;

    const byTx = {};
    (leds || []).forEach(le => {
      if (!byTx[le.transaction_id]) byTx[le.transaction_id] = 0;
      if (['SACCO_FEE', 'SAVINGS', 'LOAN_REPAY'].includes(le.type)) {
        byTx[le.transaction_id] = round2(byTx[le.transaction_id] + Number(le.amount_kes));
      }
    });

    const out = (txs || []).map(t => ({
      name: 'Passenger',
      phone: t.passenger_msisdn || '',
      amount: Number(t.fare_amount_kes),
      timestamp: new Date(t.created_at).toISOString(),
      deducted: byTx[t.id] || 0
    }));

    res.json(out);
  } catch (err) {
    console.error('[payments-by-till]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* =======================================================================
   ADMIN REPORTS (fees / loans summaries + settlements)
   =======================================================================*/
app.get('/api/admin/transactions/fees', requireAdmin, async (req, res) => {
  try {
    const start = startOfDayISO(), end = endOfDayISO();
    const { data, error } = await sb
      .from('ledger_entries')
      .select('amount_kes, created_at, matatu_id, sacco_id')
      .eq('type', 'SACCO_FEE')
      .gte('created_at', start).lt('created_at', end)
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json((data || []).map(r => ({
      date: new Date(r.created_at).toLocaleDateString(),
      time: new Date(r.created_at).toLocaleTimeString(),
      sacco: r.sacco_id,
      matatu: r.matatu_id,
      amount: Number(r.amount_kes)
    })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/transactions/loans', requireAdmin, async (req, res) => {
  try {
    const start = startOfDayISO(), end = endOfDayISO();
    const { data, error } = await sb
      .from('ledger_entries')
      .select('amount_kes, created_at, matatu_id, sacco_id')
      .eq('type', 'LOAN_REPAY')
      .gte('created_at', start).lt('created_at', end)
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json((data || []).map(r => ({
      date: new Date(r.created_at).toLocaleDateString(),
      time: new Date(r.created_at).toLocaleTimeString(),
      sacco: r.sacco_id,
      matatu: r.matatu_id,
      amount: Number(r.amount_kes)
    })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/settlements', requireAdmin, async (req, res) => {
  try {
    const { sacco_id, date } = req.query;
    if (!sacco_id) return res.status(400).json({ success: false, error: 'sacco_id required' });

    const day = date ? new Date(date) : new Date();
    const start = startOfDayISO(day), end = endOfDayISO(day);

    const { data, error } = await sb
      .from('ledger_entries')
      .select('type, amount_kes, created_at')
      .eq('sacco_id', sacco_id)
      .gte('created_at', start).lt('created_at', end);
    if (error) throw error;

    const totals = (data || []).reduce((acc, r) => {
      acc[r.type] = round2((acc[r.type] || 0) + Number(r.amount_kes));
      return acc;
    }, {});
    const fare = totals.FARE || 0, savings = totals.SAVINGS || 0, loan = totals.LOAN_REPAY || 0, saccofee = totals.SACCO_FEE || 0;
    const net_owner = round2(fare - savings - loan - saccofee);

    res.json({ success: true, date: start.slice(0,10), totals: { ...totals, NET_TO_OWNER: net_owner } });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

/* =======================================================================
   PUBLIC / SACCO / OWNER UTILITIES — read endpoints for all dashboards
   =======================================================================*/
app.get('/api/public/saccos', async (req, res) => {
  try {
    const { data, error } = await sb.from('saccos').select('id,name').order('name');
    if (error) throw error;
    res.json({ items: data || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Lookup a matatu by plate or till (?plate=KDA123A or ?till=123456)
app.get('/api/lookup/matatu', async (req, res) => {
  try {
    const { plate, till } = req.query;
    let q = sb.from('matatus').select('id,sacco_id,number_plate,owner_name,owner_phone,vehicle_type,tlb_number,till_number').limit(1);
    if (plate) q = q.eq('number_plate', plate);
    else if (till) q = q.eq('till_number', till);
    else return res.status(400).json({ error: 'provide plate or till' });
    const { data, error } = await q.single();
    if (error) throw error;
    res.json(data);
  } catch (e) { res.status(404).json({ error: e.message }); }
});

// SACCO-scoped reads (no admin token; OK for demo dashboards)
app.get('/api/sacco/:saccoId/matatus', async (req, res) => {
  try {
    const { saccoId } = req.params;
    const { data, error } = await sb.from('matatus')
      .select('id,number_plate,owner_name,owner_phone,vehicle_type,tlb_number,till_number,created_at')
      .eq('sacco_id', saccoId)
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ items: data || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/sacco/:saccoId/cashiers', async (req, res) => {
  try {
    const { saccoId } = req.params;
    const { data, error } = await sb.from('cashiers')
      .select('id,name,phone,ussd_code,matatu_id,active,created_at')
      .eq('sacco_id', saccoId)
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ items: data || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/sacco/:saccoId/transactions', async (req, res) => {
  try {
    const { saccoId } = req.params;
    const { status, limit = 50 } = req.query;
    let q = sb.from('transactions')
      .select('id,matatu_id,cashier_id,passenger_msisdn,fare_amount_kes,service_fee_kes,status,mpesa_receipt,created_at')
      .eq('sacco_id', saccoId)
      .order('created_at', { ascending: false })
      .limit(Number(limit));
    if (status) q = q.eq('status', status);
    const { data, error } = await q;
    if (error) throw error;
    res.json({ items: data || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/sacco/:saccoId/summary', async (req, res) => {
  try {
    const { saccoId } = req.params;
    const { from, to } = parseRange(req.query);
    const { data, error } = await sb.from('ledger_entries')
      .select('type,amount_kes')
      .eq('sacco_id', saccoId)
      .gte('created_at', from).lt('created_at', to);
    if (error) throw error;
    const totals = (data || []).reduce((acc, r) => {
      acc[r.type] = round2((acc[r.type] || 0) + Number(r.amount_kes));
      return acc;
    }, {});
    const fare = totals.FARE || 0, savings = totals.SAVINGS || 0, loan = totals.LOAN_REPAY || 0, saccofee = totals.SACCO_FEE || 0;
    const net_owner = round2(fare - savings - loan - saccofee);
    res.json({ range: { from, to }, totals: { ...totals, NET_TO_OWNER: net_owner } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// MATATU owner reads
app.get('/api/matatu/:matatuId/transactions', async (req, res) => {
  try {
    const { matatuId } = req.params;
    const { limit = 50 } = req.query;
    const { data, error } = await sb.from('transactions')
      .select('id,passenger_msisdn,fare_amount_kes,status,mpesa_receipt,created_at')
      .eq('matatu_id', matatuId)
      .order('created_at', { ascending: false })
      .limit(Number(limit));
    if (error) throw error;
    res.json({ items: data || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/matatu/:matatuId/summary', async (req, res) => {
  try {
    const { matatuId } = req.params;
    const { from, to } = parseRange(req.query);
    const { data, error } = await sb.from('ledger_entries')
      .select('type,amount_kes')
      .eq('matatu_id', matatuId)
      .gte('created_at', from).lt('created_at', to);
    if (error) throw error;
    const totals = (data || []).reduce((acc, r) => {
      acc[r.type] = round2((acc[r.type] || 0) + Number(r.amount_kes));
      return acc;
    }, {});
    const fare = totals.FARE || 0, savings = totals.SAVINGS || 0, loan = totals.LOAN_REPAY || 0, saccofee = totals.SACCO_FEE || 0;
    const net_owner = round2(fare - savings - loan - saccofee);
    res.json({ range: { from, to }, totals: { ...totals, NET_TO_OWNER: net_owner } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Public alias for staff apps to reuse payments-by-till (simple redirect)
app.get('/api/public/tills/:till/payments', (req, res) => {
  res.redirect(307, `/api/matatu/payments?till=${encodeURIComponent(req.params.till)}`);
});

/* =======================================================================
   USSD SIMULATOR (dev)
   =======================================================================*/
app.post('/flashpay/confirm', async (req, res) => {
  try {
    const { ussdCode, phone, amount = 50, sacco_id, matatu_id, cashier_id } = req.body || {};
    if (!ussdCode || !phone || !sacco_id) return res.status(400).json({ success: false, message: 'ussdCode, phone, sacco_id required' });
    const r = await fetchLocal('/api/cashier/initiate', {
      amount, msisdn: phone, sacco_id, matatu_id, cashier_id, ussd_code: ussdCode
    });
    res.json({ success: true, message: 'STK push simulated', ...r });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// simple internal helper: call our own endpoint
async function fetchLocal(path, body) {
  const res = await fetch(`http://localhost:${PORT}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  return await res.json();
}

// ---- Start server ----
app.listen(PORT, () => {
  console.log(`[TekeTeke] Listening on :${PORT}`);
  console.log('[ENV] URL:', !!SUPABASE_URL, 'ANON:', !!SUPABASE_ANON_KEY, 'SRV:', !!SUPABASE_SERVICE_ROLE, 'DEV_AUTOPAY:', DEV_AUTOPAY_ON);
});

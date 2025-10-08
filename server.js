// server.js — TekeTeke backend (dashboards + auth + USSD pool + fees/reports)
require('dotenv').config();

// ---- Core imports ----
const path = require('path');
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

// ---- Env ----
const {
  PORT = 5001,
  NODE_ENV = 'development',
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  SUPABASE_SERVICE_ROLE,
  SUPABASE_JWT_SECRET,
  ADMIN_TOKEN = 'claire.1leah.2seline.3zara.4'
} = process.env;

// ---- Global fetch fallback (Node < 18) ----
(async () => {
  if (typeof fetch === 'undefined') {
    global.fetch = (await import('node-fetch')).default;
  }
})().catch(() => { /* ignore */ });

// ---- Supabase clients ----
const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });
const sbAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, { auth: { persistSession: false } });

// ---- App setup ----
const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan(NODE_ENV === 'production' ? 'combined' : 'dev'));

// ---- Static dashboards ----
app.use(express.static(path.join(__dirname, 'public')));
// --- legacy paths -> new files ---
app.get('/choose.html', (_req, res) => res.redirect(302, '/auth/role-select.html'));
app.get('/admin/auth/login.html', (_req, res) => res.redirect(302, '/auth/login.html'));

// ---- Helpers ----
const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;
const startOfDayISO = (d = new Date()) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).toISOString();
const endOfDayISO   = (d = new Date()) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).toISOString();

function parseRange(q) {
  if (q.from || q.to) {
    const from = q.from ? new Date(q.from) : new Date();
    const to   = q.to   ? new Date(q.to)   : new Date();
    return { from: startOfDayISO(from), to: endOfDayISO(to) };
  }
  if (q.date) {
    const d = new Date(q.date);
    return { from: startOfDayISO(d), to: endOfDayISO(d) };
  }
  return { from: startOfDayISO(), to: endOfDayISO() };
}

function cutoffDate(days = 30) {
  const n = Math.max(1, Math.min(365, parseInt(days, 10) || 30));
  const d = new Date(Date.now() - n * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
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
    .select('id')
    .eq('matatu_id', matatu_id)
    .eq('type', 'SACCO_FEE')
    .gte('created_at', today);
  if (error) throw error;
  return (data || []).length > 0;
}

function computeSplits({ amount, rules, takeDailyFee }) {
  const fare = round2(amount);
  const serviceFee = round2(rules.fare_fee_flat_kes ?? 2.5);
  const savings = round2((rules.savings_percent / 100) * fare);
  const loanRepay = round2((rules.loan_repay_percent / 100) * fare);
  const saccoDaily = takeDailyFee ? round2(rules.sacco_daily_fee_kes) : 0;

  const parts = [
    { type: 'FARE',        amount_kes: fare },
    { type: 'SERVICE_FEE', amount_kes: serviceFee }
  ];
  if (saccoDaily > 0) parts.push({ type: 'SACCO_FEE',  amount_kes: saccoDaily });
  if (savings > 0)    parts.push({ type: 'SAVINGS',    amount_kes: savings });
  if (loanRepay > 0)  parts.push({ type: 'LOAN_REPAY', amount_kes: loanRepay });
  return parts;
}

// USSD helpers
function sumDigits(str) { return (str || '').split('').reduce((a, c) => a + (Number(c) || 0), 0); }
function digitalRoot(n) { let s = sumDigits(String(n)); while (s > 9) s = sumDigits(String(s)); return s; }
function parseUssdDigits(ussd) { const m = String(ussd).match(/(\d{3})(\d)(?=#|$)/); if (!m) return null; return { base: m[1], check: m[2] }; }
function fullCode(prefix, base, check) { const p = prefix || '*001*'; return `${p}${base}${check}#`; }

// ---- Health ----
app.get('/health', (req, res) => res.json({ ok: true, env: NODE_ENV, time: new Date().toISOString() }));

// =======================
// AUTH + ROLES
// =======================
app.get('/config.json', (req, res) => { res.json({ SUPABASE_URL, SUPABASE_ANON_KEY }); });

async function requireUser(req, res, next) {
  try {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'No token' });

    let user = null;
    if (SUPABASE_JWT_SECRET) {
      try {
        const payload = jwt.verify(token, SUPABASE_JWT_SECRET);
        if (payload?.sub) user = { id: payload.sub, email: payload.email || '' };
      } catch (_) { /* fallback */ }
    }
    if (!user) {
      const { data, error } = await sb.auth.getUser(token);
      if (error) throw error;
      user = { id: data.user.id, email: data.user.email || '' };
    }
    req.user = user;
    next();
  } catch (e) {
    res.status(401).json({ error: 'Unauthorized', detail: e.message });
  }
}

function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (!token || token !== ADMIN_TOKEN) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

async function getSaccoRoles(userId) {
  const { data, error } = await sb
    .from('sacco_users')
    .select('sacco_id, role, saccos!inner(name)')
    .eq('user_id', userId);
  if (error) throw error;
  return (data || []).map(r => ({ sacco_id: r.sacco_id, role: r.role, sacco_name: r.saccos?.name || '' }));
}
async function getMatatuRoles(userId) {
  const { data, error } = await sb
    .from('matatu_members')
    .select('matatu_id, member_role, matatus!inner(number_plate, sacco_id)')
    .eq('user_id', userId);
  if (error) throw error;
  return (data || []).map(r => ({
    matatu_id: r.matatu_id,
    member_role: r.member_role,
    plate: r.matatus?.number_plate || '',
    sacco_id: r.matatus?.sacco_id || null
  }));
}

async function requireSaccoMember(req, res, next) {
  try {
    const saccoId = req.params.saccoId || req.query.sacco_id || req.body.sacco_id;
    if (!saccoId) return res.status(400).json({ error: 'sacco_id required' });
    const roles = await getSaccoRoles(req.user.id);
    const row = roles.find(r => r.sacco_id === saccoId);
    if (!row) return res.status(403).json({ error: 'Forbidden (not a member)' });
    req.saccoRole = row.role;
    next();
  } catch (e) { res.status(500).json({ error: e.message }); }
}
function requireSaccoRole(allowed = []) {
  return async (req, res, next) => {
    try {
      const saccoId = req.params.saccoId || req.query.sacco_id || req.body.sacco_id;
      if (!saccoId) return res.status(400).json({ error: 'sacco_id required' });
      const roles = await getSaccoRoles(req.user.id);
      const row = roles.find(r => r.sacco_id === saccoId);
      if (!row) return res.status(403).json({ error: 'Forbidden (not a SACCO member)' });
      if (allowed.length && !allowed.includes(row.role)) {
        return res.status(403).json({ error: `Required roles: ${allowed.join(', ')}` });
      }
      req.saccoRole = row.role;
      next();
    } catch (e) { res.status(500).json({ error: e.message }); }
  };
}
function requireMatatuRole(allowed = ['owner','conductor']) {
  return async (req, res, next) => {
    try {
      const matatuId = req.params.matatuId || req.query.matatu_id || req.body.matatu_id;
      if (!matatuId) return res.status(400).json({ error: 'matatu_id required' });
      const roles = await getMatatuRoles(req.user.id);
      const row = roles.find(r => r.matatu_id === matatuId);
      if (!row) return res.status(403).json({ error: 'Forbidden (not a member of this matatu)' });
      if (allowed.length && !allowed.includes(row.member_role)) {
        return res.status(403).json({ error: `Required roles: ${allowed.join(', ')}` });
      }
      req.matatuRole = row.member_role;
      next();
    } catch (e) { res.status(500).json({ error: e.message }); }
  };
}

// -------- AUTH routes --------
app.post('/auth/signup', async (req, res) => {
  try {
    const { email, password, sacco_id, sacco_role='STAFF', matatu_id, member_role='conductor' } = req.body || {};
    if (!email || !password) return res.status(400).json({ ok:false, error:'email & password required' });

    const { data, error } = await sb.auth.signUp({ email, password });
    if (error) throw error;

    const userId = data.user?.id;
    if (userId && sacco_id) await sbAdmin.from('sacco_users').insert([{ sacco_id, user_id: userId, role: sacco_role }]);
    if (userId && matatu_id) await sbAdmin.from('matatu_members').upsert({ user_id: userId, matatu_id, member_role });

    res.json({ ok:true, needs_confirmation: !data.session, session: data.session || null });
  } catch (e) {
    res.status(500).json({ ok:false, error: e.message });
  }
});

async function doLogin(email, password) {
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error) throw error;

  const { data: su } = await sb
    .from('sacco_users')
    .select('sacco_id, role, saccos(name,default_till)')
    .eq('user_id', data.user.id);

  const { data: mm } = await sb
    .from('matatu_members')
    .select('matatu_id, member_role, matatus(number_plate,sacco_id)')
    .eq('user_id', data.user.id);

  return {
    access_token: data.session?.access_token,
    refresh_token: data.session?.refresh_token,
    user: { id: data.user?.id, email: data.user?.email },
    saccos: (su || []).map(r => ({ sacco_id:r.sacco_id, role:r.role, sacco_name:r.saccos?.name || '', default_till:r.saccos?.default_till || null })),
    matatus: (mm || []).map(r => ({ matatu_id:r.matatu_id, member_role:r.member_role, plate:r.matatus?.number_plate || '', sacco_id:r.matatus?.sacco_id || null }))
  };
}

app.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ ok:false, error:'email & password required' });
    const session = await doLogin(email, password);
    res.json({ ok:true, ...session });
  } catch (e) {
    res.status(401).json({ ok:false, error: e.message });
  }
});
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ success:false, error:'email & password required' });
    const s = await doLogin(email, password);
    res.json({ success:true, ...s });
  } catch (e) { res.status(401).json({ success:false, error:e.message }); }
});
app.post('/auth/logout', requireUser, async (_req, res) => {
  try { await sb.auth.signOut(); res.json({ ok:true }); }
  catch { res.json({ ok:true }); }
});

// Legacy stubs
app.get('/api/auth/session', (_req, res) => res.json({ loggedIn: true, role: 'SACCO_ADMIN', cashierId: 'CASHIER-001' }));
app.post('/api/auth/logout', (_req, res) => res.json({ ok: true }));

// Who am I & roles
app.get('/api/me', requireUser, (req, res) => res.json({ id: req.user.id, email: req.user.email }));
app.get('/api/my-roles', requireUser, async (req, res) => {
  try { res.json({ saccos: await getSaccoRoles(req.user.id), matatus: await getMatatuRoles(req.user.id) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/my-saccos', requireUser, async (req, res) => {
  try { res.json({ items: await getSaccoRoles(req.user.id) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/my-matatus', requireUser, async (req, res) => {
  try { res.json({ items: await getMatatuRoles(req.user.id) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// =======================
// ADMIN: SACCOS / MATATUS / CASHIERS / RULESETS
// =======================
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

// ✅ Confirm user email manually (dev helper)
app.post('/admin/users/confirm', requireAdmin, async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ ok: false, error: 'Missing email' });

    // List users with service-role client and find by email
    let target = null;
    let page = 1;
    const perPage = 1000;

    while (!target) {
      const { data, error } = await sbAdmin.auth.admin.listUsers({ page, perPage });
      if (error) throw error;
      const users = data?.users || [];
      target = users.find(u => (u.email || '').toLowerCase() === email.toLowerCase());
      if (!target && users.length < perPage) break; // no more pages
      page += 1;
    }

    if (!target) return res.status(404).json({ ok: false, error: 'User not found' });

    const { error: upErr } = await sbAdmin.auth.admin.updateUserById(target.id, {
      email_confirm: true
    });
    if (upErr) throw upErr;

    res.json({ ok: true, message: `Email ${email} confirmed successfully` });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// =======================
// MEMBERS API + LOOKUPS
// =======================
async function rpcLookupUser(emailOrPattern) {
  let rv = await sbAdmin.rpc('lookup_user_id_by_email', { p_email: emailOrPattern });
  if (!rv || rv.error) rv = await sbAdmin.rpc('find_auth_user', { p_email: emailOrPattern });
  if (rv.error) throw rv.error;
  return rv.data || [];
}

app.get('/admin/users/lookup', requireAdmin, async (req, res) => {
  try {
    const email = (req.query.email || '').trim();
    if (!email) return res.status(400).json({ ok: false, error: 'email is required' });
    const data = await rpcLookupUser(`%${email}%`);
    res.json({ ok: true, data });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ✅ Add /admin/saccos/add-user (accepts user_id OR email)
app.post('/admin/saccos/add-user', requireAdmin, async (req, res) => {
  try {
    const { sacco_id, role = 'STAFF', user_id, email } = req.body || {};
    if (!sacco_id) return res.status(400).json({ ok: false, error: 'sacco_id is required' });

    let uid = (user_id || '').trim();
    if (!uid) {
      const em = (email || '').trim();
      if (!em) return res.status(400).json({ ok: false, error: 'email or user_id is required' });
      try {
        const matches = await rpcLookupUser(`%${em}%`);
        if (!matches.length) return res.status(404).json({ ok: false, error: 'user not found by email' });
        uid = matches[0].id;
      } catch (e) {
        return res.status(500).json({ ok: false, error: `lookup failed: ${e.message}` });
      }
    }

    const { data, error } = await sbAdmin
      .from('sacco_users')
      .upsert({ sacco_id, user_id: uid, role }, { onConflict: 'sacco_id,user_id' })
      .select('sacco_id,user_id,role')
      .single();

    if (error) throw error;
    res.json({ ok: true, link: data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/members/by-email', requireAdmin, async (req, res) => {
  try {
    const { email, matatu_id, role } = req.body || {};
    if (!email || !matatu_id || !role) return res.status(400).json({ ok: false, error: 'email, matatu_id and role are required' });
    if (!['owner', 'conductor'].includes(String(role))) return res.status(400).json({ ok: false, error: 'role must be "owner" or "conductor"' });

    const users = await rpcLookupUser(email);
    if (!users || users.length === 0) return res.status(404).json({ ok: false, error: 'user not found' });
    const user_id = users[0].id;

    const { data, error } = await sbAdmin
      .from('matatu_members')
      .upsert({ user_id, matatu_id, member_role: role }, { onConflict: 'user_id,matatu_id' })
      .select('user_id, matatu_id, member_role')
      .single();
    if (error) throw error;
    res.json({ ok: true, data });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/members/of-matatu', requireAdmin, async (req, res) => {
  try {
    const { matatu_id } = req.query;
    if (!matatu_id) return res.status(400).json({ ok: false, error: 'matatu_id is required' });
    const { data, error } = await sb
      .from('matatu_members')
      .select('user_id, matatu_id, member_role')
      .eq('matatu_id', matatu_id);
    if (error) throw error;
    res.json({ ok: true, data: data || [] });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// =======================
// PRICING PREVIEW (fee quote)
// =======================
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

// =======================
// POS LISTENER (amount prefill)
// =======================
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

// =======================
// CASHIER FLOW (initiate, callback, status)
// =======================
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

    // Simulate success after 5s (replace with real callback later)
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
          ussd_code,
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
    res.status(200).json({ success: false, error: err.message });
  }
});

async function handleMpesaCallback(payload) {
  const { checkout_id, success, amount, msisdn, sacco_id, matatu_id, cashier_id, ussd_code, receipt } = payload;
  if (!checkout_id || amount == null || !sacco_id) throw new Error('checkout_id, amount, sacco_id required');

  const baseTx = {
    sacco_id, matatu_id, cashier_id, ussd_code,
    passenger_msisdn: msisdn || null,
    fare_amount_kes: round2(amount),
    service_fee_kes: 2.5,
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

app.get('/api/cashier/status/:id', async (req, res) => {
  try {
    const key = req.params.id;
    let { data, error } = await sb.from('transactions').select('status').eq('id', key).maybeSingle();
    if (!data) {
      const r = await sb.from('transactions').select('status').eq('mpesa_checkout_id', key).maybeSingle();
      data = r.data; error = r.error;
    }
    if (error) throw error;
    const status = data?.status || 'PENDING';
    res.json({ final: ['SUCCESS','FAILED','TIMEOUT'].includes(status), status });
  } catch (err) { res.status(200).json({ final: true, status: 'FAILED', error: err.message }); }
});

// =======================
// PUBLIC / SACCO / OWNER UTILITIES
// =======================
app.get('/api/public/saccos', async (_req, res) => {
  try {
    const { data, error } = await sb.from('saccos').select('id,name').order('name');
    if (error) throw error;
    res.json({ items: data || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

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

// =======================
// DAILY FEES
// =======================
app.post('/fees/record', async (req, res) => {
  try {
    const { matatu_id, amount, paid_at } = req.body || {};
    if (!matatu_id || !amount) return res.status(400).json({ ok: false, error: 'matatu_id and amount required' });
    const payload = { matatu_id, amount };
    if (paid_at) payload.paid_at = paid_at; // YYYY-MM-DD
    const { data, error } = await sbAdmin.from('daily_fees').insert(payload).select().single();
    if (error) throw error;
    res.json({ ok: true, data });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/fees/by-matatu', async (req, res) => {
  try {
    const { matatu_id } = req.query;
    if (!matatu_id) return res.status(400).json({ ok: false, error: 'matatu_id is required' });
    const days = parseInt(req.query.days || '30', 10);
    const since = cutoffDate(isNaN(days) ? 30 : days);
    const { data, error } = await sb
      .from('daily_fees')
      .select('id, matatu_id, amount, paid_at, created_at')
      .eq('matatu_id', matatu_id)
      .gte('paid_at', since)
      .order('paid_at', { ascending: false });
    if (error) throw error;
    res.json({ ok: true, since, days: isNaN(days) ? 30 : days, data: data || [] });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/reports/sacco/:id/fees/summary', async (req, res) => {
  try {
    const saccoId = req.params.id;
    const days = parseInt(req.query.days || '30', 10);
    const since = cutoffDate(isNaN(days) ? 30 : days);
    const { data, error } = await sb
      .from('daily_fees')
      .select('amount, paid_at, matatus!inner(sacco_id)')
      .eq('matatus.sacco_id', saccoId)
      .gte('paid_at', since);
    if (error) throw error;
    const total = (data || []).reduce((sum, r) => sum + Number(r.amount || 0), 0);
    res.json({ ok: true, sacco_id: saccoId, since, days: isNaN(days) ? 30 : days, total_amount: round2(total), rows: data?.length || 0 });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/reports/matatu/:id/fees/summary', async (req, res) => {
  try {
    const matatuId = req.params.id;
    const days = parseInt(req.query.days || '30', 10);
    const since = cutoffDate(isNaN(days) ? 30 : days);
    const { data, error } = await sb
      .from('daily_fees')
      .select('amount, paid_at')
      .eq('matatu_id', matatuId)
      .gte('paid_at', since);
    if (error) throw error;
    const total = (data || []).reduce((sum, r) => sum + Number(r.amount || 0), 0);
    res.json({ ok: true, matatu_id: matatuId, since, days: isNaN(days) ? 30 : days, total_amount: round2(total), rows: data?.length || 0 });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// =======================
// USSD POOL
// =======================
app.get('/api/admin/ussd/pool/available', requireAdmin, async (req, res) => {
  try {
    const prefix = req.query.prefix || '*001*';
    const { data, error } = await sb.from('ussd_pool').select('base, checksum').eq('allocated', false).order('base');
    if (error) throw error;
    const items = (data || []).map(r => ({ base: r.base, checksum: r.checksum, full_code: fullCode(prefix, r.base, r.checksum) }));
    res.json({ items });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/ussd/pool/allocated', requireAdmin, async (req, res) => {
  try {
    const prefix = req.query.prefix || '*001*';
    const { data, error } = await sb
      .from('ussd_pool')
      .select('base, checksum, level, sacco_id, matatu_id, cashier_id, allocated_at')
      .eq('allocated', true)
      .order('allocated_at', { ascending: false });
    if (error) throw error;
    const items = (data || []).map(r => ({
      full_code: fullCode(prefix, r.base, r.checksum),
      level: r.level, sacco_id: r.sacco_id, matatu_id: r.matatu_id, cashier_id: r.cashier_id, allocated_at: r.allocated_at
    }));
    res.json({ items });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/ussd/pool/assign-next', requireAdmin, async (req, res) => {
  try {
    const { level, sacco_id, matatu_id, cashier_id, prefix = '*001*' } = req.body || {};
    const { assigned_type, assigned_id } = resolveTarget(level, { sacco_id, matatu_id, cashier_id });

    const { data: nextFree, error: qErr } = await sb
      .from('ussd_pool')
      .select('base, checksum')
      .eq('allocated', false)
      .order('base', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (qErr) throw qErr;
    if (!nextFree) return res.status(400).json({ success: false, error: 'no free codes in pool' });

    const { error: upErr } = await sbAdmin
      .from('ussd_pool')
      .update({
        allocated: true,
        level: assigned_type,
        sacco_id: assigned_type === 'SACCO' ? assigned_id : null,
        matatu_id: assigned_type === 'MATATU' ? assigned_id : null,
        cashier_id: assigned_type === 'CASHIER' ? assigned_id : null,
        allocated_at: new Date().toISOString()
      })
      .eq('base', nextFree.base);
    if (upErr) throw upErr;

    res.json({ success: true, ussd_code: fullCode(prefix, nextFree.base, nextFree.checksum) });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/admin/ussd/bind-from-pool', requireAdmin, async (req, res) => {
  try {
    const { level, sacco_id, matatu_id, cashier_id, ussd_code, prefix = '*001*' } = req.body || {};
    const { assigned_type, assigned_id } = resolveTarget(level, { sacco_id, matatu_id, cashier_id });

    const parsed = parseUssdDigits(ussd_code);
    if (!parsed) return res.status(400).json({ success: false, error: 'invalid code format' });

    const want = String(digitalRoot(parsed.base));
    if (want !== parsed.check) {
      return res.status(400).json({ success: false, error: `checksum mismatch; expected ${want}` });
    }

    const { data, error } = await sb.from('ussd_pool').select('allocated, checksum').eq('base', parsed.base).maybeSingle();
    if (error) throw error;
    if (!data) return res.status(400).json({ success: false, error: 'base not in pool' });
    if (data.allocated) return res.status(400).json({ success: false, error: 'already allocated' });

    const { error: upErr } = await sbAdmin
      .from('ussd_pool')
      .update({
        allocated: true,
        level: assigned_type,
        sacco_id: assigned_type === 'SACCO' ? assigned_id : null,
        matatu_id: assigned_type === 'MATATU' ? assigned_id : null,
        cashier_id: assigned_type === 'CASHIER' ? assigned_id : null,
        allocated_at: new Date().toISOString()
      })
      .eq('base', parsed.base);
    if (upErr) throw upErr;

    res.json({ success: true, ussd_code: fullCode(prefix, parsed.base, parsed.check) });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

function resolveTarget(level, ids) {
  const L = String(level || '').toUpperCase();
  if (L === 'MATATU' && ids.matatu_id) return { assigned_type: 'MATATU', assigned_id: ids.matatu_id };
  if (L === 'SACCO'  && ids.sacco_id)  return { assigned_type: 'SACCO',  assigned_id: ids.sacco_id };
  if (L === 'CASHIER'&& ids.cashier_id)return { assigned_type: 'CASHIER',assigned_id: ids.cashier_id };
  throw new Error('level and matching id required');
}

// ---- Member-scoped reads (aliases) ----
app.get('/u/my-saccos', requireUser, async (req,res)=>{
  const { data, error } = await sb
    .from('sacco_users').select('sacco_id, role, saccos(name,default_till)')
    .eq('user_id', req.user.id);
  if (error) return res.status(500).json({ error:error.message });
  res.json({ items:(data||[]).map(r=>({ sacco_id:r.sacco_id, role:r.role, name:r.saccos?.name, default_till:r.saccos?.default_till })) });
});

app.get('/u/sacco/:saccoId/transactions', requireUser, requireSaccoMember, async (req,res)=>{
  const { saccoId } = req.params; const { status, limit=50 } = req.query;
  let q = sb.from('transactions')
    .select('id,matatu_id,cashier_id,passenger_msisdn,fare_amount_kes,service_fee_kes,status,mpesa_receipt,created_at')
    .eq('sacco_id', saccoId)
    .order('created_at', { ascending:false })
    .limit(Number(limit));
  if (status) q = q.eq('status', status);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error:error.message });
  res.json({ items:data||[] });
});

app.get('/u/sacco/:saccoId/matatus', requireUser, requireSaccoMember, async (req,res)=>{
  const { saccoId } = req.params;
  const { data, error } = await sb.from('matatus')
    .select('id,number_plate,owner_name,owner_phone,vehicle_type,tlb_number,till_number,created_at')
    .eq('sacco_id', saccoId).order('created_at', { ascending:false });
  if (error) return res.status(500).json({ error:error.message });
  res.json({ items:data||[] });
});

app.get('/u/sacco/:saccoId/summary', requireUser, requireSaccoMember, async (req,res)=>{
  const { saccoId } = req.params; const { from, to } = parseRange(req.query);
  const { data, error } = await sb.from('ledger_entries')
    .select('type,amount_kes')
    .eq('sacco_id', saccoId).gte('created_at', from).lt('created_at', to);
  if (error) return res.status(500).json({ error:error.message });
  const totals = (data||[]).reduce((a,r)=>{ a[r.type]=(a[r.type]||0)+Number(r.amount_kes); return a; },{});
  const fare=+totals.FARE||0, savings=+totals.SAVINGS||0, loan=+totals.LOAN_REPAY||0, saccofee=+totals.SACCO_FEE||0;
  res.json({ range:{from,to}, totals:{ ...totals, NET_TO_OWNER: +(fare-savings-loan-saccofee).toFixed(2) } });
});

// ---- Default route (optional) ----
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---- Start server ----
app.listen(PORT, () => {
  console.log(`[TekeTeke] Listening on :${PORT}`);
  console.log('[ENV] URL:', !!SUPABASE_URL, 'ANON:', !!SUPABASE_ANON_KEY, 'SRV:', !!SUPABASE_SERVICE_ROLE);
});

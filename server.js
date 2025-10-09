// server.js â€” TekeTeke backend (dashboards + auth + USSD pool + fees/reports)
require('dotenv').config();

// ---- Core imports ----
const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const pinoHttp = require('pino-http');
const jwt = require('jsonwebtoken');
const { getEnv } = require('./env');
const YAML = require('yaml');
const swaggerUi = require('swagger-ui-express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const compression = require('compression');
const { randomUUID } = require('crypto');

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

// Basic env validation (no secrets logged)
const _envState = getEnv();\nif (!_envState.ok) {\n  console.warn('[ENV] Missing required vars (non-fatal):', _envState.missing.join(', '));\n}\n}

// ---- Global fetch fallback (Node < 18) ----
(async () => {
  if (typeof fetch === 'undefined') {
    global.fetch = (await import('node-fetch')).default;
  }
})().catch(() => { /* ignore */ });

let _supabaseCreateClient = null;
async function _importSupabase() {
  if (_supabaseCreateClient) return _supabaseCreateClient;
  const mod = await import('@supabase/supabase-js');
  _supabaseCreateClient = mod.createClient;
  return _supabaseCreateClient;
}app.use(compression());
app.use(helmet({
  crossOriginEmbedderPolicy: false,
  // Disable global CSP; route-specific CSP is applied for docs only
  contentSecurityPolicy: false,
}));
const allowlist = [process.env.APP_URL, process.env.API_URL]
  .concat((process.env.CORS_ORIGIN || '').split(','))
  .map(s => (s || '').trim())
  .filter(Boolean);
app.use(cors({
  origin: function (origin, cb) {
    if (!origin || !allowlist.length) return cb(null, true);
    if (allowlist.includes(origin)) return cb(null, true);
    return cb(new Error('Not allowed by CORS: ' + origin));
  },
  credentials: true,
  exposedHeaders: ['X-Request-ID','RateLimit-Limit','RateLimit-Remaining','RateLimit-Reset'],
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization','x-admin-token']
}));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
// Request ID middleware
app.use((req, _res, next) => {
  const hdr = req.headers['x-request-id'];
  req.id = typeof hdr === 'string' && hdr.trim() ? hdr.trim() : cryptoRandomId();
  next();
});

// Rate limiting for auth and user endpoints
const authLimiter = rateLimit({ windowMs: 5 * 60 * 1000, max: 100, standardHeaders: true, legacyHeaders: false });
app.use(['/api/auth/login', '/api/me'], authLimiter);
// Targeted rate limits for quotes and writes
const quoteLimiter = rateLimit({ windowMs: 5 * 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false });
const writeLimiter = rateLimit({ windowMs: 5 * 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false });

// structured logs with pino
const pretty = process.env.PRETTY_LOGS === '1' && NODE_ENV !== 'production';
app.use(
  pinoHttp({
    autoLogging: { ignore: (req) => req.url === '/ping' },
    customProps: (req, res) => ({
      request_id: req.id,
      user_id: req.user?.id || null,
      route: req.route?.path || null,
      statusCode: res.statusCode,
    }),
    transport: pretty
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: true, singleLine: true } }
      : undefined,
    serializers: {
      req(req) {
        return { method: req.method, url: req.url, id: req.id, headers: minimalReqHeaders(req.headers) };
      },
      res(res) { return { statusCode: res.statusCode }; },
    },
  })
);

// expose request id
app.use((req, res, next) => { res.setHeader('X-Request-ID', req.id); next(); });

// ----- OpenAPI docs (/docs, /openapi.json)
const openapiPath = path.join(__dirname, 'openapi.yaml');
let openapiDoc = {};
try {
  const raw = fs.readFileSync(openapiPath, 'utf8');
  openapiDoc = YAML.parse(raw);
} catch (e) {
  console.warn('[OpenAPI] Could not load openapi.yaml:', e.message);
  openapiDoc = { openapi: '3.0.3', info: { title: 'TekeTeke API', version: 'unknown' } };
}
if (NODE_ENV !== 'production') {
  try {
    fs.watch(openapiPath, { persistent: false }, () => {
      try {
        const raw = fs.readFileSync(openapiPath, 'utf8');
        openapiDoc = YAML.parse(raw);
        console.log('[OpenAPI] Reloaded openapi.yaml');
      } catch (e) {
        console.warn('[OpenAPI] Reload failed:', e.message);
      }
    });
  } catch {}
}
app.get('/openapi.json', (_req, res) => res.json(openapiDoc));

// --- docs CSP (allow extra hosts via env) ---
const extraCspHosts = (process.env.DOCS_CSP_EXTRA || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const docsCspDirectives = {
  defaultSrc: ["'self'"],
  // doc UIs need inline/eval; we keep this only for /docs & /redoc
  scriptSrc: [
    "'self'",
    "'unsafe-inline'",
    "'unsafe-eval'",
    "cdn.redoc.ly",
    "unpkg.com",
    "cdn.jsdelivr.net",
    ...extraCspHosts,
  ],
  styleSrc: ["'self'", "'unsafe-inline'", ...extraCspHosts],
  imgSrc: ["'self'", "data:", "blob:"],
  fontSrc: ["'self'", "data:"],
  connectSrc: ["'self'", "https:", "http:"],
};

const docsCSP = helmet.contentSecurityPolicy({ directives: docsCspDirectives });

// apply only to docs routes
app.use('/docs', docsCSP);
app.use('/docs/light', docsCSP);
app.use('/docs-inject.js', docsCSP);
app.use('/redoc', docsCSP);
app.use('/docs', docsCSP, swaggerUi.serve, swaggerUi.setup(openapiDoc, {
  explorer: true,
  swaggerOptions: {
    displayRequestDuration: true,
    docExpansion: 'none',
    persistAuthorization: true,
    // Inject local tokens into every request if present (runs in browser)
    requestInterceptor: (req) => {
      try {
        if (typeof window !== 'undefined' && window.localStorage) {
          const bearer = window.localStorage.getItem('auth_token');
          const root   = window.localStorage.getItem('tt_root_token');
          if (bearer && !req.headers.Authorization) {
            req.headers.Authorization = `Bearer ${bearer}`;
          }
          if (root && !req.headers['x-admin-token']) {
            req.headers['x-admin-token'] = root;
          }
        }
      } catch (_) {}
      return req;
    },
  },
  customCss: '.topbar { display:none }',
  customSiteTitle: 'TekeTeke API Docs',
  customJs: '/docs-inject.js',
}));

// Swagger UI (light) â€” no token auto-injection
app.use('/docs/light', docsCSP, swaggerUi.serve, swaggerUi.setup(openapiDoc, {
  explorer: true,
  swaggerOptions: {
    displayRequestDuration: true,
    docExpansion: 'none',
    persistAuthorization: true,
  },
  customCss: '.topbar { display:none }',
  customSiteTitle: 'TekeTeke API Docs (Light)'
}));

// Tiny UI injector for /docs to add a "Use tokens from browser" button
app.get('/docs-inject.js', docsCSP, (_req, res) => {
  res.type('application/javascript').send(`
    (function(){
      function addBtn(){
        var container = document.querySelector('.swagger-ui .information-container');
        if (!container || document.getElementById('useLocalTokensBtn')) return;
        var b = document.createElement('button');
        b.id = 'useLocalTokensBtn';
        b.textContent = 'Use tokens from browser';
        b.style.margin='6px 0 0 0'; b.style.padding='6px 10px';
        b.onclick = function(){
          try{
            var bearer = localStorage.getItem('auth_token')||'';
            var root   = localStorage.getItem('tt_root_token')||'';
            if (!bearer && !root) { alert('No tokens in localStorage'); return; }
            var btn = document.querySelector('.auth-wrapper .authorize');
            if (btn) btn.click();
            setTimeout(function(){
              document.querySelectorAll('input[placeholder="api_key"]').forEach(function(el){
                if (el.closest('.modal-ux-content').textContent.includes('x-admin-token')) el.value = root;
              });
              document.querySelectorAll('input[type="text"]').forEach(function(el){
                if (el.placeholder && el.placeholder.toLowerCase().includes('bearer')) el.value = 'Bearer ' + bearer;
              });
            }, 200);
          }catch(e){ console.error(e); }
        };
        container.appendChild(b);
      }
      var iv = setInterval(addBtn, 500);
      setTimeout(function(){ clearInterval(iv); }, 6000);
    })();
  `);
});

// ---- Redoc (public) â€” zero dependency via CDN
app.get('/redoc', docsCSP, (_req, res) => {
  res.type('html').send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8"/>
    <meta name="viewport" content="width=device-width, initial-scale=1"/>
    <title>TekeTeke API â€” ReDoc</title>
    <style>
      body { margin:0; padding:0; }
      .topbar { position:fixed; top:0; left:0; right:0; height:48px; display:flex; align-items:center; gap:12px; padding:0 12px; background:#0b1020; color:#cfe3ff; z-index:10; }
      .topbar a { color:#cfe3ff; text-decoration:none; font-weight:600; }
      redoc { position:absolute; top:48px; left:0; right:0; bottom:0; }
    </style>
    <script src="https://cdn.jsdelivr.net/npm/redoc@2.1.5/bundles/redoc.standalone.js"></script>
  </head>
  <body>
    <div class="topbar">
      <div>TekeTeke API</div>
      <a href="/docs">Swagger UI</a>
      <a href="/openapi.json">openapi.json</a>
    </div>
    <div id="redoc"></div>
    <script>
      Redoc.init('/openapi.json', {
        expandResponses: '200,201',
        onlyRequiredInSamples: true,
        theme: {
          spacing: { unit: 6 },
          typography: { fontSize: '14px', lineHeight: '1.55' },
          codeBlock: { backgroundColor: '#0b1020', textColor: '#cfe3ff' },
          colors: {
            primary: { main: '#1976d2' },
            http: { get:'#4caf50', post:'#1976d2', put:'#ff9800', delete:'#f44336' },
            text: { primary:'#e5e7eb', secondary:'#cbd5e1' },
            background: { main:'#0f172a', contrast:'#111827' }
          }
        }
      }, document.getElementById('redoc'));
      document.body.style.background = '#0f172a';
    </script>
  </body>
</html>`);
});

// ---- Static dashboards (cache-control) ----
app.use('/public', (req, res, next) => {
  if (/\.html?$/.test(req.path)) {
    res.setHeader('Cache-Control', 'no-cache');
  } else {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  }
  next();
}, express.static(path.join(__dirname, 'public')));
// --- legacy paths -> new files ---
app.get('/choose.html', (_req, res) => res.redirect(302, '/auth/role-select.html'));
app.get('/admin/auth/login.html', (_req, res) => res.redirect(302, '/auth/login.html'));

// ---- Helpers ----
const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;
const startOfDayISO = (d = new Date()) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).toISOString();
const endOfDayISO   = (d = new Date()) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).toISOString();
// Count helper for Supabase count queries with head:true
const getCount = (resp) => Number.isFinite(resp?.count) ? resp.count : 0;

// ------- Request-scoped Supabase helpers (RLS awareness) -------
function isAdminReq(req) {
  const auth = (req.headers.authorization || '').trim();
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const legacy = req.headers['x-admin-token'];
  return !!(ADMIN_TOKEN && (token === ADMIN_TOKEN || legacy === ADMIN_TOKEN));
}


async function getSbService() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) return null;
  const createClient = await _importSupabase();
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, { auth: { persistSession: false } });
}

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
app.get('/__health', (_req,res)=>{
  const started = process.uptime();
  return res.json({
    success: true,
    data: {
      uptime_seconds: Math.round(started),
      env: {
        NODE_ENV,
        has_SUPABASE_URL: !!SUPABASE_URL,
        has_SUPABASE_ANON_KEY: !!SUPABASE_ANON_KEY,
        has_SUPABASE_SERVICE_ROLE: !!SUPABASE_SERVICE_ROLE,
        has_ADMIN_TOKEN: !!ADMIN_TOKEN,
      }
    }
  });
});

// Version & build info
app.get('/__version', (_req, res) => {
  try {
    const pkg = require('./package.json');
    const sha = process.env.GIT_SHA || 'local';
    return res.json({
      name: pkg.name,
      version: pkg.version,
      git_sha: sha,
      node: process.version,
      env: NODE_ENV,
      time: new Date().toISOString()
    });
  } catch (e) {
    return res.json({ name: 'teketeke', version: 'unknown', git_sha: process.env.GIT_SHA || 'local' });
  }
});

// Simple heartbeat
app.get('/ping', (_req, res) => res.send('pong'));

// =======================
// AUTH + ROLES
// =======================
app.get('/config.json', (req, res) => { res.json({ SUPABASE_URL, SUPABASE_ANON_KEY }); });

// standard response helpers
const ok = (res, data) => res.json({ success: true, data });
const fail = (res, status, msg) => res.status(status).json({ success: false, error: msg });
const sanitizeErr = (e)=>{
  const m = (e && e.message) ? String(e.message) : 'Unexpected error';
  // avoid leaking SQL/snippet content
  return m.length > 300 ? m.slice(0,300) + 'â€¦' : m;
};

async function requireUser(req, res, next) {
  try {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!token) return fail(res, 401, 'Unauthorized');

    // Allow Bearer ADMIN_TOKEN to act as SYSTEM_ADMIN for convenience and ops
    if (ADMIN_TOKEN && token === ADMIN_TOKEN) {
      req.user = { id: 'admin', email: 'admin@skyyalla.com', role: 'SYSTEM_ADMIN' };
      return next();
    }

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
    fail(res, 401, 'Unauthorized');
  }
}

function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (!token || token !== ADMIN_TOKEN) return fail(res, 401, 'Unauthorized');
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
  try { return ok(res, { saccos: await getSaccoRoles(req.user.id), matatus: await getMatatuRoles(req.user.id) }); }
  catch (e) { return fail(res, 500, sanitizeErr(e)); }
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
// List Saccos (search + pagination)
app.get('/api/admin/saccos', requireAdmin, async (req, res) => {
  try {
    const { q = '', limit = 100, offset = 0 } = req.query;
    let query = sb
      .from('saccos')
      .select('id,name,contact_name,contact_phone,contact_email,default_till,created_at', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(Number(offset), Number(offset) + Number(limit) - 1);
    if (q) query = query.ilike('name', `%${q}%`);
    const { data, error, count } = await query;
    if (error) throw error;
    return res.json({ success: true, items: data || [], count: count || 0 });
  } catch (err) { return fail(res, 500, sanitizeErr(err)); }
});

// List Matatus (optional sacco filter + pagination)
app.get('/api/admin/matatus', requireAdmin, async (req, res) => {
  try {
    const { sacco_id = '', limit = 200, offset = 0 } = req.query;
    let query = sb
      .from('matatus')
      .select('id,number_plate,owner_name,owner_phone,vehicle_type,tlb_number,till_number,sacco_id,created_at', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(Number(offset), Number(offset) + Number(limit) - 1);
    if (sacco_id) query = query.eq('sacco_id', sacco_id);
    const { data, error, count } = await query;
    if (error) throw error;
    return res.json({ success: true, items: data || [], count: count || 0 });
  } catch (err) { return fail(res, 500, sanitizeErr(err)); }
});
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
    return ok(res, { id: data.id });
  } catch (err) { return fail(res, 500, sanitizeErr(err)); }
});

app.post('/api/admin/update-sacco', requireAdmin, async (req, res) => {
  try {
    const { id, ...fields } = req.body || {};
    if (!id) return res.status(400).json({ success: false, error: 'id required' });
    const { error } = await sbAdmin.from('saccos').update(fields).eq('id', id);
    if (error) throw error;
    return ok(res, { updated: true });
  } catch (err) { return fail(res, 500, sanitizeErr(err)); }
});

app.delete('/api/admin/delete-sacco/:id', requireAdmin, async (req, res) => {
  try {
    const { error } = await sbAdmin.from('saccos').delete().eq('id', req.params.id);
    if (error) throw error;
    return ok(res, { deleted: true });
  } catch (err) { return fail(res, 500, sanitizeErr(err)); }
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
    return ok(res, { id: data.id });
  } catch (err) { return fail(res, 500, sanitizeErr(err)); }
});

app.post('/api/admin/update-matatu', requireAdmin, async (req, res) => {
  try {
    const { id, ...fields } = req.body || {};
    if (!id) return res.status(400).json({ success: false, error: 'id required' });
    const { error } = await sbAdmin.from('matatus').update(fields).eq('id', id);
    if (error) throw error;
    return ok(res, { updated: true });
  } catch (err) { return fail(res, 500, sanitizeErr(err)); }
});

app.delete('/api/admin/delete-matatu/:id', requireAdmin, async (req, res) => {
  try {
    const { error } = await sbAdmin.from('matatus').delete().eq('id', req.params.id);
    if (error) throw error;
    return ok(res, { deleted: true });
  } catch (err) { return fail(res, 500, sanitizeErr(err)); }
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
  try { return ok(res, { rules: await getRuleset(req.params.saccoId) }); }
  catch (err) { return fail(res, 500, sanitizeErr(err)); }
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
    return ok(res, { rules: payload });
  } catch (err) { return fail(res, 500, sanitizeErr(err)); }
});

// âœ… Confirm user email manually (dev helper)
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

// âœ… Add /admin/saccos/add-user (accepts user_id OR email)
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
app.post('/api/fees/quote', quoteLimiter, async (req, res) => {
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
app.post('/api/pos/latest', requireUser, writeLimiter, async (req, res) => {
  try {
    const sbr = getSbFor(req);
    const { cashier_id, amount } = req.body || {};
    if (!cashier_id || !Number.isFinite(Number(amount))) {
      return res.status(422).json({ success: false, error: 'cashier_id and numeric amount required' });
    }
    const { error } = await sbr.from('pos_latest').upsert({
      cashier_id,
      amount_kes: round2(amount),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'cashier_id' });
    if (error) return res.status(403).json({ success: false, error: error.message || String(error) });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// NOTE: CASHIER level removed; legacy cashier/POS endpoints removed

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

// =======================
// ADMIN: TRANSACTIONS (for dashboard)
// =======================
app.get('/api/admin/transactions/fees', requireAdmin, async (req, res) => {
  try {
    const { from, to } = parseRange(req.query);
    const { data, error } = await sb
      .from('ledger_entries')
      .select('created_at,sacco_id,matatu_id,amount_kes')
      .eq('type','SACCO_FEE')
      .gte('created_at', from).lt('created_at', to)
      .order('created_at', { ascending: false });
    if (error) throw error;
    const items = (data||[]).map(r=>({
      date: (r.created_at||'').slice(0,10),
      sacco: r.sacco_id || '',
      amount: Number(r.amount_kes||0),
      matatu: r.matatu_id || '',
      time: (r.created_at||'').slice(11,19)
    }));
    // Return array for dashboard compatibility
    return res.json({ success: true, data: items });
  } catch (e) { return fail(res, 500, sanitizeErr(e)); }
});

app.get('/api/admin/transactions/loans', requireAdmin, async (req, res) => {
  try {
    const { from, to } = parseRange(req.query);
    const { data, error } = await sb
      .from('ledger_entries')
      .select('created_at,sacco_id,matatu_id,amount_kes')
      .eq('type','LOAN_REPAY')
      .gte('created_at', from).lt('created_at', to)
      .order('created_at', { ascending: false });
    if (error) throw error;
    const items = (data||[]).map(r=>({
      date: (r.created_at||'').slice(0,10),
      sacco: r.sacco_id || '',
      amount: Number(r.amount_kes||0),
      matatu: r.matatu_id || '',
      time: (r.created_at||'').slice(11,19)
    }));
    return res.json({ success: true, data: items });
  } catch (e) { return fail(res, 500, sanitizeErr(e)); }
});

// ------ Admin Overviews (TekeTeke scope) ------
// System overview (SYSTEM_ADMIN only)
app.get('/api/admin/system-overview', requireUser, requireRole('SYSTEM_ADMIN'), async (req, res) => {
  try {
    const start = startOfDayISO();
    const [saccos, matatus, cashiers, tx, poolAll, poolAvail] = await Promise.all([
      sb.from('saccos').select('*', { count: 'exact', head: true }),
      sb.from('matatus').select('*', { count: 'exact', head: true }),
      sb.from('cashiers').select('*', { count: 'exact', head: true }),
      sb.from('transactions').select('*', { count: 'exact', head: true }).gte('created_at', start),
      sb.from('ussd_pool').select('*', { count: 'exact', head: true }),
      sb.from('ussd_pool').select('*', { count: 'exact', head: true }).eq('assigned', false),
    ]);
    // deltas: today vs yesterday from helper views
    const svc = sbAdmin || sb;
    const [{ data: todayRows }, { data: ydayRows }] = await Promise.all([
      svc.from('v_tx_today_by_sacco').select('tx_count, fees_sum'),
      svc.from('v_tx_yesterday_by_sacco').select('tx_count, fees_sum'),
    ]);
    const sum = (arr, k) => (Array.isArray(arr) ? arr.reduce((a,b)=>a + Number(b?.[k]||0), 0) : 0);
    const tx_today_total = sum(todayRows, 'tx_count');
    const tx_yday_total  = sum(ydayRows,  'tx_count');
    const fees_today     = sum(todayRows, 'fees_sum');
    const fees_yday      = sum(ydayRows,  'fees_sum');

    res.json({
      counts: {
        saccos: getCount(saccos),
        matatus: getCount(matatus),
        cashiers: getCount(cashiers),
        tx_today: getCount(tx),
      },
      deltas: {
        tx_delta: tx_today_total - tx_yday_total,
        fees_delta: Number((fees_today - fees_yday).toFixed(2)),
      },
      ussd_pool: {
        total: getCount(poolAll),
        available: getCount(poolAvail),
        assigned: Math.max(0, getCount(poolAll) - getCount(poolAvail)),
      }
    });
  } catch (e) {
    res.status(500).json({ error: sanitizeErr(e) });
  }
});

// SACCO overview (SACCO_ADMIN or SYSTEM_ADMIN)
app.get('/api/admin/sacco-overview', requireUser, requireRole('SACCO_ADMIN','SYSTEM_ADMIN'), async (req, res) => {
  try {
    const saccoId = req.query.sacco_id;
    if (!saccoId) return res.status(400).json({ error: 'sacco_id required' });
    const start = startOfDayISO();
    const [sacco, matatus, cashiers, tx, feesRows] = await Promise.all([
      sb.from('saccos').select('*').eq('id', saccoId).maybeSingle(),
      sb.from('matatus').select('*', { count: 'exact', head: true }).eq('sacco_id', saccoId),
      sb.from('cashiers').select('*', { count: 'exact', head: true }).eq('sacco_id', saccoId),
      sb.from('transactions').select('*', { count: 'exact', head: true }).eq('sacco_id', saccoId).gte('created_at', start),
      sb.from('ledger_entries').select('amount_kes').eq('sacco_id', saccoId).eq('type', 'SACCO_FEE').gte('created_at', start),
    ]);
    const sumFees = Array.isArray(feesRows?.data) ? feesRows.data.reduce((a,b)=>a + Number(b.amount_kes||0),0) : 0;
    // deltas for this sacco
    const sbr = getSbFor(req);
    const [{ data: td }, { data: yd }] = await Promise.all([
      sbr.from('v_tx_today_by_sacco').select('tx_count, fees_sum').eq('sacco_id', saccoId),
      sbr.from('v_tx_yesterday_by_sacco').select('tx_count, fees_sum').eq('sacco_id', saccoId),
    ]);
    const tx_td = Array.isArray(td)&&td[0] ? Number(td[0].tx_count||0) : 0;
    const tx_yd = Array.isArray(yd)&&yd[0] ? Number(yd[0].tx_count||0) : 0;
    const fees_td = Array.isArray(td)&&td[0] ? Number(td[0].fees_sum||0) : 0;
    const fees_yd = Array.isArray(yd)&&yd[0] ? Number(yd[0].fees_sum||0) : 0;

    res.json({
      sacco: sacco?.data || { id: saccoId },
      counts: { matatus: getCount(matatus), cashiers: getCount(cashiers), tx_today: getCount(tx) },
      fees_today_kes: Math.round(sumFees * 100) / 100,
      deltas: {
        tx_delta: tx_td - tx_yd,
        fees_delta: Number((fees_td - fees_yd).toFixed(2)),
      }
    });
  } catch (e) {
    res.status(500).json({ error: sanitizeErr(e) });
  }
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
app.post('/fees/record', requireUser, writeLimiter, async (req, res) => {
  try {
    const sbr = getSbFor(req);
    const { matatu_id, amount, paid_at } = req.body || {};
    if (!matatu_id || !Number.isFinite(Number(amount))) return res.status(422).json({ ok: false, error: 'matatu_id and numeric amount required' });
    const payload = { matatu_id, amount: round2(amount) };
    if (paid_at) payload.paid_at = paid_at; // YYYY-MM-DD
    const { data, error } = await sbr.from('daily_fees').insert(payload).select().single();
    if (error) return res.status(403).json({ ok: false, error: error.message || String(error) });
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
    return res.json({ success: true, items });
  } catch (err) { return fail(res, 500, sanitizeErr(err)); }
});

app.get('/api/admin/ussd/pool/allocated', requireAdmin, async (req, res) => {
  try {
    const prefix = req.query.prefix || '*001*';
    const { data, error } = await sb
      .from('ussd_pool')
      .select('base, checksum, level, sacco_id, matatu_id, allocated_at')
      .eq('allocated', true)
      .order('allocated_at', { ascending: false });
    if (error) throw error;
    const items = (data || []).map(r => ({
      full_code: fullCode(prefix, r.base, r.checksum),
      level: r.level, sacco_id: r.sacco_id, matatu_id: r.matatu_id, allocated_at: r.allocated_at
    }));
    return res.json({ success: true, items });
  } catch (err) { return fail(res, 500, sanitizeErr(err)); }
});

app.post('/api/admin/ussd/pool/assign-next', requireAdmin, async (req, res) => {
  try {
    const { level, sacco_id, matatu_id, cashier_id, prefix = '*001*' } = req.body || {};
    const L = String(level || '').toUpperCase();
    if (L === 'CASHIER') return res.status(400).json({ success: false, error: 'CASHIER level no longer supported' });
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
    const L = String(level || '').toUpperCase();
    if (L === 'CASHIER') return res.status(400).json({ success: false, error: 'CASHIER level no longer supported' });
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

    return ok(res, { ussd_code: fullCode(prefix, parsed.base, parsed.check) });
  } catch (err) { return fail(res, 500, sanitizeErr(err)); }
});

function resolveTarget(level, ids) {
  const L = String(level || '').toUpperCase();
  if (L === 'MATATU' && ids.matatu_id) return { assigned_type: 'MATATU', assigned_id: ids.matatu_id };
  if (L === 'SACCO'  && ids.sacco_id)  return { assigned_type: 'SACCO',  assigned_id: ids.sacco_id };
  throw new Error('level must be SACCO or MATATU (CASHIER no longer supported)');
}

// Helper: check if user is a SACCO_ADMIN in any sacco
// simple role cache for isSaccoAdmin
const _roleCache = new Map(); // userId -> { val, at }
const _ROLE_TTL_MS = 60 * 1000; // 60s
const _ROLE_MAX = 500;
function _getRoleCache(userId){ const o=_roleCache.get(userId); return (o && (Date.now()-o.at)<_ROLE_TTL_MS) ? o.val : undefined; }
function _setRoleCache(userId,val){ if(_roleCache.size>_ROLE_MAX){ const k=_roleCache.keys().next().value; _roleCache.delete(k);} _roleCache.set(userId,{ val, at:Date.now()}); }

async function isSaccoAdmin(userId) {
  const memo = _getRoleCache(userId);
  if (memo !== undefined) return memo;
  let ok = false;
  try {
    const svc = sbAdmin || sb;
    const { data } = await svc
      .from('sacco_users')
      .select('role')
      .eq('user_id', userId)
      .eq('role', 'SACCO_ADMIN')
      .limit(1)
      .maybeSingle();
    ok = !!data;
  } catch { ok = false; }
  _setRoleCache(userId, ok);
  return ok;
}

// Unified role requirement helper (TekeTeke scope)
function requireRole(...roles) {
  return async (req, res, next) => {
    try {
      const want = new Set(roles.map(r => String(r || '').toUpperCase()));
      if (req.user?.role && want.has(String(req.user.role).toUpperCase())) return next();
      if (want.has('SYSTEM_ADMIN')) {
        // also allow x-admin-token header for SYSTEM_ADMIN
        const root = req.headers['x-admin-token'];
        if (root && root === ADMIN_TOKEN) return next();
      }
      if (want.has('SACCO_ADMIN') && req.user?.id) {
        if (await isSaccoAdmin(req.user.id)) return next();
      }
      return res.status(403).json({ error: 'forbidden' });
    } catch (e) {
      return res.status(500).json({ error: sanitizeErr(e) });
    }
  };
}

// ---- Member-scoped reads (aliases) ----
app.get('/u/my-saccos', requireUser, async (req,res)=>{
  const sbr = getSbFor(req);
  const { data, error } = await sbr
    .from('sacco_users').select('sacco_id, role, saccos(name,default_till)')
    .eq('user_id', req.user.id);
  if (error) return res.status(500).json({ error:error.message });
  res.json({ items:(data||[]).map(r=>({ sacco_id:r.sacco_id, role:r.role, name:r.saccos?.name, default_till:r.saccos?.default_till })) });
});

app.get('/u/sacco/:saccoId/transactions', requireUser, requireSaccoMember, async (req,res)=>{
  const { saccoId } = req.params; const { status, limit=50 } = req.query;
  const sbr = getSbFor(req);
  let q = sbr.from('transactions')
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
  const sbr = getSbFor(req);
  const { data, error } = await sbr.from('matatus')
    .select('id,number_plate,owner_name,owner_phone,vehicle_type,tlb_number,till_number,created_at')
    .eq('sacco_id', saccoId).order('created_at', { ascending:false });
  if (error) return res.status(500).json({ error:error.message });
  res.json({ items:data||[] });
});

app.get('/u/sacco/:saccoId/summary', requireUser, requireSaccoMember, async (req,res)=>{
  const { saccoId } = req.params; const { from, to } = parseRange(req.query);
  const sbr = getSbFor(req);
  const { data, error } = await sbr.from('ledger_entries')
    .select('type,amount_kes')
    .eq('sacco_id', saccoId).gte('created_at', from).lt('created_at', to);
  if (error) return res.status(500).json({ error:error.message });
  const totals = (data||[]).reduce((a,r)=>{ a[r.type]=(a[r.type]||0)+Number(r.amount_kes); return a; },{});
  const fare=+totals.FARE||0, savings=+totals.SAVINGS||0, loan=+totals.LOAN_REPAY||0, saccofee=+totals.SACCO_FEE||0;
  res.json({ range:{from,to}, totals:{ ...totals, NET_TO_OWNER: +(fare-savings-loan-saccofee).toFixed(2) } });
});

// Current user's sacco profile(s) â€” RLS-protected (Bearer required)
app.get('/api/sacco/profile', requireUser, async (req, res) => {
  try {
    const sbr = getSbFor(req);
    const saccoId = isAdminReq(req) ? (req.query.sacco_id || null) : null;
    let saccoRows;
    if (saccoId) {
      const { data, error } = await sbr
        .from('saccos')
        .select('id,name,contact_name,contact_phone,contact_email,default_till,created_at')
        .eq('id', saccoId);
      if (error) return res.status(500).json({ error: String(error.message || error) });
      saccoRows = data || [];
    } else {
      const { data, error } = await sbr
        .from('sacco_users')
        .select('sacco_id, role, saccos!inner(id,name,contact_name,contact_phone,contact_email,default_till,created_at)');
      if (error) return res.status(500).json({ error: String(error.message || error) });
      saccoRows = (data || []).map(r => ({ role: r.role, ...r.saccos }));
    }
    return res.json({ saccos: saccoRows });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
});

// ---- Default route (optional) ----
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---- Start server ----
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`[TekeTeke] Listening on :${PORT}`);
    console.log('[ENV] URL:', !!SUPABASE_URL, 'ANON:', !!SUPABASE_ANON_KEY, 'SRV:', !!SUPABASE_SERVICE_ROLE);
  });
}

// ---- helpers
function cryptoRandomId() {
  try { return randomUUID(); } catch { return 'req-' + Math.random().toString(36).slice(2,10); }
}
function minimalReqHeaders(h){
  return { host: h.host, 'user-agent': h['user-agent'], 'x-request-id': h['x-request-id'], origin: h.origin, referer: h.referer };
}

// ---- Basic rate limit for admin APIs
const adminLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/admin', adminLimiter);

// ---- Global error handler (ensure JSON + request id)
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  try { console.error('[ERR]', req.id || '-', err && err.stack ? err.stack : err); } catch {}
  if (res.headersSent) return;
  const code = err.status || err.statusCode || 500;
  res.status(code).json({
    error: err.code || 'internal_error',
    message: err.message || 'Internal Server Error',
    request_id: req.id || ''
  });
});



// Recent activity (transactions + ledger), RLS-scoped
app.get('/api/sacco/activity', requireUser, async (req, res) => {
  try {
    const sbr = getSbFor(req);
    const saccoId = req.query.sacco_id || null;
    const limit = Math.min(Math.max(parseInt(req.query.limit||'20',10), 1), 100);
    const cursor = req.query.cursor || null; // ISO timestamp keyset
    let txq = sbr.from('transactions').select('id, sacco_id, created_at, fare_amount_kes, status').order('created_at', { ascending: false }).limit(limit);
    let leq = sbr.from('ledger_entries').select('id, sacco_id, created_at, amount_kes, type').order('created_at', { ascending: false }).limit(limit);
    if (saccoId) { txq = txq.eq('sacco_id', saccoId); leq = leq.eq('sacco_id', saccoId); }
    if (cursor)  { txq = txq.lt('created_at', cursor); leq = leq.lt('created_at', cursor); }
    const [tx, le] = await Promise.all([txq, leq]);
    if (tx.error) return res.status(500).json({ error: String(tx.error.message||tx.error) });
    if (le.error) return res.status(500).json({ error: String(le.error.message||le.error) });
    const events = [
      ...(tx.data||[]).map(r => ({ kind:'TX', id:r.id, sacco_id:r.sacco_id, created_at:r.created_at, amount_kes:r.fare_amount_kes, status:r.status })),
      ...(le.data||[]).map(r => ({ kind:'FEE', id:r.id, sacco_id:r.sacco_id, created_at:r.created_at, amount_kes:r.amount_kes, type:r.type }))
    ].sort((a,b)=> (a.created_at > b.created_at ? -1 : 1)).slice(0, limit);
    const next_cursor = events.length ? events[events.length-1].created_at : null;
    res.json({ events, next_cursor });
  } catch (e) {
    res.status(500).json({ error: String(e.message||e) });
  }
});

// Lightweight metrics (public); admin token adds db counts
app.get('/metrics', async (req, res) => {
  const base = {
    service: 'teketeke',
    version: (process.env.COMMIT_SHA || process.env.VERCEL_GIT_COMMIT_SHA || 'dev'),
    time_iso: new Date().toISOString(),
    uptime_s: Math.floor(process.uptime())
  };
  if (isAdminReq(req) && sbAdmin) {
    try {
      const [saccos, matatus, tx] = await Promise.all([
        sbAdmin.from('saccos').select('id', { count:'exact', head:true }),
        sbAdmin.from('matatus').select('id', { count:'exact', head:true }),
        sbAdmin.from('transactions').select('id', { count:'exact', head:true }).gte('created_at', startOfDayISO())
      ]);
      base.db = { saccos: getCount(saccos), matatus: getCount(matatus), tx_today: getCount(tx) };
    } catch {}
  }
  res.json(base);
});

// 404 JSON (after routes)
app.use((req, res) => {
  res.status(404).json({ error: 'not_found', path: req.originalUrl, request_id: req.id || '' });
});

// Export app for Vercel @vercel/node
module.exports = app;





// Healthz (does not touch DB)
app.get('/__healthz', (_req, res) => {
  const state = require('./env').getEnv();
  const hasDbAnon = !!(state.values.SUPABASE_URL && state.values.SUPABASE_ANON_KEY);
  const hasDbSvc  = !!(state.values.SUPABASE_URL && state.values.SUPABASE_SERVICE_ROLE);
  res.json({ ok: state.ok, missing: state.missing, has_db: hasDbAnon, has_db_admin: hasDbSvc });
});






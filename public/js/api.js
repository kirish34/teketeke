// public/js/api.js
(function () {
  // ---- storage keys (with backward compatibility)
  const K = {
    // preferred keys
    root: 'tt_root_token',
    auth: 'auth_token',
    // legacy keys we still read
    legacy_admin: 'tt_admin_token',
    legacy_auth: 'TT_TOKEN',
    // misc existing keys (kept for completeness)
    sacco:  'tt_sacco_id',
    matatu: 'tt_matatu_id',
    till:   'tt_till',
    cashier:'tt_cashier_id',
  };

  // ---- token helpers
  function getRoot() {
    return localStorage.getItem(K.root) || localStorage.getItem(K.legacy_admin) || '';
  }
  function setRoot(v) {
    const val = v || '';
    localStorage.setItem(K.root, val);
    // keep legacy mirror for existing pages
    localStorage.setItem(K.legacy_admin, val);
  }
  function clearRoot() {
    localStorage.removeItem(K.root);
    localStorage.removeItem(K.legacy_admin);
  }
  function getAuth() {
    return localStorage.getItem(K.auth) || localStorage.getItem(K.legacy_auth) || '';
  }
  function setAuth(v) {
    const val = v || '';
    localStorage.setItem(K.auth, val);
    // mirror to legacy for older pages
    localStorage.setItem(K.legacy_auth, val);
  }
  function clearAuth() {
    localStorage.removeItem(K.auth);
    localStorage.removeItem(K.legacy_auth);
  }

  // ---- state (localStorage-backed) for misc app data
  const S = {
    get adminToken() { return getRoot(); },
    set adminToken(v){ setRoot(v); },

    get saccoId()    { return localStorage.getItem(K.sacco) || ''; },
    set saccoId(v)   { localStorage.setItem(K.sacco, v || ''); },

    get matatuId()   { return localStorage.getItem(K.matatu) || ''; },
    set matatuId(v)  { localStorage.setItem(K.matatu, v || ''); },

    get till()       { return localStorage.getItem(K.till) || ''; },
    set till(v)      { localStorage.setItem(K.till, v || ''); },

    get cashierId()  { return localStorage.getItem(K.cashier) || ''; },
    set cashierId(v) { localStorage.setItem(K.cashier, v || ''); },
  };

  // ---- base URL: same-origin by default, or from #api_base select if present
  const BASE = () => {
    const sel = document.getElementById('api_base');
    const v = sel && sel.value ? sel.value.trim() : '';
    return v || ''; // '' = same origin
  };

  // ---- helpers
  const qstr = (obj = {}) => {
    const pairs = Object.entries(obj)
      .filter(([,v]) => v !== undefined && v !== null && v !== '')
      .map(([k,v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
    return pairs.length ? `?${pairs.join('&')}` : '';
  };

  async function j(path, { method = 'GET', body, headers = {} } = {}) {
    const hasBody = body !== undefined && body !== null;
    const h = {
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    };
    const rootTok = getRoot();
    const authTok = getAuth();
    if (rootTok) h['x-admin-token'] = rootTok;
    if (authTok) h['Authorization'] = `Bearer ${authTok}`;

    const res = await fetch(`${BASE()}${path}`, {
      method,
      headers: h,
      body: hasBody ? JSON.stringify(body) : undefined,
    });

    // try to surface API error text
    const text = await res.text();
    if (!res.ok) {
      const msg = text || `${res.status} ${res.statusText}`;
      throw new Error(msg);
    }
    // gracefully handle empty body
    if (!text) return {};
    try { return JSON.parse(text); } catch { return { raw: text }; }
  }

  function logout(redirect = '/auth/role-select.html') {
    try { clearAuth(); } catch {}
    try { clearRoot(); } catch {}
    if (redirect) location.href = redirect;
  }

  // ---- public API
  const TT = {
    // tokens / session
    getRoot, setRoot, clearRoot,
    getAuth, setAuth, clearAuth,
    logout,

    state: S,

    // generic
    get:  (p, params) => j(p + (params ? qstr(params) : '')),
    post: (p, b)     => j(p, { method: 'POST', body: b }),
    del:  (p)        => j(p, { method: 'DELETE' }),
    jpost: (p, b)    => j(p, { method: 'POST', body: b }), // alias for convenience

    // headers helper (for simple fetch calls)
    authHeader: () => {
      const t = getRoot() || getAuth();
      return t ? { Authorization: `Bearer ${t}` } : {};
    },

    // admin: saccos / matatus
    listSaccos:   (q)       => TT.get('/api/admin/saccos', q ? { q } : undefined),
    createSacco:  (b)       => TT.post('/api/admin/register-sacco', b),
    updateSacco:  (b)       => TT.post('/api/admin/update-sacco', b),
    deleteSacco:  (id)      => TT.del(`/api/admin/delete-sacco/${encodeURIComponent(id)}`),

    listMatatus:  (filters) => TT.get('/api/admin/matatus', filters),
    createMatatu: (b)       => TT.post('/api/admin/register-matatu', b),
    updateMatatu: (b)       => TT.post('/api/admin/update-matatu', b),
    deleteMatatu: (id)      => TT.del(`/api/admin/delete-matatu/${encodeURIComponent(id)}`),

    // rules / fees
    getRules:     (saccoId) => TT.get(`/api/admin/rulesets/${encodeURIComponent(saccoId)}`),
    updateRules:  (b)       => TT.post('/api/admin/rulesets', b),
    feeQuote:     (b)       => TT.post('/api/fees/quote', b),

    // ussd pool
    poolAvailable:(pfx)     => TT.get('/api/admin/ussd/pool/available', pfx ? { prefix: pfx } : undefined),
    poolAllocated:(pfx)     => TT.get('/api/admin/ussd/pool/allocated', pfx ? { prefix: pfx } : undefined),
    poolAssignNext:(b)      => TT.post('/api/admin/ussd/pool/assign-next', b),
    poolBindManual:(b)      => TT.post('/api/admin/ussd/bind-from-pool', b),

    // transactions / reports (admin)
    txFeesToday:  ()        => TT.get('/api/admin/transactions/fees'),
    txLoansToday: ()        => TT.get('/api/admin/transactions/loans'),
    settlements:  (saccoId, date) => TT.get('/api/admin/settlements', { sacco_id: saccoId, date }),

    // public/lookup (used by staff/owner/conductor)
    publicSaccos: ()        => TT.get('/api/public/saccos'),
    lookupMatatu: (params)  => TT.get('/api/lookup/matatu', params), // { plate } or { till }

    // member-scoped reads (if you use Supabase auth flows)
    mySaccos:     ()        => TT.get('/u/my-saccos'),
    saccoSummary: (id, range)=> TT.get(`/u/sacco/${encodeURIComponent(id)}/summary`, range),
  };

  window.TT = TT;
  // --- lightweight compatibility wrapper for prompts expecting `ttApi`
  try {
    const getToken = () => getRoot() || getAuth() || '';
    const setTokens = (token) => { setRoot(token || ''); };
    const clearTokens = () => { clearRoot(); };
    const authHeader = () => {
      const t = getToken();
      return t ? { Authorization: `Bearer ${t}` } : {};
    };
    const fetchJSON = async (url, opts = {}) => {
      const res = await fetch(url, opts);
      const ct = (res.headers && res.headers.get && res.headers.get('content-type')) || '';
      const body = ct.includes('application/json') ? await res.json() : await res.text();
      if (!res.ok) {
        const msg = (body && body.error) || (body && body.message) || res.statusText || 'Request failed';
        const err = new Error(msg);
        try { err.status = res.status; err.body = body; } catch {}
        throw err;
      }
      return body;
    };
    window.ttApi = Object.assign(window.ttApi || {}, { getToken, setTokens, clearTokens, authHeader, fetchJSON });
  } catch {}

  // Allow page when user has ANY of the provided roles; else send to role-select
  if (typeof window.protectAny !== 'function') {
    window.protectAny = async function(roles){
      try {
        const headers = (TT && typeof TT.authHeader === 'function') ? TT.authHeader() : {};
        const res = await fetch('/api/my-roles', { headers });
        if (res.status === 401) { location.replace('/auth/login.html'); return; }
        const json = await res.json().catch(()=>({}));
        const arr = Array.isArray(json?.roles) ? json.roles : (Array.isArray(json?.data?.roles) ? json.data.roles : []);
        const set = new Set(arr.map(r => String(r||'').toUpperCase()));
        const ok = (roles||[]).some(r => set.has(String(r||'').toUpperCase()));
        if (!ok) location.replace('/auth/role-select.html');
      } catch {
        location.replace('/auth/login.html');
      }
    }
  }
})();

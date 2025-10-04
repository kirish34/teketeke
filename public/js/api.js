// public/js/api.js
(function () {
  // ---- storage keys
  const K = {
    admin:  'tt_admin_token',
    sacco:  'tt_sacco_id',
    matatu: 'tt_matatu_id',
    till:   'tt_till',
    cashier:'tt_cashier_id',
  };

  // ---- state (localStorage-backed)
  const S = {
    get adminToken() { return localStorage.getItem(K.admin) || ''; },
    set adminToken(v){ localStorage.setItem(K.admin, v || ''); },

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
    const res = await fetch(`${BASE()}${path}`, {
      method,
      headers: {
        ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
        ...(S.adminToken ? { 'x-admin-token': S.adminToken } : {}),
        ...headers,
      },
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

  // ---- public API
  const TT = {
    state: S,

    // generic
    get:  (p, params) => j(p + (params ? qstr(params) : '')),
    post: (p, b)     => j(p, { method: 'POST', body: b }),
    del:  (p)        => j(p, { method: 'DELETE' }),

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
    settlements:  (saccoId, date) =>
                   TT.get('/api/admin/settlements', { sacco_id: saccoId, date }),

    // public/lookup (used by staff/owner/conductor)
    publicSaccos: ()        => TT.get('/api/public/saccos'),
    lookupMatatu: (params)  => TT.get('/api/lookup/matatu', params), // { plate } or { till }

    // member-scoped reads (if you use Supabase auth flows)
    mySaccos:     ()        => TT.get('/u/my-saccos'),
    saccoSummary: (id, range)=> TT.get(`/u/sacco/${encodeURIComponent(id)}/summary`, range),
  };

  window.TT = TT;
})();

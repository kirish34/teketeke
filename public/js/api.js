<script>
/* TekeTeke tiny client */
const TT = (() => {
  const BASE = ""; // same host
  const K = {
    admin: "tt_admin_token",
    sacco: "tt_sacco_id",
    matatu: "tt_matatu_id",
    till: "tt_till",
    cashier: "tt_cashier_id",
  };
  const S = {
    get adminToken(){ return localStorage.getItem(K.admin)||"" },
    set adminToken(v){ localStorage.setItem(K.admin, v||"") },
    get saccoId(){ return localStorage.getItem(K.sacco)||"" },
    set saccoId(v){ localStorage.setItem(K.sacco, v||"") },
    get matatuId(){ return localStorage.getItem(K.matatu)||"" },
    set matatuId(v){ localStorage.setItem(K.matatu, v||"") },
    get till(){ return localStorage.getItem(K.till)||"" },
    set till(v){ localStorage.setItem(K.till, v||"") },
    get cashierId(){ return localStorage.getItem(K.cashier)||"" },
    set cashierId(v){ localStorage.setItem(K.cashier, v||"") },
  };

  async function j(path, {method="GET", body=null, headers={}}={}) {
    const res = await fetch(BASE + path, {
      method,
      headers: {
        "Content-Type":"application/json",
        ...(S.adminToken ? {"x-admin-token": S.adminToken} : {}),
        ...headers
      },
      body: body ? JSON.stringify(body) : undefined
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return await res.json();
  }

  return {
    state: S,
    get: (p) => j(p),
    post: (p,b) => j(p,{method:"POST",body:b}),
    // endpoint shortcuts
    createSacco: (b)=>TT.post("/api/admin/register-sacco", b),
    updateRules: (b)=>TT.post("/api/admin/rulesets", b),
    createMatatu: (b)=>TT.post("/api/admin/register-matatu", b),
    createCashier: (b)=>TT.post("/api/admin/cashier", b),
    feeQuote: (b)=>TT.post("/api/fees/quote", b),
    posLatest: (id)=>TT.get(`/api/pos/latest/${encodeURIComponent(id)}`),
    initiate: (b)=>TT.post("/api/cashier/initiate", b),
    status: (id)=>TT.get(`/api/cashier/status/${encodeURIComponent(id)}`),
    paymentsByTill: (till)=>TT.get(`/api/matatu/payments?till=${encodeURIComponent(till)}`),
    settlements: (saccoId,date)=>TT.get(`/api/admin/settlements?sacco_id=${encodeURIComponent(saccoId)}${date?`&date=${encodeURIComponent(date)}`:""}`)
  };
})();
window.TT = TT;
</script>

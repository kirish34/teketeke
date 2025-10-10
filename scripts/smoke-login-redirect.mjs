// Node >=20.19
const BASE = process.env.BASE_URL;               // e.g. https://teketeke-xxxxx.vercel.app
const EMAIL = process.env.LOGIN_EMAIL;           // test user email
const PASSWORD = process.env.LOGIN_PASSWORD;     // test user password

if (!BASE || !EMAIL || !PASSWORD) {
  console.error("Missing BASE_URL, LOGIN_EMAIL or LOGIN_PASSWORD");
  process.exit(2);
}

const ROUTE = {
  SYSTEM_ADMIN: '/admin.html',
  SACCO_ADMIN: '/sacco/admin.html',
  SACCO_STAFF: '/sacco/sacco.html',
  MATATU_OWNER: '/matatu/owner.html',
  CONDUCTOR: '/conductor/console.html',
};
const FALLBACK = '/auth/role-select.html';

const toArray = (rolesRes) =>
  Array.isArray(rolesRes) ? rolesRes
  : Array.isArray(rolesRes?.roles) ? rolesRes.roles
  : Array.isArray(rolesRes?.data?.roles) ? rolesRes.data.roles
  : [];

const expectedPath = (roles) => (roles.length === 1 && ROUTE[roles[0]]) ? ROUTE[roles[0]] : FALLBACK;

async function fetchJSON(url, opts = {}) {
  const res = await fetch(url, opts);
  const ct = res.headers.get('content-type') || '';
  const body = ct.includes('application/json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${typeof body === 'string' ? body.slice(0,200) : JSON.stringify(body)}`);
  return body;
}

(async () => {
  console.log(`→ BASE: ${BASE}`);

  // 1) Login
  const loginRes = await fetchJSON(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ email: EMAIL, password: PASSWORD })
  });
  const token = loginRes?.access_token || loginRes?.token || loginRes?.data?.access_token;
  if (!token) throw new Error('No access_token in login response');
  console.log('✔ got token');

  // 2) Roles
  const rolesRes = await fetchJSON(`${BASE}/api/my-roles`, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${token}` }
  });
  const roles = toArray(rolesRes);
  console.log('✔ roles:', roles.length ? roles.join(', ') : '(none)');

  // 3) Compute expected path & probe page
  const path = expectedPath(roles);
  const page = await fetch(`${BASE}${path}`, { headers: { Accept: 'text/html' } });
  if (!page.ok) throw new Error(`Expected 200 for ${path}, got ${page.status}`);
  const ctype = page.headers.get('content-type') || '';
  if (!ctype.includes('text/html')) throw new Error(`Expected HTML for ${path}, got ${ctype}`);
  console.log(`✔ page OK: ${path} (${ctype})`);

  console.log('✅ smoke-login-redirect passed');
})().catch((e) => { console.error('❌', e.message); process.exit(1); });


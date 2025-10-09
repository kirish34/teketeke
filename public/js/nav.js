// public/js/nav.js
(function () {
  // Simple auth guards & nav injection
  // Expose minimal helpers on window when this script loads
  function ensureAuthOrRoot() {
    const hasAuth = !!(window.TT && typeof TT.getAuth === 'function' ? TT.getAuth() : localStorage.getItem('auth_token') || localStorage.getItem('TT_TOKEN'));
    const hasRoot = !!(window.TT && typeof TT.getRoot === 'function' ? TT.getRoot() : localStorage.getItem('tt_root_token') || localStorage.getItem('tt_admin_token'));
    if (!hasAuth && !hasRoot) {
      location.href = '/auth/login.html';
    }
  }
  async function protect(targetRole) {
    const want = String(targetRole || '').toUpperCase();
    const hasRoot = !!(window.TT && typeof TT.getRoot === 'function' ? TT.getRoot() : localStorage.getItem('tt_root_token') || localStorage.getItem('tt_admin_token'));
    if (hasRoot) return true; // root bypass
    const auth = window.TT && typeof TT.getAuth === 'function' ? TT.getAuth() : (localStorage.getItem('auth_token') || localStorage.getItem('TT_TOKEN'));
    if (!auth) { location.href = '/auth/login.html'; return false; }
    try {
      const res = await fetch('/api/my-roles', { headers: { Authorization: 'Bearer ' + auth } });
      if (res.status === 401) { location.href = '/auth/login.html'; return false; }
      const data = await res.json();
      if (!want) return true;
      if (want === 'SYSTEM_ADMIN') { location.href = '/auth/role-select.html'; return false; }
      const saccos = Array.isArray(data?.data?.saccos) ? data.data.saccos : (Array.isArray(data?.saccos) ? data.saccos : []);
      const ok = saccos.some(r => String(r.role).toUpperCase() === 'SACCO_ADMIN' || String(r.role).toUpperCase() === 'ADMIN');
      if (!ok) { location.href = '/auth/role-select.html'; return false; }
      return true;
    } catch {
      location.href = '/auth/login.html';
      return false;
    }
  }
  window.ensureAuthOrRoot = ensureAuthOrRoot;
  window.protect = protect;

  // Avoid double injection of nav links
  if (document.querySelector('nav.tt-nav')) return;

  const links = [
    { href: '/',                      label: 'Home',           icon: 'ðŸ ' },
    { href: '/admin.html',            label: 'My Admin',       icon: 'ðŸ‘‘' },
    { href: '/sacco/sacco.html',      label: 'SACCO Admin',    icon: 'ðŸ¢' },
    { href: '/auth/role-select.html', label: 'Logins',         icon: 'ðŸ”' },
    { href: '/auth/login.html',       label: 'Login',          icon: 'ðŸ”' },
    { href: '/auth/logout.html',      label: 'Logout',         icon: 'ðŸšª' }
  ];

  // Inject styles once
  if (!document.getElementById('tt-nav-style')) {
    const style = document.createElement('style');
    style.id = 'tt-nav-style';
    style.textContent = `
      .tt-nav{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:0 0 12px}
      .tt-link{display:inline-block;padding:8px 10px;background:#1976d2;color:#fff;
               text-decoration:none;border-radius:6px;border:1px solid #135ba1}
      .tt-link:hover{background:#135ba1}
      .tt-link.active{box-shadow: inset 0 0 0 2px #fff}
    `;
    document.head.appendChild(style);
  }

  // Normalize paths for comparison
  const norm = (p) => {
    if (!p) return '/';
    let s = p.replace(/\/index\.html?$/i, '/'); // .../index.html -> ...
    s = s.replace(/\/+$/g, '/');                // remove trailing slashes
    return s || '/';
  };

  const here = norm(location.pathname);

  // Build nav
  const nav = document.createElement('nav');
  nav.className = 'tt-nav';
  nav.setAttribute('role', 'navigation');
  nav.innerHTML = links.map(l => {
    const active = norm(l.href) === here ? ' active' : '';
    return `<a class="tt-link${active}" href="${l.href}">${l.icon} ${l.label}</a>`;
  }).join('');

  // Insert at top of body
  document.body.insertBefore(nav, document.body.firstChild);

  // Wire logout button globally if present on page
  document.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('logoutBtn');
    if (btn) btn.addEventListener('click', () => {
      if (window.TT && typeof TT.logout === 'function') TT.logout('/auth/role-select.html');
      else {
        try { localStorage.removeItem('auth_token'); localStorage.removeItem('TT_TOKEN'); localStorage.removeItem('tt_root_token'); localStorage.removeItem('tt_admin_token'); } catch {}
        location.href = '/auth/role-select.html';
      }
    });
  });
})();


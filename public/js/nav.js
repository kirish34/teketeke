// public/js/nav.js
(function () {
  // Avoid double injection
  if (document.querySelector('nav.tt-nav')) return;

  const links = [
    { href: '/',                      label: 'Home',           icon: '🏠' },
    { href: '/admin.html',            label: 'My Admin',       icon: '👑' },
    { href: '/sacco/sacco.html',      label: 'SACCO Admin',    icon: '🏢' },
    { href: '/sacco/staff.html',      label: 'SACCO Staff',    icon: '🧑‍💼' },
    { href: '/matatu/owner.html',     label: 'Matatu Owner',   icon: '🚌' },
    { href: '/matatu/conductor.html', label: 'Conductor',      icon: '🎫' },
    { href: '/auth/role-select.html', label: 'Logins',         icon: '🔐' },
    { href: '/auth/login.html',       label: 'Login',          icon: '🔐' },
    { href: '/auth/logout.html',      label: 'Logout',         icon: '🚪' }
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
})();

// public/js/nav.js
(() => {
  "use strict";

  // ---------- config ----------
  const LINKS = [
    { href: "/",                            label: "Home",           icon: "🏠" },
    { href: "/super/super-admin.html",      label: "Super Admin",    icon: "🛡️" },
    { href: "/sacco/admin-dashboard.html",  label: "SACCO Admin",    icon: "🏢" },
    { href: "/sacco/staff-dashboard.html",  label: "SACCO Staff",    icon: "🧑‍💼" },
    { href: "/matatu/owner-dashboard.html", label: "Matatu Owner",   icon: "🚌" },
    { href: "/super/manager-dashboard.html",label: "Branch Manager", icon: "🏬" },
    { href: "/cashier/dashboard.html",      label: "Cashier",        icon: "💳" },
    { href: "/auth/role-select.html",       label: "Logins",         icon: "🔐" }
  ];

  // ---------- guards ----------
  // avoid double-injection if script runs twice
  if (document.querySelector("nav.tt-nav")) return;

  // ---------- styles (once) ----------
  if (!document.getElementById("tt-nav-style")) {
    const style = document.createElement("style");
    style.id = "tt-nav-style";
    style.textContent = `
      .tt-nav{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:0 0 12px}
      .tt-link{display:inline-block;padding:8px 10px;background:#1976d2;color:#fff;
               text-decoration:none;border-radius:6px;border:1px solid #135ba1}
      .tt-link:hover{background:#135ba1}
      .tt-link.active{box-shadow: inset 0 0 0 2px #fff}
      @media (prefers-reduced-motion:no-preference){
        .tt-link{transition:background .15s ease}
      }
    `;
    document.head.appendChild(style);
  }

  // ---------- path helpers ----------
  const normalize = (p) => {
    // remove trailing "/index.html"
    p = p.replace(/\/index\.html$/i, "");
    // collapse double slashes (except protocol)
    p = p.replace(/([^:]\/)\/+/g, "$1");
    // keep root "/" but remove other trailing slashes
    if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
    return p || "/";
  };

  const here = normalize(location.pathname);

  // ---------- build nav ----------
  const nav = document.createElement("nav");
  nav.className = "tt-nav";
  nav.setAttribute("role", "navigation");
  nav.setAttribute("aria-label", "TekeTeke dashboards");

  nav.innerHTML = LINKS.map((l) => {
    const href = normalize(l.href);
    // active if exact match or current path starts with link (for subpages)
    const isActive = (here === href) || (href !== "/" && here.startsWith(href));
    const cls = "tt-link" + (isActive ? " active" : "");
    const label = `${l.icon} ${l.label}`;
    return `<a class="${cls}" href="${href}" aria-current="${isActive ? "page" : "false"}">${label}</a>`;
  }).join("");

  // insert at very top of body
  document.body.insertBefore(nav, document.body.firstChild);
})();

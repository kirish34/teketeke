// scripts/check-deadcode.js
// Fails CI if deprecated "cashier" code patterns reappear in backend/UI.
// Scans selected top-level paths with simple regexes, skipping common build dirs and test scripts.

const fs = require('fs');
const path = require('path');

const banned = [
  /\/api\/cashier/i,
  /\bcashier(_id|Id|Id")/i,
  /\bCASHIER\b/
];

const roots = [ 'server.js', 'routes', 'public', 'scripts' ];
const skipDirs = new Set(['node_modules', '.git', 'artifacts', 'dist', 'coverage']);

/** @type {string[]} */
const findings = [];

function shouldSkip(fullPath, name, stat) {
  if (stat.isDirectory()) {
    if (skipDirs.has(name)) return true;
  } else if (stat.isFile()) {
    // skip non-source files
    const okExt = /\.(js|html|json)$/i.test(name);
    if (!okExt) return true;
    // skip E2E test scripts
    if (fullPath.includes(path.sep + 'scripts' + path.sep)) {
      const base = path.basename(fullPath);
      if (/^test-.*\.js$/i.test(base)) return true;
    }
  }
  return false;
}

async function scanPath(entry) {
  const full = path.resolve(entry);
  let stat;
  try { stat = await fs.promises.stat(full); }
  catch { return; }

  if (stat.isDirectory()) {
    const items = await fs.promises.readdir(full);
    for (const name of items) {
      const child = path.join(full, name);
      let st;
      try { st = await fs.promises.stat(child); } catch { continue; }
      if (shouldSkip(child, name, st)) continue;
      if (st.isDirectory()) await scanPath(child);
      else if (st.isFile()) await scanFile(child);
    }
  } else if (stat.isFile()) {
    if (!shouldSkip(full, path.basename(full), stat)) {
      await scanFile(full);
    }
  }
}

async function scanFile(file) {
  let text;
  try { text = await fs.promises.readFile(file, 'utf8'); }
  catch { return; }
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const rx of banned) {
      if (rx.test(line)) {
        findings.push(`${file}:${i+1}:${line.trim()}`);
      }
    }
  }
}

async function scanForDuplicateRoutes() {
  // Only consider server.js and files under routes/
  const routeFiles = [];
  const pushIfFile = async (p) => {
    try { const st = await fs.promises.stat(p); if (st.isFile()) routeFiles.push(p); } catch {}
  };
  await pushIfFile(path.resolve('server.js'));
  try {
    const routesDir = path.resolve('routes');
    const st = await fs.promises.stat(routesDir);
    if (st.isDirectory()) {
      const items = await fs.promises.readdir(routesDir);
      for (const name of items) {
        const full = path.join(routesDir, name);
        try { const s = await fs.promises.stat(full); if (s.isFile() && /\.js$/i.test(name)) routeFiles.push(full); } catch {}
      }
    }
  } catch {}

  const routeRx = /(app|router)\.(get|post|put|delete)\([\'"`]([^\'"`]+)[\'"`]/i;
  /** @type {Record<string, Array<{file:string,line:number}>>} */
  const routesMap = Object.create(null);

  for (const file of routeFiles) {
    let text;
    try { text = await fs.promises.readFile(file, 'utf8'); } catch { continue; }
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(routeRx);
      if (!m) continue;
      const method = (m[2] || '').toUpperCase();
      let p = (m[3] || '').trim();
      // normalize path: collapse multiple slashes and remove trailing slash (except root)
      p = p.replace(/\/+/, '/');
      if (p.length > 1) p = p.replace(/\/$/, '');
      const key = `${method}:${p.toLowerCase()}`;
      if (!routesMap[key]) routesMap[key] = [];
      routesMap[key].push({ file, line: i + 1 });
    }
  }

  const dups = Object.entries(routesMap).filter(([, arr]) => (arr?.length || 0) > 1);
  if (dups.length) {
    console.error('❌ Duplicate route definitions detected:');
    for (const [key, entries] of dups) {
      const where = entries.map(e => `${e.file}:${e.line}`).join(' and ');
      console.error(`  ⚠️  ${key}  (${where})`);
    }
  }
  return dups.length;
}

(async () => {
  for (const root of roots) {
    await scanPath(root);
  }

  let hasError = false;
  if (findings.length) {
    console.error('❌ Found banned patterns:');
    for (const hit of findings) console.error('  ' + hit);
    hasError = true;
  }

  const dupCount = await scanForDuplicateRoutes();
  if (dupCount > 0) hasError = true;

  // --- auth guard verification ---
  async function scanForMissingGuards() {
    const files = [];
    const pushIfFile = async (p) => { try{ const st=await fs.promises.stat(p); if (st.isFile()) files.push(p); }catch{}};
    await pushIfFile(path.resolve('server.js'));
    try{
      const dir = path.resolve('routes');
      const st = await fs.promises.stat(dir);
      if (st.isDirectory()){
        const items = await fs.promises.readdir(dir);
        for (const name of items){
          const full = path.join(dir, name);
          try{ const s = await fs.promises.stat(full); if (s.isFile() && /\.js$/i.test(name)) files.push(full); }catch{}
        }
      }
    }catch{}

    const rx = /(app|router)\s*\.\s*(get|post|put|delete)\s*\(\s*['"`]([^'"`]+)['"`]\s*(?:,([^)]*))?\)/g;
    /** @type {Array<{method:string,path:string,file:string,line:number,missing:string}>} */
    const issues = [];

    for (const file of files){
      let text; try { text = await fs.promises.readFile(file,'utf8'); } catch { continue; }
      let m;
      while ((m = rx.exec(text))){
        const method = (m[2]||'').toUpperCase();
        let p = (m[3]||'').trim();
        const mw = (m[4]||'');
        const before = text.slice(0, m.index);
        const line = before.split(/\r?\n/).length; // 1-based

        // normalize
        p = p.replace(/\/+/, '/');
        if (p.length > 1) p = p.replace(/\/$/, '');
        const pl = p.toLowerCase();

        // whitelist
        if (pl === '/health' || pl === '/__health' || pl === '/config.json' || pl.startsWith('/api/public/')) continue;

        if (pl.startsWith('/api/admin/')){
          if (!/\brequireAdmin\b/.test(mw)) {
            issues.push({ method, path:p, file, line, missing:'requireAdmin' });
          }
        }
        if (pl.startsWith('/u/')){
          if (!/\brequireUser\b/.test(mw)) {
            issues.push({ method, path:p, file, line, missing:'requireUser' });
          }
          // specific membership guard for /u/sacco/:saccoId/*
          if (/^\/u\/sacco\/:saccoid(\/|$)/i.test(pl)) {
            if (!/\brequireSaccoMember\b/.test(mw)) {
              issues.push({ method, path:p, file, line, missing:'requireSaccoMember' });
            }
          }
        }
      }
    }

    if (issues.length){
      console.error('❌ Missing auth guards detected:');
      for (const it of issues){
        console.error(`  ⚠️  ${it.method} ${it.path}  (${it.file}:${it.line}) — ${it.missing} not found`);
      }
    }
    return issues.length;
  }

  const guardCount = await scanForMissingGuards();
  if (guardCount > 0) hasError = true;

  if (hasError) {
    process.exit(1);
  } else {
    console.log('✅ No banned patterns, duplicate routes, or missing auth guards found.');
  }
})();

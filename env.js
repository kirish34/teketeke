// Non-throwing env access so serverless never crashes at import.
const required = [
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE',
  'ADMIN_TOKEN',
];
const optional = [
  'SUPABASE_JWT_SECRET', 'APP_URL', 'API_URL', 'DOCS_CSP_EXTRA', 'COMMIT_SHA',
];

function getEnv() {
  const missing = required.filter(
    (k) => !process.env[k] || String(process.env[k]).trim() === ''
  );
  const values = {};
  [...required, ...optional].forEach((k) => {
    values[k] = process.env[k] || '';
  });
  return { ok: missing.length === 0, missing, values };
}

module.exports = { getEnv };


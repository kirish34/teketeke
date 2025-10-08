/* scripts/test-rules-flow.js */
const { api, step, ok, bad, warn, timestampId, artifacts, writeJUnit } = require('./test-utils');
const fs = require('fs');

(async () => {
  const ts = Date.now();
  const saccoName = timestampId('QA_SACCO_RULES');
  const plate = `KQ${(ts%100000).toString().padStart(5,'0')}`;
  const phone = '254711000000';
  const email = `qa-rules-${ts}@example.com`;
  const PREFIX = '*001*';

  let saccoId = null;
  let matatuId = null;

  try {
    // 1) Create SACCO
    await step('Create SACCO', async () => {
      const r = await api('/api/admin/register-sacco', {
        method: 'POST',
        body: { name: saccoName, contact_name: 'QA Rules', contact_phone: phone, contact_email: email, default_till: '999999' },
      });
      saccoId = r.data?.id || r.id;
      if (!saccoId) throw new Error('No sacco id returned');
    });

    // 2) Optional: Assign USSD to SACCO
    await step('Optional: Assign USSD to SACCO', async () => {
      const av = await api('/api/admin/ussd/pool/available');
      const items = av.items || av.data || [];
      if (!items.length) { warn('No available USSD codes – skipped SACCO USSD'); return; }
      const r = await api('/api/admin/ussd/pool/assign-next', {
        method: 'POST',
        body: { level: 'SACCO', sacco_id: saccoId, prefix: PREFIX },
      });
      if (!r.success) warn(`Assign-next SACCO failed: ${r.error || 'unknown error'}`);
      else if (r.ussd_code) artifacts.assignedCodes.push(r.ussd_code);
    });

    // 3) Optional: Create Matatu and assign USSD
    await step('Optional: Create Matatu', async () => {
      const r = await api('/api/admin/register-matatu', {
        method: 'POST',
        body: {
          sacco_id: saccoId,
          number_plate: plate,
          owner_name: 'Owner Rules',
          owner_phone: phone,
          vehicle_type: 'PSV 14-seater',
          tlb_number: 'TLB-RULES',
          till_number: '123456',
        },
      });
      matatuId = r.data?.id || r.id || null;
    });

    await step('Optional: Assign USSD to Matatu', async () => {
      if (!matatuId) { warn('Skipping MATATU USSD (no matatuId)'); return; }
      const av = await api('/api/admin/ussd/pool/available');
      const items = av.items || av.data || [];
      if (!items.length) { warn('No available USSD codes – skipped MATATU USSD'); return; }
      const r = await api('/api/admin/ussd/pool/assign-next', {
        method: 'POST',
        body: { level: 'MATATU', matatu_id: matatuId, prefix: PREFIX },
      });
      if (!r.success) warn(`Assign-next MATATU failed: ${r.error || 'unknown error'}`);
      else if (r.ussd_code) artifacts.assignedCodes.push(r.ussd_code);
    });

    // 4) Upsert rules
    const rulesPayload = {
      sacco_id: saccoId,
      fare_fee_flat_kes: 2.5,
      savings_percent: 5,
      sacco_daily_fee_kes: 50,
      loan_repay_percent: 0,
    };
    await step('Upsert Ruleset', async () => {
      const r = await api('/api/admin/rulesets', { method: 'POST', body: rulesPayload });
      if (!(r.success || r.ok)) throw new Error(r.error || 'rulesets upsert not successful');
    });

    // 5) Verify rules
    await step('Verify Ruleset values', async () => {
      const r = await api(`/api/admin/rulesets/${encodeURIComponent(saccoId)}`);
      const obj = r.data?.rules || r.rules || {};
      if (!obj || String(obj.sacco_id) !== String(saccoId)) throw new Error('Ruleset missing or sacco mismatch');
    });

    ok('Rules-only flow — PASSED');
  } catch (e) {
    bad(e.message || e);
    process.exitCode = 1;
  } finally {
    // 6) Cleanup
    try {
      if (matatuId) {
        await api(`/api/admin/delete-matatu/${encodeURIComponent(matatuId)}`, { method: 'DELETE' });
      }
    } catch {}
    try {
      if (saccoId) {
        await api(`/api/admin/delete-sacco/${encodeURIComponent(saccoId)}`, { method: 'DELETE' });
      }
    } catch {}
    try {
      await step('Write test artifacts (rules flow)', async () => {
        fs.mkdirSync('artifacts', { recursive: true });
        fs.writeFileSync('artifacts/rules-flow.json', JSON.stringify(artifacts, null, 2));
        ok(`Artifacts written to artifacts/rules-flow.json`);
        ok(`Assigned codes this run: ${artifacts.assignedCodes.join(', ') || '(none)'}`);
      });
    } catch (e) { bad(`Artifacts write failed: ${e.message}`); }
    try {
      const { failures } = writeJUnit('rules-flow', 'artifacts/junit-rules.xml');
      ok(`JUnit saved (rules-flow), failures: ${failures}`);
    } catch (e) { bad(`JUnit write failed: ${e.message}`); }
  }
})();

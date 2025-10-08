/* scripts/test-admin-flow.js */
const { api, step, log, ok, bad, warn, timestampId, artifacts, writeJUnit } = require('./test-utils');
const fs = require('fs');

(async () => {
  const saccoName = timestampId('QA_SACCO');
  const plate = `KQ${(Date.now()%100000).toString().padStart(5,'0')}`;
  const phone = '254700000000';
  const email = `qa${Date.now()}@example.com`;

  let saccoId = null;
  let matatuId = null;
  let assignedCode = null;

  try {
    await step('Create SACCO', async () => {
      const r = await api('/api/admin/register-sacco', {
        method: 'POST',
        body: {
          name: saccoName,
          contact_name: 'QA Bot',
          contact_phone: phone,
          contact_email: email,
          default_till: '999999',
        },
      });
      saccoId = (r.data && r.data.id) || r.id;
      if (!saccoId) throw new Error('No sacco id returned');
    });

    await step('Verify SACCO listing', async () => {
      const r = await api(`/api/admin/saccos?q=${encodeURIComponent(saccoName)}`);
      const items = r.items || r.data || [];
      const hit = items.find(x => String(x.name) === saccoName);
      if (!hit) throw new Error('Created SACCO not found in list');
    });

    await step('Create Matatu', async () => {
      const r = await api('/api/admin/register-matatu', {
        method: 'POST',
        body: {
          sacco_id: saccoId,
          number_plate: plate,
          owner_name: 'Owner QA',
          owner_phone: phone,
          vehicle_type: 'PSV 14-seater',
          tlb_number: 'TLB-QA',
          till_number: '123456',
        },
      });
      matatuId = (r.data && r.data.id) || r.id;
      if (!matatuId) throw new Error('No matatu id returned');
    });

    await step('Verify Matatu listing', async () => {
      const r = await api(`/api/admin/matatus?sacco_id=${encodeURIComponent(saccoId)}`);
      const items = r.items || r.data || [];
      const hit = items.find(x => String(x.number_plate).toUpperCase() === plate.toUpperCase());
      if (!hit) throw new Error('Created Matatu not found in list');
    });

    await step('Lookup Matatu by plate', async () => {
      const r = await api(`/api/lookup/matatu?plate=${encodeURIComponent(plate)}`);
      if (!r.id || String(r.id) !== String(matatuId)) {
        throw new Error(`Lookup mismatch: expected ${matatuId}, got ${r.id}`);
      }
    });

    await step('Assign NEXT USSD to Matatu', async () => {
      const av = await api('/api/admin/ussd/pool/available');
      const items = av.items || av.data || [];
      if (!items.length) { warn('No available USSD codes – skipped MATATU assign-next'); return; }
      const r = await api('/api/admin/ussd/pool/assign-next', {
        method: 'POST',
        body: { level: 'MATATU', matatu_id: matatuId, prefix: '*001*' }
      });
      if (!r.success) throw new Error(r.error || 'assign-next failed');
      assignedCode = r.ussd_code;
      if (!assignedCode) throw new Error('No ussd_code returned');
      artifacts.assignedCodes.push(assignedCode);
    });

    await step('Verify USSD allocated list', async () => {
      const r = await api('/api/admin/ussd/pool/allocated?prefix=*001*');
      const items = r.items || r.data || [];
      const found = items.find(x => x.full_code === assignedCode);
      if (!found) throw new Error(`Allocated list does not contain ${assignedCode}`);
    });

    await step('Optional: Bind manual USSD (skip if none)', async () => {
      const av = await api('/api/admin/ussd/pool/available');
      const items = av.items || av.data || [];
      if (!items.length) { warn('No available USSD codes – skipped binding step'); return; }
      const pick = items[0];
      const manual = `*001*${pick.base}${pick.checksum}#`;
      const r = await api('/api/admin/ussd/bind-from-pool', {
        method: 'POST',
        body: { level: 'MATATU', matatu_id: matatuId, ussd_code: manual }
      });
      if (!r.success) ok('Manual bind likely rejected (already allocated from step 6) – acceptable');
      else { ok(`Manual bound ${manual}`); artifacts.assignedCodes.push(r.ussd_code || manual); }
    });

    ok('E2E admin flow — PASSED');
  } catch (e) {
    bad(e.message || e);
    process.exitCode = 1;
  } finally {
    try {
      if (matatuId) {
        await api(`/api/admin/delete-matatu/${encodeURIComponent(matatuId)}`, { method: 'DELETE' });
        ok(`Cleanup: deleted matatu ${matatuId}`);
      }
    } catch (e) { bad(`Cleanup matatu failed: ${e.message}`); }
    try {
      if (saccoId) {
        await api(`/api/admin/delete-sacco/${encodeURIComponent(saccoId)}`, { method: 'DELETE' });
        ok(`Cleanup: deleted sacco ${saccoId}`);
      }
    } catch (e) { bad(`Cleanup sacco failed: ${e.message}`); }
    try {
      await step('Write test artifacts (admin flow)', async () => {
        fs.mkdirSync('artifacts', { recursive: true });
        fs.writeFileSync('artifacts/admin-flow.json', JSON.stringify(artifacts, null, 2));
        ok(`Artifacts written to artifacts/admin-flow.json`);
        ok(`Assigned codes this run: ${artifacts.assignedCodes.join(', ') || '(none)'}`);
      });
    } catch (e) { bad(`Artifacts write failed: ${e.message}`); }
    try {
      const { failures } = writeJUnit('admin-flow', 'artifacts/junit-admin.xml');
      ok(`JUnit saved (admin-flow), failures: ${failures}`);
    } catch (e) { bad(`JUnit write failed: ${e.message}`); }
  }
})();

// Floating control panel for any dashboard
(() => {
  if (window.__TT_PANEL__) return;
  window.__TT_PANEL__ = true;

  const el = document.createElement("div");
  el.style.cssText = `
    position:fixed; right:12px; bottom:12px; z-index:999999;
    background:#111; color:#fafafa; font:12px/1.3 system-ui,-apple-system,Segoe UI,Roboto,Arial;
    border-radius:12px; padding:10px 12px; width:310px; box-shadow:0 8px 24px rgba(0,0,0,.35);
  `;
  el.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
      <strong style="font-size:13px;">TekeTeke Panel</strong>
      <span style="opacity:.7">v1</span>
      <button id="tt_close" style="margin-left:auto;background:#333;color:#eee;border:none;padding:2px 6px;border-radius:6px;cursor:pointer">×</button>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">
      <input id="tt_admin" placeholder="x-admin-token" style="grid-column:1/3;padding:6px;border-radius:8px;border:1px solid #333;background:#1a1a1a;color:#eee">
      <input id="tt_sacco" placeholder="sacco_id"  style="padding:6px;border-radius:8px;border:1px solid #333;background:#1a1a1a;color:#eee">
      <input id="tt_matatu" placeholder="matatu_id" style="padding:6px;border-radius:8px;border:1px solid #333;background:#1a1a1a;color:#eee">
      <input id="tt_till" placeholder="till e.g. 987654" style="grid-column:1/3;padding:6px;border-radius:8px;border:1px solid #333;background:#1a1a1a;color:#eee">
      <input id="tt_cashier" placeholder="cashier_id" style="grid-column:1/3;padding:6px;border-radius:8px;border:1px solid #333;background:#1a1a1a;color:#eee">
      <button id="tt_save" style="grid-column:1/3;padding:6px;border-radius:8px;border:1px solid #444;background:#2a2a2a;color:#fff;cursor:pointer">Save IDs</button>
    </div>
    <hr style="border:0;border-top:1px solid #333;margin:10px 0">
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">
      <input id="tt_amount" type="number" step="0.01" placeholder="amount (KES)" style="padding:6px;border-radius:8px;border:1px solid #333;background:#1a1a1a;color:#eee">
      <input id="tt_msisdn" placeholder="msisdn 2547..." style="padding:6px;border-radius:8px;border:1px solid #333;background:#1a1a1a;color:#eee">
      <button id="tt_pay" style="grid-column:1/3;padding:6px;border-radius:8px;border:1px solid #444;background:#0a5;color:#fff;cursor:pointer">Initiate Payment</button>
      <button id="tt_quote" style="grid-column:1/3;padding:6px;border-radius:8px;border:1px solid #444;background:#294;color:#fff;cursor:pointer">Quote Splits</button>
    </div>
    <hr style="border:0;border-top:1px solid #333;margin:10px 0">
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">
      <button id="tt_payments" style="padding:6px;border-radius:8px;border:1px solid #444;background:#223;color:#fff;cursor:pointer">Load Till Payments</button>
      <button id="tt_sett" style="padding:6px;border-radius:8px;border:1px solid #444;background:#232;color:#fff;cursor:pointer">Load Settlements</button>
    </div>
    <div id="tt_out" style="margin-top:8px;max-height:240px;overflow:auto;background:#0d0d0d;border:1px solid #222;border-radius:8px;padding:8px;white-space:pre-wrap;"></div>
  `;
  document.body.appendChild(el);

  const $ = (id)=>el.querySelector(id);
  const out = $("#tt_out");
  const log = (v)=>{ try{ out.textContent = typeof v==="string"?v:JSON.stringify(v,null,2);}catch(e){ out.textContent=String(v);} };

  const setInputs = () => {
    $("#tt_admin").value = TT.state.adminToken||"";
    $("#tt_sacco").value = TT.state.saccoId||"";
    $("#tt_matatu").value = TT.state.matatuId||"";
    $("#tt_till").value = TT.state.till||"";
    $("#tt_cashier").value = TT.state.cashierId||"";
  };
  setInputs();

  $("#tt_close").onclick = ()=> el.remove();
  $("#tt_save").onclick = ()=>{
    TT.state.adminToken = $("#tt_admin").value.trim();
    TT.state.saccoId    = $("#tt_sacco").value.trim();
    TT.state.matatuId   = $("#tt_matatu").value.trim();
    TT.state.till       = $("#tt_till").value.trim();
    TT.state.cashierId  = $("#tt_cashier").value.trim();
    log({ saved: true, admin: TT.state.adminToken, sacco: TT.state.saccoId, matatu: TT.state.matatuId, till: TT.state.till, cashier: TT.state.cashierId });
  };

  $("#tt_quote").onclick = async ()=>{
    try {
      const r = await TT.feeQuote({ sacco_id: TT.state.saccoId, matatu_id: TT.state.matatuId, amount: Number($("#tt_amount").value) });
      log(r);
    } catch(e){ log(e.message); }
  };

  $("#tt_pay").onclick = async ()=>{
    try {
      log("Sending STK…");
      const r = await TT.initiate({
        amount: Number($("#tt_amount").value),
        msisdn: $("#tt_msisdn").value.trim(),
        sacco_id: TT.state.saccoId,
        matatu_id: TT.state.matatuId,
        cashier_id: TT.state.cashierId
      });
      log(r);
      const id = r.checkout_id;
      let done=false;
      while(!done){
        const st = await TT.status(id);
        log(st);
        done = st.final;
        if(!done) await new Promise(r=>setTimeout(r,1500));
      }
    } catch(e){ log(e.message); }
  };

  $("#tt_payments").onclick = async ()=>{
    try {
      const till = TT.state.till;
      if(!till) return log("Set till first.");
      const list = await TT.paymentsByTill(till);
      log(list);
      const rows = document.getElementById("rows");
      if (rows && Array.isArray(list)) {
        rows.innerHTML = list.map(x => `
          <tr>
            <td>${x.phone||""}</td>
            <td>${Number(x.amount).toFixed(2)}</td>
            <td>${Number(x.deducted||0).toFixed(2)}</td>
            <td>${new Date(x.timestamp).toLocaleTimeString()}</td>
          </tr>`).join("");
      }
    } catch(e){ log(e.message); }
  };

  $("#tt_sett").onclick = async ()=>{
    try {
      if(!TT.state.saccoId) return log("Set sacco_id first.");
      log(await TT.settlements(TT.state.saccoId));
    } catch(e){ log(e.message); }
  };
})();

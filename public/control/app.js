/* DisasterShield AI – Control Room dashboard (vanilla JS, no build step) */
const API = "/api/v1";
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const TOKEN_KEY = "shield_token";
const getTok = () => { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } };
const setTok = (v) => { try { v ? localStorage.setItem(TOKEN_KEY, v) : localStorage.removeItem(TOKEN_KEY); } catch {} };
const j = async (url, opt = {}) => {
  const tk = getTok();
  const r = await fetch(url, { ...opt, headers: { ...(opt.headers || {}), ...(tk ? { Authorization: "Bearer " + tk } : {}) } });
  if (r.status === 401 && tk && !url.includes("/auth/login")) { setTok(null); showLogin("Session expired - please sign in again."); }
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
  return r.json();
};
let authRequired = false, started = false;
function showLogin() { location.replace("/?role=control"); }   // sign-in (password + security key) lives on the access portal
async function boot() {
  try { authRequired = (await j(`${API}/config`)).auth_required; } catch (e) { return toast("API unreachable: " + e.message); }
  if (authRequired) {
    let me = null; if (getTok()) { try { me = await j(`${API}/auth/me`); } catch {} }
    if (!me || me.role !== "CONTROL_ROOM") return showLogin();
    const b = $("#signOut"); b.textContent = `Sign out (${me.name})`; b.classList.remove("hidden");
    b.onclick = () => { setTok(null); location.href = "/?out=1"; };
  }
  $("#loginWall").classList.add("hidden");
  if (started) return; started = true;
  loadAll().then(connect).catch((e) => toast("API unreachable: " + e.message));
}
$("#loginForm").onsubmit = async (e) => {
  e.preventDefault(); $("#lgErr").textContent = "";
  try {
    const r = await j(`${API}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: $("#lgUser").value, password: $("#lgPass").value }) });
    if (r.role !== "CONTROL_ROOM") return $("#lgErr").textContent = "This account is for rescue officers. Use the mobile app (/mobile/).";
    setTok(r.token); $("#lgPass").value = ""; boot();
  } catch (err) { $("#lgErr").textContent = err.message; }
};
Notifier.mount($("#ntfSlot"));
function notifySos(d) {
  const who = `${d.citizen_name}${d.phone ? " (" + d.phone + ")" : ""}`;
  if (d.event === "new_request")
    Notifier.push({ level: "new", title: `New request ${d.id}: ${d.request_type || "Help"}`,
      body: `${who}, ${d.address || "Sector " + d.sector}. Assigned to ${d.assigned_officer || "no one yet"}. Priority ${d.severity}.`,
      speak: `New ${d.request_type || "help"} request from ${d.citizen_name}. Priority ${d.severity}. Assigned to ${(d.assigned_officer || "no one").replace("-", " ")}.` });
  else if (d.event === "dispatched")
    Notifier.push({ level: "update", title: `${d.id} dispatched`, body: `${d.assigned_unit_id} sent with a safe route to ${d.citizen_name}.`,
      speak: `Request ${d.id} dispatched to ${(d.assigned_unit_id || "").replace("-", " ")}.` });
  else
    Notifier.push({ level: d.status === "RESOLVED" ? "update" : "warn", title: `${d.id}: ${d.field_status || d.status_label}`,
      body: `${d.assigned_unit_id || d.assigned_officer || "Officer"} updated the request from ${d.citizen_name}.${d.note ? " Note: " + d.note : ""}`,
      speak: `Request ${d.id} is now ${d.field_status || d.status_label}, by ${(d.assigned_unit_id || d.assigned_officer || "the officer").replace("-", " ")}.` });
}
const toast = (m) => { const t = $("#toast"); t.textContent = m; t.classList.remove("hidden"); clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.add("hidden"), 3500); };

/* ---------- header: clock + tabs ---------- */
setInterval(() => { $("#clock").textContent = new Date().toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata" }) + " IST"; }, 1000);
document.querySelectorAll("#tabs .pill").forEach((b) => b.onclick = () => {
  document.querySelectorAll("#tabs .pill").forEach((x) => x.classList.toggle("on", x === b));
  const t = b.dataset.tab;
  ["control", "responder", "citizen"].forEach((v) => $("#view-" + v).classList.toggle("hidden", v !== t));
  if (t !== "control") { const f = $("#ifr-" + t); if (!f.src) f.src = `/mobile/?mode=${t}&embed=1`; }
  else setTimeout(() => map.invalidateSize(), 50);
});

/* ---------- map ---------- */
const map = L.map("map", { zoomControl: true }).setView([13.0067, 80.2571], 14);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 18, attribution: "© OpenStreetMap" }).addTo(map);
const LG = { heat: L.layerGroup().addTo(map), grid: L.layerGroup().addTo(map), river: L.layerGroup().addTo(map), shelters: L.layerGroup().addTo(map),
  roads: L.layerGroup().addTo(map), corridors: L.layerGroup().addTo(map), sos: L.layerGroup().addTo(map), units: L.layerGroup().addTo(map) };
const riskColor = (s) => s >= 80 ? "#EF4444" : s >= 60 ? "#F59E0B" : s >= 40 ? "#EAB308" : "#10B981";
const sevColor = (s) => s === "CRITICAL" ? "#EF4444" : "#F59E0B";
let layers = null, queue = [], unitMarkers = {};
const coordStr = (lat, lon) => `EPSG:4326 • ${Math.abs(lat).toFixed(4)}° ${lat >= 0 ? "N" : "S"}, ${Math.abs(lon).toFixed(4)}° ${lon >= 0 ? "E" : "W"}`;

function inspect(title, html, lat, lon) {
  $("#insp-title").innerHTML = title; $("#insp-body").innerHTML = html; $("#insp-crs").textContent = coordStr(lat, lon);
  $("#inspect").classList.remove("hidden");
}
$("#insp-x").onclick = () => $("#inspect").classList.add("hidden");

function drawLayers(g) {
  layers = g;
  Object.values(LG).forEach((l) => l.clearLayers());
  g.flood_heatmap.features.forEach((f) => {
    const p = f.properties, ring = f.geometry.coordinates[0].map(([x, y]) => [y, x]);
    const col = riskColor(p.risk_score);
    const poly = L.polygon(ring, { color: "#475569", weight: 1, dashArray: "4 4", fillColor: col, fillOpacity: 0.3 });
    poly.on("click", (e) => {
      const cor = g.safe_corridors.features.filter((c) => c.properties.sector === p.sector);
      const txt = `${p.active_sos} active citizen SOS beacon${p.active_sos === 1 ? "" : "s"} detected. AI sector risk <b>${p.risk_score}/100 (${p.severity})</b>.` +
        (cor.length ? ` Green corridor to ${esc(cor[0].properties.shelter)} (${cor[0].properties.metres} m) verified safe.` : " No SOS in sector.");
      inspect(esc(p.name), txt, e.latlng.lat, e.latlng.lng);
    });
    poly.addTo(LG.heat);
    const [[s, w], , [n, e]] = [ring[0], ring[1], ring[2]];
    L.polygon(ring, { color: "#64748B", weight: 1, fill: false, interactive: false }).addTo(LG.grid);
    L.marker([(s + n) / 2, (w + e) / 2], { interactive: false, icon: L.divIcon({ className: "", html: `<div class="sector-lbl">${esc(p.name)}</div>`, iconSize: [120, 14], iconAnchor: [60, 7] }) }).addTo(LG.grid);
  });
  L.polyline(g.river.geometry.coordinates.map(([x, y]) => [y, x]), { color: "#38BDF8", weight: 5, opacity: 0.8 }).bindTooltip("Adyar River").addTo(LG.river);

  g.roads.features.forEach((f) => {
    const p = f.properties, ll = f.geometry.coordinates.map(([x, y]) => [y, x]);
    const bad = p.status !== "SAFE", col = p.status === "BLOCKED" ? "#EF4444" : p.status === "SUBMERGED" ? "#F59E0B" : "#64748B";
    const line = L.polyline(ll, { color: col, weight: bad ? 5 : 3, dashArray: bad ? "6 6" : null, opacity: 0.9 }).addTo(LG.roads);
    const click = (e) => inspect(esc(p.name), `Status <b style="color:${col}">${p.status}</b> • depth ${p.water_depth_m} m.` + (bad ? " Excluded from safe routing." : " Open for routing."), e.latlng.lat, e.latlng.lng);
    line.on("click", click);
    if (bad) {
      const mid = [(ll[0][0] + ll[1][0]) / 2, (ll[0][1] + ll[1][1]) / 2];
      L.marker(mid, { icon: L.divIcon({ className: "", html: `<div class="mk" style="background:${col}">${p.status === "BLOCKED" ? "✕" : "!"}</div>`, iconSize: [24, 24], iconAnchor: [12, 12] }) }).on("click", click).addTo(LG.roads);
    }
  });
  g.safe_corridors.features.forEach((f) => {
    L.polyline(f.geometry.coordinates.map(([x, y]) => [y, x]), { color: "#10B981", weight: 6, opacity: 0.75 })
      .bindTooltip(`Verified safe route ${f.properties.sos} → ${f.properties.shelter}`).addTo(LG.corridors);
  });
  g.shelters.features.forEach((f) => {
    const p = f.properties, [x, y] = f.geometry.coordinates;
    L.marker([y, x], { icon: L.divIcon({ className: "", iconSize: [24, 24], iconAnchor: [12, 12], html: `<div class="mk" style="background:#10B981">H</div><div class="lbl" style="position:absolute;left:28px;top:2px">Shelter #${p.id} (${p.pct_free}% Free)</div>` }) })
      .on("click", () => inspect(esc(p.name), `<b>${p.free_beds}</b> of ${p.total_beds} beds free (${p.pct_free}%). Status: ${p.status}.`, y, x)).addTo(LG.shelters);
  });
  g.sos.features.forEach((f) => {
    const p = f.properties, [x, y] = f.geometry.coordinates, c = sevColor(p.severity);
    L.marker([y, x], { zIndexOffset: 1000, icon: L.divIcon({ className: "", iconSize: [30, 30], iconAnchor: [15, 15], html: `<div class="beacon" style="background:${c};color:${c}"><span style="color:#fff">${esc(p.num)}</span></div>` }) })
      .on("click", () => {
        const q = queue.find((s) => s.id === p.id);
        inspect(`${esc(p.id)} • <span style="color:${c}">${p.severity}</span>`, `${q ? esc(q.request_type) + " &bull; " : ""}${esc(p.citizen_name)}${q && q.phone ? " (" + esc(q.phone) + ")" : ""} in Sector ${p.sector}${q && q.address ? ", " + esc(q.address) : ""}. Depth ${p.water_depth_m} m. Status: ${esc(p.status)}.${q ? " Tags: " + esc(q.vulnerability_tags.join(", ") || "none") : ""}`, y, x);
      }).addTo(LG.sos);
  });
  g.units.forEach(updateUnit);
}
function updateUnit(u) {
  if (unitMarkers[u.id]) unitMarkers[u.id].setLatLng([u.lat, u.lon]);
  else unitMarkers[u.id] = L.marker([u.lat, u.lon], { icon: L.divIcon({ className: "", iconSize: [20, 20], iconAnchor: [10, 10], html: `<div class="mk" style="background:#3B82F6;width:20px;height:20px;font-size:10px">▲</div>` }) }).bindTooltip(u.id).addTo(LG.units);
  if (!LG.units.hasLayer(unitMarkers[u.id])) unitMarkers[u.id].addTo(LG.units);
}
document.querySelectorAll("[data-layer]").forEach((b) => b.onclick = () => {
  b.classList.toggle("on");
  const on = b.classList.contains("on"), k = b.dataset.layer;
  const targets = k === "roads" ? [LG.roads, LG.corridors] : [LG[k]];
  targets.forEach((l) => on ? map.addLayer(l) : map.removeLayer(l));
});

/* ---------- KPIs ---------- */
function renderTelemetry(t) {
  lastTelemetry = t; if (liveMode) return;   // a searched place is on screen: keep its live KPIs
  $("#k-rain").textContent = t.imd.rainfall_mm_hr;
  const d = t.imd.pct_over_1hr; $("#k-rain-d").innerHTML = `<span class="${d >= 0 ? "text-red-400" : "text-emerald-400"}">${d >= 0 ? "▲" : "▼"} ${Math.abs(d)}%</span> vs 1-hr threshold`;
  $("#k-river").textContent = t.cwc.river_level_m.toFixed(2); $("#k-danger").textContent = t.cwc.danger_level_m.toFixed(2);
  $("#k-rise").innerHTML = `<span class="text-amber-400">+${t.cwc.rate_of_rise.toFixed(2)} m/hr</span> rate of rise • ${(t.cwc.danger_level_m - t.cwc.river_level_m).toFixed(2)} m to danger mark`;
  $("#k-risk").textContent = t.ai.risk_score;
  const sv = $("#k-sev"); sv.textContent = t.ai.severity; sv.className = "badge align-middle " + (t.ai.severity === "CRITICAL" ? "b-red" : t.ai.severity === "HIGH" ? "b-amb" : "b-grn");
  $("#k-conf").textContent = `${t.ai.model === "xgboost" ? "XGBoost" : "Model"} confidence ${(t.ai.confidence * 100).toFixed(1)}%`;
  $("#k-sos").textContent = t.sos.open; $("#k-sh").textContent = t.shelters.ready; $("#k-beds").textContent = `${t.shelters.free_beds} / ${t.shelters.total_beds}`;
}

/* ---------- CAP ---------- */
let alertDraft = null, curLang = "en", edits = {};
function renderCap() {
  const a = alertDraft, btn = $("#approveBtn"), tr = $("#capTrigger");
  if (!a || a.status !== "PENDING_APPROVAL") {
    const done = a && a.status === "BROADCASTED";
    tr.className = "text-xs rounded-lg p-3 " + (done ? "b-grn" : "b-blu");
    tr.textContent = done ? `✔ ${a.cap_identifier} broadcast by ${a.approved_by} (${a.language.toUpperCase()} primary). Citizen app synced.` : "No alert recommended. Risk below CRITICAL threshold. Use Surge Test to simulate.";
    btn.disabled = true; $("#capText").value = ""; $("#capId").textContent = a ? a.cap_identifier : "–";
    $("#sysPill").className = "badge text-[11px] " + (done ? "b-grn" : "b-blu"); $("#sysPill").textContent = done ? "Alert Broadcast • Human Approved" : "Monitoring • No Pending Alert";
    return;
  }
  tr.className = "text-xs rounded-lg p-3 b-amb leading-relaxed"; tr.innerHTML = "<b>AI trigger:</b> " + esc(a.trigger_summary);
  $("#capText").value = edits[curLang] ?? a.messages[curLang]; $("#capId").textContent = a.cap_identifier; btn.disabled = false;
  $("#sysPill").className = "badge b-amb text-[11px]"; $("#sysPill").textContent = "Advisory Mode: Awaiting Human Sign-Off";
}
document.querySelectorAll("#langTabs .pill").forEach((b) => b.onclick = () => {
  if (alertDraft && alertDraft.status === "PENDING_APPROVAL") edits[curLang] = $("#capText").value;
  curLang = b.dataset.lang; document.querySelectorAll("#langTabs .pill").forEach((x) => x.classList.toggle("on", x === b)); renderCap();
});
$("#capText").oninput = () => { edits[curLang] = $("#capText").value; };
$("#surgeBtn").onclick = async () => {
  try {
    const r = await j(`${API}/ai/evaluate-risk`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ surge: true }) });
    edits = {}; if (r.alert) alertDraft = r.alert; renderTelemetry(r.telemetry); renderCap(); refreshAudit(); toast("Surge test: rainfall +12 mm/hr, AI re-evaluated");
  } catch (e) { toast(e.message); }
};
$("#approveBtn").onclick = async () => {
  if (!confirm("Duty Officer sign-off: broadcast this CAP v1.2 geo-alert to all of Ward 14 via Push, SMS and IVR?")) return;
  try {
    const a = await j(`${API}/alerts/${encodeURIComponent(alertDraft.id)}/approve`, { method: "POST",
      headers: { "Content-Type": "application/json", "X-Role": "DUTY_OFFICER" },
      body: JSON.stringify({ approved_by: "District Duty Officer", language: curLang, message_body: edits[curLang] || null }) });
    alertDraft = a; edits = {}; renderCap();
    $("#capResult").innerHTML = `Broadcast OK. <a class="text-sky-400 underline" target="_blank" href="${API}/alerts/${encodeURIComponent(a.id)}/cap.xml?lang=${curLang}">View CAP v1.2 XML</a>`;
    refreshAudit(); toast("Geo-alert broadcast — citizen apps synced");
  } catch (e) { toast("Approval failed: " + e.message); }
};

/* ---------- triage queue ---------- */
const sevCls = (s) => s === "CRITICAL" ? "b-red" : s === "HIGH" ? "b-amb" : "b-blu";
function renderQueue() {
  $("#queue").innerHTML = queue.map((s) => {
    const open = s.status === "OPEN";
    return `<div class="card p-3 border-l-4" style="border-left-color:${sevColor(s.severity)}">
      <div class="flex items-center justify-between"><div class="font-bold">${esc(s.id)} <span class="badge ${sevCls(s.severity)} ml-1">${s.severity}</span></div>
        <div class="text-[11px] text-slate-400">${new Date(s.created_at).toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" })} IST • score ${s.priority_score}</div></div>
      <div class="text-sm mt-1"><b>${esc(s.request_type || "Flood Rescue")}</b> ${s.synced_offline ? '<span class="badge b-blu">OFFLINE SYNC</span>' : ""}</div>
      <div class="req-box">
        <div><b>Name:</b> ${esc(s.citizen_name)} &bull; ${s.household_size} people</div>
        <div><b>Phone:</b> ${s.phone ? `<a class="text-sky-600 underline" href="tel:${esc(s.phone)}">${esc(s.phone)}</a>` : "-"}</div>
        <div><b>Address:</b> ${esc(s.address || "-")} <span class="text-slate-500">(${s.lat.toFixed(4)}, ${s.lon.toFixed(4)}${s.location_source === "GPS" ? " &bull; live GPS" : ""})</span></div>
        <div><b>Details:</b> ${esc(s.description || "-")}</div>
        <div><b>Assigned to:</b> ${s.assigned_officer ? `<span class="badge b-blu">${esc(s.assigned_officer)}</span>` : '<span class="text-slate-500">not assigned</span>'}</div>
        ${(s.officer_notes || []).slice(-2).map((n) => `<div class="text-emerald-700"><b>Officer note:</b> ${esc(n.text)}</div>`).join("")}
      </div>
      <div class="text-xs text-slate-300 mt-1">Sector ${s.sector} &bull; <b>Depth: ${s.water_depth_m}m</b></div>
      <div class="flex flex-wrap gap-1 mt-2">${s.vulnerability_tags.map((t) => `<span class="badge b-amb">${esc(t)}</span>`).join("") || '<span class="text-[11px] text-slate-500">no vulnerability flags</span>'}</div>
      <div class="flex items-center justify-between mt-3"><span class="text-xs ${open ? "text-red-300" : "text-emerald-300"}">${esc(s.status_label)}</span>
        <div class="flex gap-2">${open ? `<button class="pill on" data-dispatch="${esc(s.id)}">${s.assigned_officer ? "Dispatch with safe route" : "Dispatch Nearest Responder"}</button>` : ""}<button class="pill" data-locate="${esc(s.id)}">Locate on Map</button></div></div></div>`;
  }).join("") || '<div class="text-slate-400 text-sm">No active SOS.</div>';
  document.querySelectorAll("[data-dispatch]").forEach((b) => b.onclick = async () => {
    b.disabled = true;
    try { const r = await j(`${API}/sos/${b.dataset.dispatch}/dispatch`, { method: "POST", headers: { "X-Role": "District Duty Officer" } });
      toast(`${r.id}: ${r.assigned_unit_id} dispatched (${r.route.metres} m safe route)`); await loadAll(); }
    catch (e) { toast(e.message); b.disabled = false; }
  });
  document.querySelectorAll("[data-locate]").forEach((b) => b.onclick = () => {
    const s = queue.find((x) => x.id === b.dataset.locate); map.flyTo([s.lat, s.lon], 16);
    inspect(`${esc(s.id)} • ${s.severity}`, `${esc(s.citizen_name)}, Sector ${s.sector}, depth ${s.water_depth_m} m. ${esc(s.status_label)}.`, s.lat, s.lon);
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
}

/* ---------- audit ---------- */
async function refreshAudit() {
  const rows = await j(`${API}/audit?q=${encodeURIComponent($("#auditQ").value)}&vtype=${encodeURIComponent($("#auditT").value)}`);
  const cls = { "AI INFERENCE": "b-blu", VERIFIED: "b-grn", "HUMAN APPROVED": "b-amb" };
  $("#auditBody").innerHTML = rows.map((r) => `<tr class="border-t border-slate-700 align-top"><td class="py-2 pr-3 font-mono whitespace-nowrap text-slate-400">${new Date(r.timestamp).toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata" })}</td>
    <td class="pr-3 font-semibold whitespace-nowrap">${esc(r.actor_module)}</td><td class="pr-3 text-slate-300">${esc(r.action_rationale)}</td><td><span class="badge ${cls[r.verification_type]}">${r.verification_type}</span></td></tr>`).join("");
  $("#auditHash").textContent = rows.length ? rows[0].metadata_hash.slice(0, 24) + "…" : "";
}
let ah; const lazyAudit = () => { clearTimeout(ah); ah = setTimeout(refreshAudit, 300); };
$("#auditQ").oninput = lazyAudit; $("#auditT").onchange = refreshAudit;

/* ---------- load + live ---------- */
async function loadAll() {
  const [t, g, q, alerts] = await Promise.all([j(`${API}/dashboard/telemetry`), j(`${API}/gis/layers`), j(`${API}/dashboard/queue`), j(`${API}/alerts`)]);
  queue = q; renderTelemetry(t); drawLayers(g); renderQueue();
  alertDraft = alerts.find((a) => a.status === "PENDING_APPROVAL") || alerts[alerts.length - 1] || null; renderCap(); refreshAudit();
}
let refreshT; const lazyAll = () => { clearTimeout(refreshT); refreshT = setTimeout(loadAll, 400); };
/* live updates: the server keeps an event log; we poll it (works on serverless hosting where WebSockets are not available) */
let cursor = -1, seen = new Set(), pollTimer = null, polling = false, lastTick = 0;
const dot = (ok) => $("#wsDot").className = "inline-block w-2 h-2 rounded-full " + (ok ? "bg-emerald-400" : "bg-red-500");
function handleEvent({ type, data }) {
  if (type === "telemetry" || type === "hello") renderTelemetry(data);
  else if (type === "unit") updateUnit(data);
  else if (type === "sos") { notifySos(data); lazyAll(); }
  else if (type === "road") { toast(`Road hazard: ${data.name} → ${data.status}`); lazyAll(); }
  else if (type === "alert_pending") { alertDraft = data; edits = {}; renderCap(); lazyAudit(); }
  else if (type === "alert") { alertDraft = data; renderCap(); lazyAudit(); }
}
async function poll() {
  if (polling) return; polling = true;
  try {
    const wantTick = Date.now() - lastTick > 15000; if (wantTick) lastTick = Date.now();
    const r = await j(`${API}/events?since=${cursor}${wantTick ? "&tick_sim=1" : ""}`);
    dot(true);
    if (cursor >= 0) r.events.filter((e) => !seen.has(e.id)).forEach((e) => { seen.add(e.id); handleEvent(e); });
    else r.events.forEach((e) => seen.add(e.id));
    cursor = r.cursor; if (seen.size > 500) seen = new Set([...seen].slice(-200));
  } catch { dot(false); }
  polling = false;
  clearTimeout(pollTimer); pollTimer = setTimeout(poll, document.hidden ? 30000 : 4000);
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) { clearTimeout(pollTimer); poll(); } });
function connect() { cursor = -1; poll(); setInterval(() => { if (!document.hidden) lazyAll(); }, 60000); }   // safety net in case a poll ever misses an event
/* ---------- location search + live conditions for any place ---------- */
const WARD14 = [13.0067, 80.2571];
let liveMode = null, lastTelemetry = null, liveTimer = null, searchTok = 0;
const kcEls = ["#kc1", "#kc2", "#kc3", "#kc4"].map((s) => $(s)), kcOrig = kcEls.map((e) => e.innerHTML);
const searchLayer = L.layerGroup().addTo(map);
const modeBar = (html) => { $("#kpiMode").innerHTML = html; };
const simBar = () => modeBar(`<span class="badge b-amb">SIMULATED</span><b>Ward 14 - Adyar Basin pilot</b><span class="text-slate-400">demo values for the pilot ward. Search a place above to see real live data.</span>`);
simBar();

function nearbyOpen(lat, lon, km) { return queue.filter((s) => s.status !== "RESOLVED" && LiveData.haversineKm(lat, lon, s.lat, s.lon) <= km); }
function renderLiveKpis() {
  if (!liveMode) return;
  const { place, d } = liveMode, SEV = LiveData.SEV_COL, near = nearbyOpen(place.lat, place.lon, 25), r = d.river;
  const sevBadge = { CRITICAL: "b-red", HIGH: "b-amb", MODERATE: "b-blu", LOW: "b-grn" }[d.risk.severity];
  kcEls[0].innerHTML = `<div class="text-xs text-slate-400">RAINFALL, LAST HOUR</div><div class="text-3xl font-bold mt-1">${d.rain1h.toFixed(1)} <span class="text-sm font-normal text-slate-400">mm</span></div><div class="text-xs mt-1 text-slate-400">past 24 h ${d.rainPast24.toFixed(1)} mm &bull; next 24 h ${d.rainNext24.toFixed(1)} mm</div>`;
  kcEls[1].innerHTML = `<div class="text-xs text-slate-400">RIVER FLOW (NEAREST RIVER)</div><div class="text-3xl font-bold mt-1">${r ? Math.round(r.today) : "n/a"} <span class="text-sm font-normal text-slate-400">${r ? esc(r.unit) : ""}</span></div><div class="text-xs mt-1 text-slate-400">${r ? `7-day average ${Math.round(r.mean7)} &bull; forecast peak ${Math.round(r.peak7)}` : "no river model data for this point"}</div>`;
  kcEls[2].innerHTML = `<div class="text-xs text-slate-400">INDICATIVE FLOOD RISK</div><div class="text-3xl font-bold mt-1">${d.risk.score}<span class="text-sm font-normal text-slate-400"> / 100</span> <span class="badge ${sevBadge} align-middle">${d.risk.severity}</span></div><div class="text-xs mt-1 text-slate-400">${esc(d.risk.why[0])}</div>`;
  kcEls[3].innerHTML = `<div class="text-xs text-slate-400">OPEN REQUESTS WITHIN 25 KM</div><div class="text-3xl font-bold mt-1 ${near.length ? "text-red-400" : ""}">${near.length}</div><div class="text-xs mt-1 text-slate-400">${near.length ? near.slice(0, 3).map((s) => esc(s.id)).join(", ") : "none reported here"}</div>`;
  const when = d.updated.replace("T", " ");
  modeBar(`<span class="badge b-grn">LIVE</span><b>${esc(place.name)}</b><span class="text-slate-400">${esc(place.region || "")} &bull; Open-Meteo &bull; updated ${esc(when)} &bull; refreshes every 5 min</span>`);
  const card = $("#liveCard"); card.classList.remove("hidden"); card.innerHTML = LiveData.panelHTML(place, d);
}
async function showPlace(place) {
  const mine = ++searchTok; $("#locList").classList.add("hidden"); $("#locQ").value = `${place.name}${place.region ? ", " + place.region : ""}`;
  $("#locGo").textContent = "Loading..."; searchLayer.clearLayers();
  L.marker([place.lat, place.lon]).bindPopup(`<b>${esc(place.name)}</b><br>${esc(place.region || "")}`).addTo(searchLayer);
  L.circle([place.lat, place.lon], { radius: 25000, color: "#2563EB", weight: 1, dashArray: "5 5", fillOpacity: 0.03, interactive: false }).addTo(searchLayer);
  map.flyTo([place.lat, place.lon], 11, { duration: 1.2 });
  try {
    const d = await LiveData.fetch(place.lat, place.lon);
    if (mine !== searchTok) return;
    liveMode = { place, d }; renderLiveKpis(); $("#locReset").classList.remove("hidden");
    clearInterval(liveTimer); liveTimer = setInterval(async () => { try { liveMode.d = await LiveData.fetch(place.lat, place.lon); renderLiveKpis(); } catch {} }, 300000);
  } catch (e) { toast("Could not load live data: " + e.message); }
  $("#locGo").textContent = "Search";
}
function resetPlace() {
  searchTok++; liveMode = null; clearInterval(liveTimer); searchLayer.clearLayers();
  kcEls.forEach((e, i) => { e.innerHTML = kcOrig[i]; }); $("#liveCard").classList.add("hidden"); $("#locReset").classList.add("hidden"); $("#locQ").value = "";
  if (lastTelemetry) renderTelemetry(lastTelemetry); simBar(); map.flyTo(WARD14, 14, { duration: 1 });
}
$("#locReset").onclick = resetPlace;
$("#locForm").onsubmit = async (e) => {
  e.preventDefault(); const q = $("#locQ").value.trim(); if (!q) return;
  $("#locGo").textContent = "Searching...";
  try {
    const res = await LiveData.search(q);
    if (!res.length) { toast(`No place found for "${q}". Try a city or area name, or lat,lon.`); $("#locGo").textContent = "Search"; return; }
    if (res.length === 1) return showPlace(res[0]);
    $("#locList").innerHTML = res.map((r, i) => `<button type="button" data-i="${i}" class="w-full text-left px-3 py-2 hover:bg-slate-100 border-b border-slate-200"><b>${esc(r.name)}</b> <span class="text-slate-400 text-xs">${esc(r.region)} &bull; ${r.lat.toFixed(2)}, ${r.lon.toFixed(2)}</span></button>`).join("");
    $("#locList").classList.remove("hidden");
    $("#locList").querySelectorAll("button").forEach((b) => b.onclick = () => showPlace(res[+b.dataset.i]));
  } catch (err) { toast("Search failed: " + err.message); }
  $("#locGo").textContent = "Search";
};
document.addEventListener("click", (e) => { if (!e.target.closest("#locBox")) $("#locList").classList.add("hidden"); });
// keep the nearby-request count current as the queue changes
const _renderQueue = renderQueue; renderQueue = function () { _renderQueue(); if (liveMode) renderLiveKpis(); };


boot();

/* alertNow – mobile (Citizen + Field Responder). Offline-first PWA.
   Local persistence: localStorage action queue + cached layers (the native Expo/SQLite version uses the same queue contract). */
const API = "/api/v1", $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const store = { get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} } };
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());
const toast = (m) => { const t = $("#toast"); t.textContent = m; t.style.display = "block"; clearTimeout(toast.h); toast.h = setTimeout(() => t.style.display = "none", 3500); };
const WARD = [13.0067, 80.2571];
const hav = (a, b, c, d) => { const R = 6371000, p = Math.PI / 180, x = Math.sin((c - a) * p / 2) ** 2 + Math.cos(a * p) * Math.cos(c * p) * Math.sin((d - b) * p / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(x)); };

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

/* ---------- connectivity + queue ---------- */
let forceOffline = false;
const online = () => navigator.onLine && !forceOffline;
async function api(path, opt = {}) {
  if (!online()) throw new Error("offline");
  const tk = getTok();
  const r = await fetch(API + path, { ...opt, headers: { "Content-Type": "application/json", ...(tk ? { Authorization: "Bearer " + tk } : {}), ...(opt.headers || {}) } });
  if (r.status === 401 && tk && !path.startsWith("/auth/login")) { setTok(null); me = null; applyAuth(); }
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
  return r.json();
}
/* ---------- sign-in (rescue officers / control room only; citizens stay anonymous) ---------- */
const TOKEN_KEY = "shield_token";
const getTok = () => { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } };
const setTok = (v) => { try { v ? localStorage.setItem(TOKEN_KEY, v) : localStorage.removeItem(TOKEN_KEY); } catch {} };
let authRequired = false, me = null;
async function initAuth() {
  try { authRequired = (await api("/config")).auth_required; store.set("authRequired", authRequired); } catch { authRequired = store.get("authRequired", false); }
  if (authRequired && getTok()) { try { me = await api("/auth/me"); if (me.role === "CITIZEN") me = null; } catch { me = null; } }
  applyAuth();
}
function applyAuth() {
  const ok = !authRequired || !!me, rs = $("#unitSel");
  if (!ok && !embedded && (mode === "responder" || roleParam === "officer")) return toPortal("officer");   // officers must sign in first
  $("#respBody").classList.toggle("locked", !ok);
  const out = $("#signOut2"); out.classList.toggle("hidden", !(authRequired && me)); if (me) out.textContent = `Sign out (${me.name})`;
  if (me && me.role === "OFFICER" && me.unit) { rs.value = me.unit; rs.disabled = true; store.set("unit", me.unit); } else rs.disabled = false;
  if (ok && mode === "responder") { loadInbox(); loadMission(); }
}
$("#loginForm").onsubmit = async (e) => {
  e.preventDefault(); $("#lgErr").textContent = "";
  try { const r = await api("/auth/login", { method: "POST", body: JSON.stringify({ username: $("#lgUser").value, password: $("#lgPass").value }) });
    setTok(r.token); $("#lgPass").value = ""; me = { role: r.role, unit: r.unit, name: r.name }; applyAuth(); connectNow(); }
  catch (err) { $("#lgErr").textContent = err.message; }
};
$("#signOut2").onclick = () => { setTok(null); me = null; location.href = "/?out=1"; };
const queue = () => store.get("queue", []);
function enqueue(item) { const q = queue(); q.push({ id: uid(), at: new Date().toISOString(), ...item }); store.set("queue", q); paint(); }
function paint() {
  const n = $("#net"); n.textContent = online() ? "ONLINE" : "OFFLINE • CACHED"; n.className = "chip " + (online() ? "on" : "off");
  const q = queue().length, c = $("#queueChip"); c.textContent = q + " queued"; c.classList.toggle("hidden", !q);
}
let syncing = false;
async function sync() {
  if (!online() || syncing || !queue().length) return paint();
  syncing = true;
  try {
    let q = queue();
    const sos = q.filter((x) => x.kind === "sos");
    if (sos.length) {  // batch offline sync of SOS beacons
      const res = await api("/sos", { method: "POST", body: JSON.stringify(sos.map((s) => ({ ...s.payload, synced_offline: Date.now() - new Date(s.at).getTime() > 20000, created_at: s.at }))) });
      const ids = new Set(sos.map((s) => s.id)); q = queue().filter((x) => !ids.has(x.id)); store.set("queue", q);
      store.set("mySos", [...store.get("mySos", []), ...res.map((r) => r.sos_id)]); refreshMy();
      res.forEach((r, i) => { if (r.duplicate) return; const it = sos[i];
        Notifier.push({ level: "update", title: `Request ${r.sos_id} received`, body: `Sent to Control Room and ${it.payload.assigned_officer}. Priority ${r.severity}. Help is being arranged.`, speak: "Your request has been received. Help is being arranged." }); });
    }
    for (const it of queue().filter((x) => x.kind !== "sos")) {
      await api(it.path, { method: "POST", body: JSON.stringify(it.payload) });
      store.set("queue", queue().filter((x) => x.id !== it.id));
    }
  } catch (e) { if (e.message !== "offline") toast("Sync paused: " + e.message); }
  syncing = false; paint(); if (mode === "responder") loadMission();
}
addEventListener("online", () => { paint(); sync(); }); addEventListener("offline", paint);
setInterval(sync, 8000);
function simToggle(b) { forceOffline = !forceOffline; b.textContent = forceOffline ? "Restore connectivity (sync queue)" : "Simulate loss of cellular data"; ["#simOff", "#simOff2"].forEach((s) => $(s).textContent = b.textContent); paint(); if (!forceOffline) sync(); }
$("#simOff").onclick = (e) => simToggle(e.target); $("#simOff2").onclick = (e) => simToggle(e.target);

/* ---------- mode switch ---------- */
const roleParam = ["citizen", "officer"].includes(params.get("role")) ? params.get("role") : null, embedded = !!params.get("embed");
let mode = roleParam ? (roleParam === "officer" ? "responder" : "citizen") : params.get("mode") === "responder" ? "responder" : "citizen";
const toPortal = (role) => location.replace("/?role=" + role);   // sign-in (password + security key) lives on the access portal
function setMode(m) {
  if (m === "responder" && authRequired && !me && !embedded) return toPortal("officer");
  mode = m; ["citizen", "responder"].forEach((x) => $("#" + x).classList.toggle("hidden", x !== m));
  document.querySelectorAll("#botnav button").forEach((b) => b.classList.toggle("sel", b.dataset.m === m));
  $("#sub").textContent = m === "citizen" ? "Citizen • Ward 14 – Adyar Basin" : "Field Responder • Ward 14";
  setTimeout(() => { (m === "citizen" ? cmap : rmap)?.invalidateSize(); }, 80);
  if (m === "responder") { loadInbox(); loadMission(); } else refreshMy();
}
document.querySelectorAll("#botnav button").forEach((b) => b.onclick = () => setMode(b.dataset.m));
if (embedded || roleParam) $("#botnav").classList.add("hidden");   // one screen per role
if (embedded) $("#portalLink").classList.add("hidden");

/* ---------- GPS ---------- */
let pos = { lat: WARD[0], lon: WARD[1], real: false };
if (navigator.geolocation) navigator.geolocation.watchPosition((p) => { if (!pos.picked) pos = { lat: p.coords.latitude, lon: p.coords.longitude, real: true }; gpsPaint(); }, gpsPaint, { enableHighAccuracy: true, maximumAge: 15000 });
function gpsPaint() {
  const t = `${pos.lat.toFixed(4)}°N, ${pos.lon.toFixed(4)}°E ${pos.real ? "(GPS)" : pos.picked ? "(selected place)" : "(Ward 14 default – GPS unavailable)"}`;
  $("#gps").textContent = "GPS: " + t; $("#rgps").textContent = t;
}
gpsPaint();

/* ---------- map helpers ---------- */
const tiles = () => L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 17, attribution: "© OSM (cached)" });
const cmap = L.map("cmap").setView(WARD, 14); tiles().addTo(cmap);
const rmap = L.map("rmap").setView(WARD, 14); tiles().addTo(rmap);
let shelterMarks = L.layerGroup().addTo(cmap), navLine = null, youMark = null;

/* ================= CITIZEN ================= */
let depth = 0.45;
document.querySelectorAll("#depthSeg .opt").forEach((b) => b.onclick = () => { depth = +b.dataset.d; document.querySelectorAll("#depthSeg .opt").forEach((x) => x.classList.toggle("sel", x === b)); });
/* rescue teams / officers the citizen can assign the request to (cached for offline use) */
const FALLBACK_UNITS = [{ id: "Alpha-04", name: "NDRF Boat Team" }, { id: "Bravo-02", name: "Chennai Fire & Rescue" }, { id: "Charlie-07", name: "GCC Medical Response" }];
let units = store.get("units", FALLBACK_UNITS);
async function loadUnits() {
  try { units = (await api("/units")).map((u) => ({ id: u.id, name: u.name })); store.set("units", units); } catch {}
  const cur = $("#officerSel").value;
  $("#officerSel").innerHTML = '<option value="">- Select rescue team / officer -</option>' + units.map((u) => `<option value="${esc(u.id)}">${esc(u.id)} - ${esc(u.name)}</option>`).join("");
  $("#officerSel").value = cur;
  const rs = $("#unitSel"), rcur = rs.value || store.get("unit", units[0]?.id);
  rs.innerHTML = units.map((u) => `<option value="${esc(u.id)}">${esc(u.id)} - ${esc(u.name)}</option>`).join(""); rs.value = rcur;
}
$("#useLoc").onclick = () => {
  if (!navigator.geolocation) return toast("Live location is not available on this device");
  $("#gps").textContent = "GPS: locating...";
  navigator.geolocation.getCurrentPosition((p) => { pos = { lat: p.coords.latitude, lon: p.coords.longitude, real: true }; gpsPaint();
    if (!$("#caddr").value.trim()) $("#caddr").value = `Live location ${pos.lat.toFixed(5)}, ${pos.lon.toFixed(5)}`; toast("Live location captured"); },
    () => toast("Could not get live location - type your address instead"), { enableHighAccuracy: true, timeout: 10000 });
};
const SEV_CLS = { CRITICAL: "r", HIGH: "a", MODERATE: "b" };
function renderMy() {
  const ids = store.get("mySos", []), q = store.get("lastQueue", []), pend = queue().filter((x) => x.kind === "sos");
  const rows = pend.map((p) => `<div class="req-card"><b>${esc(p.payload.request_type)}</b> <span class="badge a">QUEUED ON DEVICE</span><div class="mut">Will be sent to ${esc(p.payload.assigned_officer)} when you are back online.</div></div>`)
    .concat(ids.map((id) => { const s = q.find((x) => x.id === id);
      return s ? `<div class="req-card ${s.severity === "CRITICAL" ? "crit" : ""}"><div class="row" style="justify-content:space-between"><b>${esc(s.id)} - ${esc(s.request_type)}</b><span class="badge ${SEV_CLS[s.severity]}">${s.severity}</span></div>
        <div class="mut">Assigned to ${esc(s.assigned_officer || "Control Room")} - <b>${esc(s.status_label)}</b></div></div>`
        : `<div class="req-card"><b>${esc(id)}</b> <span class="badge g">COMPLETED / CLOSED</span></div>`; }).reverse());
  $("#myReqs").innerHTML = rows.join("") || "No requests yet.";
}
async function refreshMy() { const ids = store.get("mySos", []); if (ids.length) { try { store.set("lastQueue", await api("/my-requests?ids=" + encodeURIComponent(ids.join(",")))); } catch {} } renderMy(); }
const bad = (el, on) => { el.classList.toggle("bad", on); return on; };
$("#sosBtn").onclick = () => {
  const name = $("#cname"), phone = $("#cphone"), addr = $("#caddr"), desc = $("#cdesc"), off = $("#officerSel");
  const phoneOk = /^\+?[0-9][0-9\s-]{7,13}$/.test(phone.value.trim());
  const errs = [bad(name, !name.value.trim()), bad(phone, !phoneOk), bad(addr, !addr.value.trim() && !pos.real), bad(desc, !desc.value.trim()), bad(off, !off.value)];
  if (errs.some(Boolean)) { $("#sosStatus").innerHTML = "<b style='color:#B91C1C'>Please fill the highlighted fields</b> (name, valid phone, address or live location, description, rescue team)."; return; }
  const payload = { client_id: uid(), citizen_name: name.value.trim(), phone: phone.value.trim(), request_type: $("#rtype").value,
    address: addr.value.trim(), location_source: pos.real ? "GPS" : "MANUAL", description: desc.value.trim(), assigned_officer: off.value,
    household_size: Math.max(1, +$("#hh").value || 1), lat: pos.lat, lon: pos.lon,
    water_depth_m: depth, vulnerability_tags: [...document.querySelectorAll("#vuln input:checked")].map((i) => i.value) };
  enqueue({ kind: "sos", payload });  // always queue first (offline-first); sync flushes immediately if online
  desc.value = "";
  $("#sosStatus").innerHTML = online() ? "Request captured - sending to Control Room and " + esc(payload.assigned_officer) + "..." : "<b style='color:#B45309'>No data connection.</b> Request stored on device; it will auto-send when any signal returns.";
  if (navigator.vibrate) navigator.vibrate(200); sync();
};

let shelters = store.get("shelters", []);
async function loadShelters() {
  try { const g = await api("/gis/layers"); shelters = g.shelters.features.map((f) => ({ ...f.properties, lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0] })); store.set("shelters", shelters); } catch {}
  shelterMarks.clearLayers();
  shelters.forEach((s) => L.marker([s.lat, s.lon]).bindPopup(`<b>${esc(s.name)}</b><br>${s.free_beds} beds free`).addTo(shelterMarks));
  $("#shelterList").innerHTML = shelters.map((s) => `🏥 ${esc(s.name)} — <b>${s.free_beds}</b> beds free`).join("<br>") || "No cached shelters yet.";
}
const HEAD = { en: "CRITICAL FLOOD WARNING", ta: "அதி தீவிர வெள்ள எச்சரிக்கை", hi: "गंभीर बाढ़ चेतावनी" };
let alertData = store.get("alert", null), lang = store.get("lang", "en");
$("#alertLang").value = lang;
$("#alertLang").onchange = (e) => { lang = e.target.value; store.set("lang", lang); showAlert(); };
function showAlert() {
  const a = alertData; $("#alertBox").classList.toggle("hidden", !a); if (!a) return;
  $("#alertHead").textContent = HEAD[lang]; $("#alertBody").textContent = a.messages[lang];
  $("#alertMeta").textContent = `${a.cap_identifier} • approved ${new Date(a.approved_at).toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata" })} IST by ${a.approved_by}${online() ? "" : " • cached copy"}`;
}
$("#navShelter").onclick = () => {
  const ok = shelters.filter((s) => s.free_beds > 0).sort((a, b) => hav(pos.lat, pos.lon, a.lat, a.lon) - hav(pos.lat, pos.lon, b.lat, b.lon))[0];
  if (!ok) return toast("No shelter data cached");
  if (navLine) cmap.removeLayer(navLine); if (youMark) cmap.removeLayer(youMark);
  youMark = L.circleMarker([pos.lat, pos.lon], { color: "#3B82F6", radius: 8 }).addTo(cmap).bindPopup("You");
  navLine = L.polyline([[pos.lat, pos.lon], [ok.lat, ok.lon]], { color: "#10B981", weight: 5, dashArray: "8 6" }).addTo(cmap); cmap.fitBounds(navLine.getBounds(), { padding: [30, 30] });
  $("#shelterList").innerHTML = `➡ <b>${esc(ok.name)}</b> — ${(hav(pos.lat, pos.lon, ok.lat, ok.lon) / 1000).toFixed(2)} km, ${ok.free_beds} beds free. Avoid submerged roads; follow official green corridors.`;
  window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
};
async function loadAlert() { try { const a = await api("/alerts/active"); if (a) { alertData = a; store.set("alert", a); } } catch {} showAlert(); }

/* ================= RESPONDER ================= */
$("#unitSel").onchange = () => { store.set("unit", $("#unitSel").value); loadInbox(); loadMission(); };
let missionSos = null, routeLayer = null, hazLayer = L.layerGroup().addTo(rmap);
async function loadMission() {
  const u = $("#unitSel").value; if (!u || (authRequired && !me)) return;
  let q = store.get("mq_" + u, []);
  try { q = await api(`/officers/${encodeURIComponent(u)}/requests`); store.set("mq_" + u, q); } catch {}
  const _u = u, s = q.find((x) => x.assigned_unit_id === u && x.status === "DISPATCHED");
  if (!s) { missionSos = null; $("#mission").innerHTML = `No active mission for <b>${esc(u)}</b>. Accept a request above to start.`; if (routeLayer) rmap.removeLayer(routeLayer); return; }
  let m = s; try { m = await api(`/sos/${s.id}/mission`); store.set("mission_" + s.id, m); } catch { m = store.get("mission_" + s.id, s); }
  missionSos = m; const r = m.route;
  $("#mission").innerHTML = `<div class="row" style="justify-content:space-between"><b style="font-size:17px">${esc(m.id)}</b><span class="badge ${m.severity === "CRITICAL" ? "r" : "a"}">${m.severity}</span></div>
    <div>${esc(m.citizen_name)} • household of ${m.household_size} • Sector ${m.sector}</div>
    <div style="margin:6px 0">${m.vulnerability_tags.map((t) => `<span class="badge a">${esc(t)}</span>`).join(" ") || '<span class="mut">no vulnerability flags</span>'}</div>
    <div>Live water depth: <b style="color:#B45309">${m.water_depth_m} m</b> • Priority ${m.priority_score}</div>
    ${r ? `<div style="margin-top:8px"><span class="badge g">VERIFIED SAFE ROUTE</span> <span class="mut">${r.metres} m • avoids ${r.avoided.length} flooded segment(s)</span><ol>${r.steps.map((x) => `<li>${esc(x)}</li>`).join("")}</ol>
    ${r.shelter ? `<div class="mut">Evacuation target: ${esc(r.shelter.name)} (${r.shelter.free} beds free)</div>` : ""}</div>` : '<div class="mut">Route pending…</div>'}`;
  if (routeLayer) rmap.removeLayer(routeLayer);
  if (r) { routeLayer = L.polyline(r.geometry.coordinates.map(([x, y]) => [y, x]), { color: "#10B981", weight: 6 }).addTo(rmap); rmap.fitBounds(routeLayer.getBounds(), { padding: [25, 25] }); }
  L.circleMarker([m.lat, m.lon], { color: "#EF4444", radius: 9 }).addTo(rmap).bindPopup(m.id);
  paintHazards();
}
async function paintHazards() {
  let roads = store.get("roads", []); try { roads = await api("/roads"); store.set("roads", roads); } catch {}
  hazLayer.clearLayers();
  const N = { A: [13.017, 80.244], B: [13.017, 80.261], C: [13.017, 80.278], D: [13, 80.244], E: [13, 80.261], F: [13, 80.278], M: [13.0085, 80.261] };
  roads.filter((r) => r.status !== "SAFE").forEach((r) => L.polyline([N[r.from], N[r.to]], { color: r.status === "BLOCKED" ? "#EF4444" : "#F59E0B", weight: 5, dashArray: "6 6" }).bindTooltip(r.name + " " + r.status).addTo(hazLayer));
}
/* ---- officer inbox: requests assigned to the selected rescue team / officer ---- */
const ST_NEXT = [["ACCEPTED", "Accept", "grn"], ["EN_ROUTE", "En Route", "blu"], ["ON_SCENE", "On Scene", "amb"], ["EVACUATED", "Evacuated to Shelter", "gry"]];
const mapsLink = (s) => `https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lon}`;
async function loadInbox() {
  const u = $("#unitSel").value; if (!u || (authRequired && !me)) return;
  let rows = store.get("inbox_" + u, []);
  try { rows = await api(`/officers/${encodeURIComponent(u)}/requests`); store.set("inbox_" + u, rows); } catch {}
  if (!rows.length) { $("#inbox").innerHTML = `No open requests assigned to <b>${esc(u)}</b>.`; return; }
  $("#inbox").innerHTML = rows.map((s) => `<div class="req-card ${s.severity === "CRITICAL" ? "crit" : ""}" data-id="${esc(s.id)}">
    <div class="row" style="justify-content:space-between"><b>${esc(s.id)} - ${esc(s.request_type)}</b><span class="badge ${SEV_CLS[s.severity]}">${s.severity}</span></div>
    <div class="kv"><span>Name</span><span>${esc(s.citizen_name)} (${s.household_size} people)</span>
      <span>Phone</span><span>${s.phone ? `<a class="lnk" href="tel:${esc(s.phone)}">${esc(s.phone)}</a>` : "-"}</span>
      <span>Address</span><span>${esc(s.address || "-")}</span>
      <span>Location</span><span>${s.lat.toFixed(5)}, ${s.lon.toFixed(5)} - <a class="lnk" target="_blank" rel="noopener" href="${mapsLink(s)}">Navigate</a></span>
      <span>Details</span><span>${esc(s.description || "-")}</span>
      <span>Water</span><span>${s.water_depth_m} m ${s.vulnerability_tags.map((t) => `<span class="badge a">${esc(t)}</span>`).join(" ")}</span>
      <span>Status</span><span><b>${esc(s.field_status || "New - not yet accepted")}</b></span></div>
    <input type="text" class="note" placeholder="Add a note for the Control Room (optional)">
    <div class="acts">${ST_NEXT.map(([k, l, c]) => `<button class="btn sm ${c}" data-act="${k}">${l}</button>`).join("")}
      <button class="btn sm red" data-act="RESOLVED" style="grid-column:1/-1">Mark Resolved / Help Delivered</button></div></div>`).join("");
  document.querySelectorAll("#inbox [data-act]").forEach((b) => b.onclick = () => setStatus(b.closest(".req-card"), b.dataset.act, b.textContent));
  const first = rows.find((x) => x.status === "DISPATCHED"); if (first && mode === "responder") loadMission();
}
async function setStatus(card, st, label) {
  const id = card.dataset.id, path = `/sos/${id}/status`, payload = { status: st, note: card.querySelector(".note").value.trim() };
  try { await api(path, { method: "POST", body: JSON.stringify(payload) }); toast(`${id}: ${label} - Control Room updated`); }
  catch (e) { if (e.message === "offline") { enqueue({ kind: "status", path, payload }); toast("Offline - update queued, will sync"); } else return toast(e.message); }
  setTimeout(() => { loadInbox(); loadMission(); }, 400);
}
$("#refreshReq").onclick = () => { loadInbox(); loadMission(); };
$("#hzBtn").onclick = async () => {
  const payload = { lat: pos.lat, lon: pos.lon, status: $("#hzStatus").value, water_depth_m: +$("#hzDepth").value || 0.5, reporter: $("#unitSel").value };
  try { const r = await api("/roads/report", { method: "POST", body: JSON.stringify(payload) }); toast(`Flagged: ${r.name} → ${r.status}`); paintHazards(); }
  catch (e) { if (e.message === "offline") { enqueue({ kind: "hazard", path: "/roads/report", payload }); toast("Offline – hazard report queued"); } else toast(e.message); }
};

/* ---------- notifications (pop-up + voice) ---------- */
if (params.get("embed")) Notifier.mute(true);   // the Control Room page already announces everything; avoid double voice
else Notifier.mount($("#ntfSlot"));
function notifyMobile(d) {
  const mine = store.get("mySos", []).includes(d.id), unit = $("#unitSel").value, forMe = d.assigned_officer === unit || d.assigned_unit_id === unit;
  if (forMe && d.event === "new_request")   // rescue officer: a new request was assigned to this team
    Notifier.push({ level: "new", title: `New request for ${unit}: ${d.request_type}`, body: `${d.citizen_name} (${d.phone || "no phone"}), ${d.address || "Sector " + d.sector}. Priority ${d.severity}.`,
      speak: `New ${d.request_type} request assigned to ${unit.replace("-", " ")}. ${d.citizen_name}, priority ${d.severity}.` });
  else if (forMe && d.event === "dispatched")
    Notifier.push({ level: "warn", title: `Dispatch order: ${d.id}`, body: `Control Room dispatched you to ${d.citizen_name}. Safe route is ready.`, speak: `Dispatch order. ${d.id}. Safe route is ready.` });
  if (mine && d.event !== "new_request")   // citizen: progress on their own request
    Notifier.push({ level: d.status === "RESOLVED" ? "update" : "warn", title: `Your request ${d.id}: ${d.field_status || d.status_label}`,
      body: `${d.assigned_unit_id || d.assigned_officer || "The rescue team"} is handling it.${d.note ? " Note: " + d.note : ""}`,
      speak: `Update on your request. ${d.field_status || d.status_label}.` });
}

/* ---------- live socket ---------- */
let cursor = -1, seen = new Set(), pollTimer = null, polling = false;
const pollReset = () => { cursor = -1; clearTimeout(pollTimer); poll(); };   // new identity (sign-in / sign-out) -> restart the feed
const connectNow = pollReset;
function onEvent({ type, data }) {
  if (type === "alert") { alertData = data; store.set("alert", data); showAlert(); toast("⚠ New geo-alert received"); if (navigator.vibrate) navigator.vibrate([300, 150, 300]); }
  if (type === "sos") { notifyMobile(data); if (mode === "responder") { loadInbox(); loadMission(); } else refreshMy(); }
  if (type === "road") { loadShelters(); if (mode === "responder") { loadMission(); } }
}
async function poll() {   // live updates are polled from the server's event log (serverless hosting has no WebSockets)
  clearTimeout(pollTimer);
  if (polling) return; polling = true;
  try {
    if (online()) {
      const r = await api(`/events?since=${cursor}`);
      if (cursor >= 0) r.events.filter((e) => !seen.has(e.id)).forEach((e) => { seen.add(e.id); onEvent(e); }); else r.events.forEach((e) => seen.add(e.id));
      cursor = r.cursor; if (seen.size > 500) seen = new Set([...seen].slice(-200));
    }
  } catch {}
  polling = false;
  pollTimer = setTimeout(poll, document.hidden ? 30000 : (params.get("embed") ? 8000 : 4000));
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) poll(); });
function connect() { poll(); setInterval(() => { if (!document.hidden && online()) { if (mode === "responder") { loadInbox(); loadMission(); } else refreshMy(); } }, 60000); }   // safety net


/* ---------- search any place: live conditions + use it as the request location ---------- */
let placeMark = null, picked = null;
$("#placeForm").onsubmit = async (e) => {
  e.preventDefault(); const q = $("#placeQ").value.trim(); if (!q) return;
  if (!online()) return toast("Searching needs a data connection");
  $("#placeList").innerHTML = '<span class="mut">Searching...</span>';
  try {
    const res = await LiveData.search(q);
    if (!res.length) { $("#placeList").innerHTML = `<span class="mut">No place found for "${esc(q)}". Try a city or area name.</span>`; return; }
    if (res.length === 1) return pickPlace(res[0]);
    $("#placeList").innerHTML = res.map((r, i) => `<button type="button" class="opt" data-i="${i}" style="display:block;width:100%;text-align:left;margin-top:4px"><b>${esc(r.name)}</b> <span class="mut">${esc(r.region)}</span></button>`).join("");
    $("#placeList").querySelectorAll("button").forEach((b) => b.onclick = () => pickPlace(res[+b.dataset.i]));
  } catch (err) { $("#placeList").innerHTML = `<span class="mut">Search failed: ${esc(err.message)}</span>`; }
};
async function pickPlace(place) {
  $("#placeList").innerHTML = ""; $("#placePanel").innerHTML = '<span class="mut">Loading live conditions...</span>'; $("#useThis").classList.add("hidden");
  cmap.flyTo([place.lat, place.lon], 12); if (placeMark) cmap.removeLayer(placeMark);
  placeMark = L.marker([place.lat, place.lon]).addTo(cmap).bindPopup(`<b>${esc(place.name)}</b>`);
  try { const d = await LiveData.fetch(place.lat, place.lon); picked = place; $("#placePanel").innerHTML = LiveData.panelHTML(place, d); $("#useThis").classList.remove("hidden"); }
  catch (err) { $("#placePanel").innerHTML = `<span class="mut">Could not load live data: ${esc(err.message)}</span>`; }
}
$("#useThis").onclick = () => {
  if (!picked) return;
  pos = { lat: picked.lat, lon: picked.lon, real: false, picked: true }; gpsPaint();
  $("#caddr").value = `${picked.name}${picked.region ? ", " + picked.region : ""}`; toast("Request location set to " + picked.name);
  $("#reqCard").scrollIntoView({ behavior: "smooth", block: "start" });
};

paint(); showAlert(); loadShelters(); loadAlert(); loadUnits().then(() => { sync(); setMode(mode); initAuth(); }); refreshMy(); connect();

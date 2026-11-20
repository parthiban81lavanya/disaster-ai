/* Alert-Now.in - live conditions for ANY place (shared by the Control Room and the mobile app; identical copy in /mobile).
   Data: Open-Meteo (free, no API key): geocoding, weather/rain forecast and the GloFAS river-discharge flood API.
   Open-Meteo's free tier is for non-commercial use; a commercial deployment needs their paid plan or another provider.
   The risk number is an INDICATIVE rule of thumb (see riskOf), not an official IMD / CWC / NDMA warning. */
(function () {
  const GEO = "https://geocoding-api.open-meteo.com/v1/search", WX = "https://api.open-meteo.com/v1/forecast", FLOOD = "https://flood-api.open-meteo.com/v1/flood", NOM = "https://nominatim.openstreetmap.org/search";
  const cache = new Map();
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  async function getJson(url) {
    const c = cache.get(url); if (c && Date.now() - c.t < 300000) return c.v;   // 5-minute cache
    const r = await fetch(url); if (!r.ok) throw new Error("Live data service answered " + r.status);
    const v = await r.json(); cache.set(url, { t: Date.now(), v }); return v;
  }
  const num = (s) => { const n = parseFloat(s); return Number.isFinite(n) ? n : null; };

  /* "Adyar", "Mumbai", "T Nagar Chennai", or raw coordinates like "13.05, 80.25" */
  async function search(q) {
    q = String(q || "").trim(); if (q.length < 2) return [];
    const m = q.match(/^(-?\d{1,2}(?:\.\d+)?)\s*[, ]\s*(-?\d{1,3}(?:\.\d+)?)$/);
    if (m && Math.abs(num(m[1])) <= 90 && Math.abs(num(m[2])) <= 180) return [{ name: `${num(m[1]).toFixed(4)}, ${num(m[2]).toFixed(4)}`, region: "Coordinates", lat: num(m[1]), lon: num(m[2]) }];
    let out = [];
    try {
      const d = await getJson(`${GEO}?name=${encodeURIComponent(q)}&count=6&language=en&format=json`);
      out = (d.results || []).map((r) => ({ name: r.name, region: [r.admin2, r.admin1, r.country].filter(Boolean).join(", "), lat: r.latitude, lon: r.longitude }));
    } catch {}
    if (out.length) return out;
    // not a known city name: fall back to OpenStreetMap Nominatim, which understands areas, streets and "area, city" (light use only; see its usage policy)
    const n = await getJson(`${NOM}?q=${encodeURIComponent(q)}&format=jsonv2&limit=6&accept-language=en`);
    return n.map((r) => { const parts = String(r.display_name).split(", "); return { name: r.name || parts[0], region: parts.slice(1, 4).join(", "), lat: parseFloat(r.lat), lon: parseFloat(r.lon) }; });
  }

  const WMO = { 0: "Clear sky", 1: "Mostly clear", 2: "Partly cloudy", 3: "Overcast", 45: "Fog", 48: "Rime fog", 51: "Light drizzle", 53: "Drizzle", 55: "Heavy drizzle", 61: "Light rain", 63: "Rain", 65: "Heavy rain",
    66: "Freezing rain", 67: "Freezing rain", 71: "Light snow", 73: "Snow", 75: "Heavy snow", 80: "Rain showers", 81: "Heavy showers", 82: "Violent showers", 95: "Thunderstorm", 96: "Thunderstorm with hail", 99: "Severe thunderstorm with hail" };
  const sum = (a, i, j) => a.slice(Math.max(0, i), Math.max(0, j)).reduce((s, v) => s + (v || 0), 0);

  /* Indicative risk: IMD 24-hour rainfall classes (heavy 64.5, very heavy 115.6, extremely heavy 204.4 mm) + peak intensity + river discharge anomaly. */
  function riskOf(d) {
    let score = 0; const why = [], r24 = Math.max(d.rainPast24, d.rainNext24);
    if (r24 >= 204.4) { score += 80; why.push(`Extremely heavy rain (${r24.toFixed(0)} mm in 24 h)`); }
    else if (r24 >= 115.6) { score += 60; why.push(`Very heavy rain (${r24.toFixed(0)} mm in 24 h)`); }
    else if (r24 >= 64.5) { score += 40; why.push(`Heavy rain (${r24.toFixed(0)} mm in 24 h)`); }
    else if (r24 >= 15.6) { score += 15; why.push(`Moderate rain (${r24.toFixed(0)} mm in 24 h)`); }
    if (d.peakHourNext24 >= 30) { score += 10; why.push(`Intense burst up to ${d.peakHourNext24.toFixed(0)} mm/h`); }
    else if (d.peakHourNext24 >= 15) { score += 5; why.push(`Heavy burst up to ${d.peakHourNext24.toFixed(0)} mm/h`); }
    if (d.river && d.river.mean7 > 0) {
      const ratio = d.river.peak7 / d.river.mean7;
      if (ratio >= 3) { score += 20; why.push(`River discharge forecast to reach ${ratio.toFixed(1)}x its recent average`); }
      else if (ratio >= 2) { score += 12; why.push(`River discharge forecast ${ratio.toFixed(1)}x its recent average`); }
      else if (ratio >= 1.4) { score += 6; why.push(`River discharge rising (${ratio.toFixed(1)}x average)`); }
    }
    score = Math.min(100, score);
    return { score, severity: score >= 70 ? "CRITICAL" : score >= 45 ? "HIGH" : score >= 25 ? "MODERATE" : "LOW", why: why.length ? why : ["No heavy rain or river rise in the next 24 hours"] };
  }

  async function fetchLive(lat, lon) {
    const q = `latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}`;
    const [wx, fl] = await Promise.all([
      getJson(`${WX}?${q}&current=temperature_2m,relative_humidity_2m,precipitation,weather_code,wind_speed_10m,wind_gusts_10m&hourly=precipitation&past_days=1&forecast_days=2&timezone=auto`),
      getJson(`${FLOOD}?${q}&daily=river_discharge&past_days=7&forecast_days=7`).catch(() => null)]);
    const h = wx.hourly, cur = wx.current;
    let i = h.time.findIndex((t) => t > cur.time) - 1; if (i < 0) i = h.time.length - 1;     // index of the current hour
    const d = { lat, lon, place_tz: wx.timezone, updated: cur.time, tempC: cur.temperature_2m, humidity: cur.relative_humidity_2m, windKmh: cur.wind_speed_10m, gustKmh: cur.wind_gusts_10m,
      sky: WMO[cur.weather_code] || "Weather code " + cur.weather_code, rain1h: cur.precipitation || 0,
      rainPast24: sum(h.precipitation, i - 23, i + 1), rainNext6: sum(h.precipitation, i + 1, i + 7), rainNext24: sum(h.precipitation, i + 1, i + 25),
      peakHourNext24: Math.max(0, ...h.precipitation.slice(i + 1, i + 25).filter((v) => v != null)), river: null };
    const rd = fl && fl.daily && fl.daily.river_discharge;
    if (rd && rd.some((v) => v != null)) {
      const ti = fl.daily.time.indexOf(cur.time.slice(0, 10)), ix = ti >= 0 ? ti : 7, past = rd.slice(0, ix + 1).filter((v) => v != null), fut = rd.slice(ix).filter((v) => v != null);
      if (past.length && fut.length) d.river = { today: rd[ix] ?? past[past.length - 1], mean7: past.reduce((s, v) => s + v, 0) / past.length, peak7: Math.max(...fut), unit: fl.daily_units?.river_discharge || "m³/s" };
    }
    d.risk = riskOf(d);
    return d;
  }

  const SEV_COL = { CRITICAL: "#B91C1C", HIGH: "#B45309", MODERATE: "#1D4ED8", LOW: "#047857" };
  const SEV_BG = { CRITICAL: "#FEE2E2", HIGH: "#FEF3C7", MODERATE: "#DBEAFE", LOW: "#D1FAE5" };
  function tile(label, value, sub) {
    return `<div style="background:#F8FAFC;border:1px solid #E2E8F0;border-radius:10px;padding:8px 10px;min-width:0"><div style="font-size:10px;color:#64748B;font-weight:700;letter-spacing:.04em">${label}</div><div style="font-size:17px;font-weight:700;color:#0F172A">${value}</div>${sub ? `<div style="font-size:11px;color:#64748B">${sub}</div>` : ""}</div>`;
  }
  /* HTML for the "live conditions" block. compact=true for the phone screen. */
  function panelHTML(place, d, extra = "") {
    const r = d.river, t = d.updated.replace("T", " ");
    const trend = r ? (r.peak7 / Math.max(r.mean7, 0.01)).toFixed(1) : null;
    return `<div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:8px">
        <b style="font-size:15px;color:#0F172A">${esc(place.name)}</b><span style="color:#64748B;font-size:12px">${esc(place.region || "")} &bull; ${d.lat.toFixed(3)}, ${d.lon.toFixed(3)}</span>
        <span style="margin-left:auto;font-size:11px;font-weight:800;padding:2px 8px;border-radius:6px;color:${SEV_COL[d.risk.severity]};background:${SEV_BG[d.risk.severity]};border:1px solid ${SEV_COL[d.risk.severity]}">${d.risk.severity} &bull; ${d.risk.score}/100</span></div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(118px,1fr));gap:8px">
        ${tile("RAIN, LAST HOUR", d.rain1h.toFixed(1) + " mm", d.sky)}
        ${tile("PAST 24 H", d.rainPast24.toFixed(1) + " mm", "")}
        ${tile("NEXT 6 H", d.rainNext6.toFixed(1) + " mm", "forecast")}
        ${tile("NEXT 24 H", d.rainNext24.toFixed(1) + " mm", "peak " + d.peakHourNext24.toFixed(1) + " mm/h")}
        ${tile("TEMP / HUMIDITY", Math.round(d.tempC) + "°C / " + d.humidity + "%", "")}
        ${tile("WIND", Math.round(d.windKmh) + " km/h", "gusts " + Math.round(d.gustKmh) + " km/h")}
        ${tile("RIVER FLOW", r ? Math.round(r.today) + " " + r.unit : "n/a", r ? `7-day avg ${Math.round(r.mean7)}, peak ${Math.round(r.peak7)} (${trend}x)` : "no river near this point")}
      </div>
      <div style="margin-top:8px;font-size:12px;color:#334155"><b>Why this level:</b> ${d.risk.why.map(esc).join(" &bull; ")}</div>
      ${extra}
      <div style="margin-top:6px;font-size:10px;color:#64748B">Live data: Open-Meteo weather and GloFAS river model, updated ${esc(t)} local time. Indicative only, not an official IMD, CWC or NDMA warning. Check official alerts before acting.</div>`;
  }
  function haversineKm(a, b, c, d) { const R = 6371, p = Math.PI / 180, x = Math.sin((c - a) * p / 2) ** 2 + Math.cos(a * p) * Math.cos(c * p) * Math.sin((d - b) * p / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(x)); }
  window.LiveData = { search, fetch: fetchLive, panelHTML, riskOf, haversineKm, esc, SEV_COL, SEV_BG };
})();

"""Alert-Now.in – FastAPI backend (Ward 14, Adyar Basin).

Serverless-ready: working data lives in Upstash Redis (app/store.py); live updates are polled from an event log instead of WebSockets.
Without Redis credentials it falls back to an in-process store, so `uvicorn app.main:app` still runs with zero setup.

Runs out-of-the-box on an in-memory store seeded from app/seed.py (identical to db/migrations/002_seed.sql).
For PostGIS deployments apply db/migrations/*.sql; spatial queries equivalent to the Python geo helpers are in db/queries.sql.
"""
import asyncio
import hashlib
import json
import random
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import List, Optional, Union

from fastapi import Depends, FastAPI, Header, HTTPException, Request, WebSocket, WebSocketDisconnect, Body
from fastapi.responses import JSONResponse, Response
from starlette.concurrency import run_in_threadpool
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import ai, auth, cap, geo, store
from .store import S
from .seed import NODES, RIVER, ROADS, SECTORS, SHELTERS, UNITS, LAT, LON, sos_seed

ROOT = Path(__file__).resolve().parents[2]
now = lambda: datetime.now(timezone.utc)


# ------------------------------------------------------------------ state
# `S` is the working data of the *current request* (see app/store.py): loaded from Redis before the handler, saved after it.


# ------------------------------------------------------------------ helpers
def scope(p, s):
    """an officer may only touch requests that belong to their own team"""
    if not auth.can_see_unit(p, s.get("assigned_officer")) and not auth.can_see_unit(p, s.get("assigned_unit_id")):
        raise HTTPException(403, "This request is not assigned to your team")

def audit(actor, action, vtype):
    last = S.audit_new[-1] if S.audit_new else S.audit_last
    prev = last["metadata_hash"] if last else "GENESIS"
    ts = now()
    h = hashlib.sha256(f"{prev}|{ts.isoformat()}|{actor}|{action}|{vtype}".encode()).hexdigest()
    row = dict(id=S.audit_count + len(S.audit_new) + 1, timestamp=ts.isoformat(), actor_module=actor, action_rationale=action,
               verification_type=vtype, metadata_hash=h)
    S.audit_new.append(row)
    return row


PUBLIC_SOS_KEYS = ("id", "request_type", "status", "status_label", "severity", "field_status", "assigned_officer", "assigned_unit_id", "event")


def view_for(kind, data, p):
    """what a given role may see of a live event (None = do not send)"""
    if p["role"] == auth.CONTROL:
        return data
    if kind == "sos":
        if p["role"] == auth.OFFICER and p.get("unit") in (data.get("assigned_officer"), data.get("assigned_unit_id")):
            return data
        return {k: data[k] for k in PUBLIC_SOS_KEYS if k in data}
    if kind == "unit":
        return data if p["role"] == auth.OFFICER else None
    if kind == "alert_pending":
        return None
    return data


async def publish(kind, data):
    """append to the event log; it is written to Redis with the rest of the request's changes and polled by the screens"""
    S.events.append((kind, data, now().isoformat()))


def shelter_summary():
    total = sum(s["total_beds"] for s in S.shelters); occ = sum(s["occupied_beds"] for s in S.shelters)
    return dict(ready=sum(1 for s in S.shelters if s["status"] == "READY"), total_beds=total, free_beds=total - occ)


def active_sos():
    return [s for s in S.sos.values() if s["status"] in ("OPEN", "DISPATCHED")]


def current_risk(sector="ALL"):
    t = S.telemetry
    return ai.assess(t["rainfall_mm_hr"], t["river_level_m"], t["danger_level_m"], t["rate_of_rise"], sector)


def fresh_score(s):
    """copy of a request with its priority re-scored for 'now' (waiting time raises priority); never written back"""
    if s["status"] == "RESOLVED":
        return s
    score, sev = ai.triage(s["water_depth_m"], s["vulnerability_tags"], s["household_size"], s["created_at"])
    return {**s, "priority_score": score, "severity": sev}


def sos_out(s):
    d = {k: v for k, v in s.items() if k not in ("client_id",)}
    d["location"] = dict(lat=s["lat"], lon=s["lon"], crs="EPSG:4326")
    d["status_label"] = ("Awaiting Unit" if s["status"] == "OPEN" else
                         f"{s.get('field_status') or 'En Route'} • {s['assigned_unit_id']}" if s["status"] == "DISPATCHED" else s["status"].title())
    if s["status"] == "OPEN" and s.get("assigned_officer"):
        d["status_label"] = f"Awaiting {s['assigned_officer']}"
    return d


def telemetry_payload():
    t = S.telemetry; r = current_risk()
    delta = (t["rainfall_mm_hr"] - t["prev_rainfall"]) / t["prev_rainfall"] * 100
    return dict(
        imd=dict(rainfall_mm_hr=round(t["rainfall_mm_hr"], 1), pct_over_1hr=round(delta, 1)),
        cwc=dict(river_level_m=round(t["river_level_m"], 2), danger_level_m=t["danger_level_m"],
                 rate_of_rise=round(t["rate_of_rise"], 2)),
        ai=dict(risk_score=round(r["risk_score"]), severity=r["severity"], confidence=r["xgboost_confidence"],
                model=r["model"], feature_contributions=r["feature_contributions"]),
        sos=dict(open=len(active_sos())),
        shelters=shelter_summary(), recorded_at=t["recorded_at"].isoformat())


def best_shelter_route(lat, lon):
    """Nearest shelter (with free beds) reachable over SAFE roads from the hub nearest to (lat, lon)."""
    order = sorted(NODES, key=lambda k: geo.haversine_m(lat, lon, *NODES[k]))
    best = None
    for sh in S.shelters:
        if sh["total_beds"] - sh["occupied_beds"] <= 0:
            continue
        for start in order[:3]:
            r = geo.safe_route(S.roads, start, sh["node"])
            if r and (best is None or r[2] < best[0][2]):
                best = (r, sh, start); break
    return best


# ------------------------------------------------------------------ app
def advance_sim():
    """Serverless replacement for the old 5-second background ticker: catch the simulation up for the time elapsed (max 2 minutes)."""
    n = now()
    if not S.last_sim:
        S.last_sim = n
        return
    steps = min(int((n - S.last_sim).total_seconds() // 5), 24)
    if steps < 1:
        return
    t_ = S.telemetry
    for _ in range(steps):
        t_["prev_rainfall"] = t_["prev_rainfall"] * 0.98 + t_["rainfall_mm_hr"] * 0.02
        t_["rainfall_mm_hr"] = max(0, min(130, ai.jitter(t_["rainfall_mm_hr"], 0.015) + S.surge))
        t_["river_level_m"] = min(7.6, t_["river_level_m"] + t_["rate_of_rise"] / 720 + S.surge * 0.004)
        S.surge = 0.0
        for u in S.units.values():  # move busy units toward their SOS
            if u["status"] == "BUSY" and u["sos"] in S.sos and S.sos[u["sos"]]["status"] == "DISPATCHED":
                s = S.sos[u["sos"]]
                u["lat"] += (s["lat"] - u["lat"]) * 0.12; u["lon"] += (s["lon"] - u["lon"]) * 0.12
    t_["recorded_at"] = n
    S.last_sim = n if steps >= 24 else S.last_sim + timedelta(seconds=5 * steps)
    S.events.append(("telemetry", telemetry_payload(), n.isoformat()))
    for u in S.units.values():
        if u["status"] == "BUSY":
            S.events.append(("unit", dict(id=u["id"], lat=u["lat"], lon=u["lon"], status=u["status"], sos=u["sos"]), n.isoformat()))


def _seed_hook():
    audit("IMD / CWC Ingestion", "Telemetry feeds connected: IMD rain-gauge Nungambakkam, CWC gauge Adyar (Saidapet).", "VERIFIED")
    audit("CAP Ingestion", "NDMA-SACHET feed: Orange alert for Chennai district ingested and geo-matched to Ward 14.", "VERIFIED")
    evaluate(False)


store.seed_hook = _seed_hook
auth.RL = store.RateLimiter()


app = FastAPI(title="Alert-Now.in", version="1.2",
              docs_url=None if auth.AUTH_ON else "/docs", redoc_url=None, openapi_url=None if auth.AUTH_ON else "/openapi.json")
CTRL = auth.require(auth.CONTROL)
OFFR = auth.require(auth.OFFICER)   # officers, and control room


@app.middleware("http")
async def security_headers(request, call_next):
    r = await call_next(request)
    r.headers.setdefault("X-Content-Type-Options", "nosniff")
    r.headers.setdefault("X-Frame-Options", "SAMEORIGIN")
    r.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    if request.url.path.startswith("/api/"):
        r.headers["Cache-Control"] = "no-store"
    return r


LIGHT = ("/api/v1/config", "/api/v1/auth/me", "/api/v1/events", "/healthz")   # no working data needed


@app.middleware("http")
async def unit_of_work(request, call_next):
    path = request.url.path
    if not path.startswith("/api/v1/") or path in LIGHT:
        return await call_next(request)
    try:
        st = await run_in_threadpool(store.load)
    except Exception as e:
        return JSONResponse({"detail": f"Storage unavailable: {e}"}, status_code=503)
    tok = store.use(st)
    try:
        advance_sim()
        resp = await call_next(request)
    finally:
        store.release(tok)
    if resp.status_code < 400:     # persist BEFORE answering: a serverless instance may be frozen right after the response
        try:
            await run_in_threadpool(store.flush, st)
        except Exception as e:
            return JSONResponse({"detail": f"Could not save: {e}"}, status_code=503)
    return resp


def client_ip(request: Request) -> str:
    fwd = request.headers.get("x-forwarded-for", "")
    return fwd.split(",")[0].strip() or (request.client.host if request.client else "?")


def sos_rate_ok(ip: str) -> bool:
    """public citizen endpoint: max 30 requests per IP per 10 minutes (only enforced when auth is on); counter is shared by all instances"""
    if not auth.AUTH_ON:
        return True
    return store.RateLimiter().hit("sos|" + ip, 600) <= 30


# ------------------------------------------------------------------ models
class Eval(BaseModel):
    surge: bool = False
    ward_id: int = 14

class Approve(BaseModel):
    approved_by: str = "District Duty Officer"
    language: str = "en"
    message_body: Optional[str] = None
    channels: List[str] = ["PUSH", "SMS", "IVR"]

class SosIn(BaseModel):
    client_id: Optional[str] = None
    citizen_name: str = Field("Anonymous", max_length=80)
    household_size: int = Field(1, ge=1, le=50)
    lat: float
    lon: float
    water_depth_m: float = 0.3
    vulnerability_tags: List[str] = []
    synced_offline: bool = False
    created_at: Optional[datetime] = None
    # citizen help-request form
    request_type: str = Field("Flood Rescue", max_length=40)
    phone: str = Field("", max_length=20)
    address: str = Field("", max_length=300)
    description: str = Field("", max_length=1000)
    assigned_officer: Optional[str] = None   # rescue unit id chosen by the citizen, e.g. "Bravo-02"
    location_source: str = "GPS"             # GPS (live location) | MANUAL

class StatusIn(BaseModel):
    status: str  # ACCEPTED | EN_ROUTE | ON_SCENE | EVACUATED | RESOLVED
    note: str = Field("", max_length=500)

class HazardIn(BaseModel):
    road_id: Optional[int] = None
    lat: Optional[float] = None
    lon: Optional[float] = None
    status: str = "SUBMERGED"
    water_depth_m: float = 0.5
    reporter: str = "Field Responder"


# ------------------------------------------------------------------ REST
@app.get("/api/v1/dashboard/telemetry")
def get_telemetry(_p=Depends(CTRL)):
    return telemetry_payload()


@app.get("/api/v1/dashboard/queue")
def get_queue(_p=Depends(CTRL)):
    return sorted((sos_out(fresh_score(s)) for s in S.sos.values() if s["status"] != "RESOLVED"),
                  key=lambda x: -x["priority_score"])


@app.get("/api/v1/units")
def get_units(_p=Depends(auth.principal)):
    if _p["role"] == auth.CONTROL:
        return list(S.units.values())
    return [dict(id=u["id"], name=u["name"], status=u["status"]) for u in S.units.values()]   # citizens only need the team list


@app.get("/api/v1/audit")
def get_audit(q: str = "", vtype: str = "", _p=Depends(CTRL)):
    rows = [r for r in store.read_audit(500) if (not q or q.lower() in json.dumps(r).lower()) and (not vtype or r["verification_type"] == vtype)]
    return list(reversed(rows))


@app.get("/api/v1/alerts")
def list_alerts(_p=Depends(CTRL)):
    return list(S.alerts.values())


@app.get("/api/v1/alerts/active")
def active_alert():
    done = [a for a in S.alerts.values() if a["status"] == "BROADCASTED"]
    return done[-1] if done else None


@app.get("/api/v1/gis/layers")
def gis_layers(_p=Depends(auth.principal)):
    risk = {c: current_risk(c) for c in SECTORS}
    heat = []
    for c, s in SECTORS.items():
        so, w, no, e = s["box"]
        heat.append(dict(type="Feature", properties=dict(sector=c, name=s["name"], risk_score=risk[c]["risk_score"],
                         severity=risk[c]["severity"], active_sos=sum(1 for x in active_sos() if x["sector"] == c)),
                         geometry=dict(type="Polygon", coordinates=[[[w, so], [e, so], [e, no], [w, no], [w, so]]])))
    shel = [dict(type="Feature", properties=dict(id=s["id"], name=s["name"], free_beds=s["total_beds"] - s["occupied_beds"],
                 total_beds=s["total_beds"], pct_free=round((1 - s["occupied_beds"] / s["total_beds"]) * 100), status=s["status"]),
                 geometry=dict(type="Point", coordinates=[NODES[s["node"]][1], NODES[s["node"]][0]])) for s in S.shelters]
    nid = {k: v for k, v in NODES.items()}
    roads = [dict(type="Feature", properties=dict(id=r["id"], name=r["name"], status=r["status"], water_depth_m=r["water_depth_m"]),
                  geometry=dict(type="LineString", coordinates=[[nid[r["from"]][1], nid[r["from"]][0]], [nid[r["to"]][1], nid[r["to"]][0]]]))
             for r in S.roads]
    blocked = [r for r in roads if r["properties"]["status"] != "SAFE"]
    corridors = []
    for s in active_sos():
        b = best_shelter_route(s["lat"], s["lon"])
        if b:
            (path, rids, m), sh, start = b
            corridors.append(dict(type="Feature", properties=dict(sos=s["id"], shelter=sh["name"], metres=round(m), sector=s["sector"]),
                                  geometry=dict(type="LineString", coordinates=geo.route_geometry(s["lat"], s["lon"], path, *NODES[sh["node"]]))))
    pins = [dict(type="Feature", properties=dict(id=s["id"], num=s["id"].split("-")[1], severity=s["severity"], status=s["status"],
                 sector=s["sector"], water_depth_m=s["water_depth_m"], citizen_name=s["citizen_name"]),
                 geometry=dict(type="Point", coordinates=[s["lon"], s["lat"]])) for s in active_sos()]
    fc = lambda f: dict(type="FeatureCollection", features=f)
    river = dict(type="Feature", properties=dict(name="Adyar River"), geometry=dict(type="LineString", coordinates=[[lo, la] for la, lo in RIVER]))
    out = dict(crs="EPSG:4326", flood_heatmap=fc(heat), shelters=fc(shel), roads=fc(roads), blocked_roads=fc(blocked),
                safe_corridors=fc(corridors), sos=fc(pins), river=river, units=list(S.units.values()))
    if _p["role"] != auth.CONTROL:   # no victim pins / unit positions for the public
        for k in ("sos", "safe_corridors"):
            out[k] = fc([])
        out["units"] = []
    return out


def evaluate(surge: bool):
    if surge:
        S.telemetry["prev_rainfall"] = S.telemetry["rainfall_mm_hr"]
        S.telemetry["rainfall_mm_hr"] = min(130, S.telemetry["rainfall_mm_hr"] + 12)
        S.telemetry["river_level_m"] = min(7.5, S.telemetry["river_level_m"] + 0.12)
        S.telemetry["rate_of_rise"] = min(0.6, S.telemetry["rate_of_rise"] + 0.06)
        S.telemetry["recorded_at"] = now()
    t = S.telemetry; r = current_risk()
    S.risks.append(dict(ward_id=14, created_at=now().isoformat(), **r))
    top = sorted(r["feature_contributions"].items(), key=lambda kv: -kv[1])[:3]
    audit("XGBoost Flood-Risk Engine",
          f"Ward 14 risk {r['risk_score']}/100 ({r['severity']}), confidence {r['xgboost_confidence']*100:.1f}%. "
          f"Top drivers: " + ", ".join(f"{k} +{v}" for k, v in top) + (" [SURGE TEST]" if surge else ""), "AI INFERENCE")
    alert = None
    if r["risk_score"] >= 80 and not any(a["status"] == "PENDING_APPROVAL" for a in S.alerts.values()):
        seq = S.next_id("alert")
        aid = f"NDMA-SACHET-W14-{now():%Y%m%d}-{seq:03d}"
        bodies = {l: cap.message(l, r["risk_score"], t["rainfall_mm_hr"], t["river_level_m"], t["danger_level_m"], t["rate_of_rise"])
                  for l in cap.LANGS}
        alert = dict(id=aid, cap_identifier=aid, status="PENDING_APPROVAL", severity=r["severity"], risk_score=r["risk_score"],
                     confidence=r["xgboost_confidence"], language="en", messages=bodies, target_polygon=cap.polygon_ward14(),
                     trigger_summary=(f"Recommended because: rainfall {t['rainfall_mm_hr']:.1f} mm/hr, Adyar gauge {t['river_level_m']:.2f} m vs "
                                      f"{t['danger_level_m']:.2f} m danger mark (+{t['rate_of_rise']:.2f} m/hr), composite risk {r['risk_score']}/100 "
                                      f"≥ 80 CRITICAL threshold. Advisory only – requires Duty Officer sign-off."),
                     approved_by=None, approved_at=None, created_at=now().isoformat())
        S.alerts[aid] = alert
        audit("CAP Generator", f"Draft CAP v1.2 alert {aid} created in EN/TA/HI; awaiting human approval (risk ≥ 80).", "AI INFERENCE")
    return r, alert


@app.post("/api/v1/ai/evaluate-risk")
async def evaluate_risk(body: Eval = Body(default_factory=Eval), _p=Depends(CTRL)):
    r, alert = evaluate(body.surge)
    await publish("telemetry", telemetry_payload())
    pending = alert or next((a for a in S.alerts.values() if a["status"] == "PENDING_APPROVAL"), None)
    if alert:
        await publish("alert_pending", alert)
    return dict(assessment=r, alert=pending, telemetry=telemetry_payload())


@app.post("/api/v1/alerts/{alert_id}/approve")
async def approve(alert_id: str, body: Approve, x_role: str = Header(default=""), _p=Depends(CTRL)):
    if auth.AUTH_ON:
        body.approved_by = _p["name"]
    a = S.alerts.get(alert_id)
    if not a:
        raise HTTPException(404, "alert not found")
    if not auth.AUTH_ON and x_role.upper() != "DUTY_OFFICER":
        raise HTTPException(403, "RBAC: only a District Duty Officer may approve broadcasts (send X-Role: DUTY_OFFICER)")
    if a["status"] == "BROADCASTED":
        raise HTTPException(409, "already broadcast")
    if body.language not in cap.LANGS:
        raise HTTPException(422, "language must be en/ta/hi")
    if body.message_body:
        a["messages"][body.language] = body.message_body
    a.update(status="BROADCASTED", approved_by=body.approved_by, approved_at=now().isoformat(), language=body.language,
             channels=body.channels)
    a["cap_json"] = {l: cap.build_cap_json(a["cap_identifier"], l, a["messages"][l]) for l in cap.LANGS}
    a["cap_xml"] = {l: cap.build_cap_xml(a["cap_identifier"], l, a["messages"][l]) for l in cap.LANGS}
    audit(body.approved_by, f"Approved & broadcast CAP v1.2 {alert_id} (primary {body.language.upper()}, channels "
          f"{'/'.join(body.channels)}); Ward 14 polygon geo-targeted." + (" Message edited by officer." if body.message_body else ""),
          "HUMAN APPROVED")
    await publish("alert", a)
    return a


@app.get("/api/v1/alerts/{alert_id}/cap.xml")
def cap_xml(alert_id: str, lang: str = "en"):
    a = S.alerts.get(alert_id)
    if not a:
        raise HTTPException(404)
    return Response(cap.build_cap_xml(a["cap_identifier"], lang, a["messages"][lang]), media_type="application/xml")


@app.post("/api/v1/sos")
async def post_sos(payload: Union[SosIn, List[SosIn]], request: Request):
    if not sos_rate_ok(client_ip(request)):
        raise HTTPException(429, "Too many requests from this network. Please wait a few minutes or call 1070 / 112.")
    items = payload if isinstance(payload, list) else [payload]
    out = []
    for p in items:
        if p.assigned_officer and p.assigned_officer not in S.units:
            raise HTTPException(422, f"unknown rescue officer/team '{p.assigned_officer}'")
        dup = next((s for s in S.sos.values() if (p.client_id and s["client_id"] == p.client_id) or
                    (s["citizen_name"] == p.citizen_name and s["status"] != "RESOLVED" and s.get("request_type") == p.request_type and
                     geo.haversine_m(s["lat"], s["lon"], p.lat, p.lon) < 50)), None)
        if dup:
            out.append(dict(sos_id=dup["id"], duplicate=True)); continue
        seq = S.next_id("sos")
        created = p.created_at or now()
        if created.tzinfo is None:
            created = created.replace(tzinfo=timezone.utc)
        tags = list(p.vulnerability_tags)
        if p.request_type == "Medical Emergency" and "Medical / Oxygen Need" not in tags:
            tags.append("Medical / Oxygen Need")
        s = dict(id=f"SOS-{seq}", client_id=p.client_id, citizen_name=p.citizen_name, household_size=p.household_size,
                 request_type=p.request_type, phone=p.phone, address=p.address, description=p.description,
                 assigned_officer=p.assigned_officer, location_source=p.location_source, officer_notes=[],
                 lat=p.lat, lon=p.lon, sector=geo.sector_of(p.lat, p.lon), water_depth_m=p.water_depth_m,
                 vulnerability_tags=tags, status="OPEN", assigned_unit_id=None,
                 synced_offline=p.synced_offline, created_at=created, route=None)
        s["priority_score"], s["severity"] = ai.triage(s["water_depth_m"], s["vulnerability_tags"], s["household_size"], created)
        S.sos[s["id"]] = s
        audit("SOS Triage Engine", f"{s['id']} [{s['request_type']}] from {s['citizen_name']} ({s['phone'] or 'no phone'}) ingested ({'offline sync' if p.synced_offline else 'live'})"
              f"{', assigned to ' + s['assigned_officer'] if s['assigned_officer'] else ''}: sector {s['sector']}, depth "
              f"{s['water_depth_m']} m, tags {p.vulnerability_tags or 'none'} → priority {s['priority_score']} ({s['severity']}).", "AI INFERENCE")
        await publish("sos", {**sos_out(s), "event": "new_request"})
        out.append(dict(sos_id=s["id"], duplicate=False, priority_score=s["priority_score"], severity=s["severity"]))
    return out if isinstance(payload, list) else out[0]


@app.post("/api/v1/sos/{sos_id}/dispatch")
async def dispatch(sos_id: str, x_role: str = Header(default=""), _p=Depends(CTRL)):
    s = S.sos.get(sos_id)
    if not s:
        raise HTTPException(404, "SOS not found")
    if s["status"] != "OPEN":
        raise HTTPException(409, f"SOS is {s['status']}")
    units = [u for u in S.units.values() if u["status"] == "AVAILABLE"]
    if not units:
        raise HTTPException(409, "no available responder units")
    # equivalent of: ORDER BY ST_Distance(unit.geog, sos.geog) LIMIT 1
    ranked = sorted(units, key=lambda u: geo.haversine_m(u["lat"], u["lon"], s["lat"], s["lon"]))
    route = None
    for u in ranked:
        for goal in sorted(NODES, key=lambda k: geo.haversine_m(s["lat"], s["lon"], *NODES[k]))[:3]:
            r = geo.safe_route(S.roads, geo.nearest_node(u["lat"], u["lon"]), goal)
            if r:
                route = (u, goal, r); break
        if route:
            break
    if not route:
        raise HTTPException(409, "no verified SAFE route to victim; boat/air asset required")
    u, goal, (path, rids, metres) = route
    names = [next(r["name"] for r in S.roads if r["id"] == i) for i in rids]
    dist_m = round(geo.haversine_m(u["lat"], u["lon"], s["lat"], s["lon"]))
    sh = best_shelter_route(s["lat"], s["lon"])
    s.update(status="DISPATCHED", assigned_unit_id=u["id"], route=dict(
        unit=u["id"], metres=round(metres + geo.haversine_m(*NODES[goal], s["lat"], s["lon"])), road_ids=rids, avoided=[r["name"] for r in S.roads if r["status"] != "SAFE"],
        geometry=dict(type="LineString", coordinates=geo.route_geometry(u["lat"], u["lon"], path, s["lat"], s["lon"])),
        steps=geo.turn_steps(path, names) + [f"Arrive at {s['id']} ({s['sector']}), depth {s['water_depth_m']} m"],
        shelter=(dict(name=sh[1]["name"], free=sh[1]["total_beds"] - sh[1]["occupied_beds"]) if sh else None)))
    u.update(status="BUSY", sos=s["id"])
    audit(_p["name"] if auth.AUTH_ON else (x_role or "Duty Officer"), f"Dispatched {u['id']} to {s['id']}: nearest available unit ({dist_m} m straight-line, ST_Distance); "
          f"safe route avoids {len(s['route']['avoided'])} submerged/blocked segments.", "HUMAN APPROVED")
    await publish("sos", {**sos_out(s), "event": "dispatched"}); await publish("unit", u)
    return sos_out(s)


@app.get("/api/v1/sos/{sos_id}/mission")
def mission(sos_id: str, _p=Depends(OFFR)):
    s = S.sos.get(sos_id)
    if not s:
        raise HTTPException(404)
    scope(_p, s)
    if s["status"] == "DISPATCHED" and not s["route"]:  # seed case: compute lazily
        u = S.units[s["assigned_unit_id"]]
        goal = geo.nearest_node(s["lat"], s["lon"])
        r = geo.safe_route(S.roads, geo.nearest_node(u["lat"], u["lon"]), goal)
        if r:
            path, rids, m = r
            names = [next(x["name"] for x in S.roads if x["id"] == i) for i in rids]
            sh = best_shelter_route(s["lat"], s["lon"])
            s["route"] = dict(unit=u["id"], metres=round(m), road_ids=rids, avoided=[x["name"] for x in S.roads if x["status"] != "SAFE"],
                              geometry=dict(type="LineString", coordinates=geo.route_geometry(u["lat"], u["lon"], path, s["lat"], s["lon"])),
                              steps=geo.turn_steps(path, names) + [f"Arrive at {s['id']} ({s['sector']}), depth {s['water_depth_m']} m"],
                              shelter=(dict(name=sh[1]["name"], free=sh[1]["total_beds"] - sh[1]["occupied_beds"]) if sh else None))
    return sos_out(s)


@app.post("/api/v1/sos/{sos_id}/status")
async def sos_status(sos_id: str, body: StatusIn, _p=Depends(OFFR)):
    s = S.sos.get(sos_id)
    if not s:
        raise HTTPException(404)
    scope(_p, s)
    label = {"ACCEPTED": "Accepted", "EN_ROUTE": "En Route", "ON_SCENE": "On Scene", "EVACUATED": "Evacuated to Shelter",
             "RESOLVED": "Resolved"}.get(body.status)
    if not label:
        raise HTTPException(422, "status must be ACCEPTED | EN_ROUTE | ON_SCENE | EVACUATED | RESOLVED")
    if s["status"] == "RESOLVED":
        raise HTTPException(409, "request already resolved")
    # an officer picking up a request assigned to them takes it over (no separate dispatch needed)
    if s["status"] == "OPEN" and s.get("assigned_officer") in S.units and body.status != "RESOLVED":
        u = S.units[s["assigned_officer"]]
        s.update(status="DISPATCHED", assigned_unit_id=u["id"])
        u.update(status="BUSY", sos=s["id"])
        await publish("unit", u)
    s["field_status"] = label
    if body.note.strip():
        s.setdefault("officer_notes", []).append(dict(at=now().isoformat(), by=s["assigned_unit_id"] or "Officer", text=body.note.strip()))
    if body.status in ("EVACUATED", "RESOLVED"):
        s["status"] = "RESOLVED"
        u = S.units.get(s["assigned_unit_id"])
        if u:
            u.update(status="AVAILABLE", sos=None)
            await publish("unit", u)
        b = best_shelter_route(s["lat"], s["lon"]) if body.status == "EVACUATED" else None
        if b:
            b[1]["occupied_beds"] = min(b[1]["total_beds"], b[1]["occupied_beds"] + s["household_size"])
    audit(_p["name"] if auth.AUTH_ON else (s["assigned_unit_id"] or s.get("assigned_officer") or "Responder"),
          f"{sos_id} status → {label}." + (f" Note: {body.note.strip()}" if body.note.strip() else ""), "VERIFIED")
    await publish("sos", {**sos_out(s), "event": "status_update", "note": body.note.strip()}); await publish("telemetry", telemetry_payload())
    return sos_out(s)


@app.get("/api/v1/officers/{unit_id}/requests")
def officer_requests(unit_id: str, include_resolved: bool = False, _p=Depends(OFFR)):
    """Inbox for a rescue officer/team: requests assigned to them (by the citizen or by dispatch), highest priority first."""
    if unit_id not in S.units:
        raise HTTPException(404, "unknown officer/team")
    if not auth.can_see_unit(_p, unit_id):
        raise HTTPException(403, "You can only open your own team's requests")
    rows = [s for s in S.sos.values() if unit_id in (s.get("assigned_officer"), s.get("assigned_unit_id"))
            and (include_resolved or s["status"] != "RESOLVED")]
    return sorted((sos_out(fresh_score(s)) for s in rows), key=lambda x: -x["priority_score"])


@app.post("/api/v1/roads/report")
async def report_hazard(h: HazardIn, _p=Depends(OFFR)):
    if h.status not in ("SAFE", "SUBMERGED", "BLOCKED"):
        raise HTTPException(422, "bad status")
    road = next((r for r in S.roads if r["id"] == h.road_id), None) if h.road_id else None
    if not road and h.lat is not None:  # nearest segment midpoint (ST_ClosestPoint equivalent)
        road = min(S.roads, key=lambda r: geo.haversine_m(h.lat, h.lon, (NODES[r["from"]][0] + NODES[r["to"]][0]) / 2,
                                                          (NODES[r["from"]][1] + NODES[r["to"]][1]) / 2))
    if not road:
        raise HTTPException(404, "road not found")
    road.update(status=h.status, water_depth_m=h.water_depth_m, updated_at=now())
    audit(_p["name"] if auth.AUTH_ON else h.reporter, f"Field hazard report: '{road['name']}' flagged {h.status} (depth {h.water_depth_m} m); routing graph updated.", "VERIFIED")
    await publish("road", dict(id=road["id"], name=road["name"], status=road["status"], water_depth_m=road["water_depth_m"]))
    return road


@app.get("/api/v1/roads")
def roads():
    return S.roads


class LoginIn(BaseModel):
    username: str = Field(max_length=60)
    password: str = Field(max_length=200)
    code: str = Field("", max_length=12)          # security key: 6-digit authenticator code
    portal: Optional[str] = Field(None, max_length=10)   # which access screen was used: control | officer | citizen


@app.get("/healthz")
def healthz():
    return {"ok": True}


@app.get("/api/v1/config")
def public_config():
    return dict(auth_required=auth.AUTH_ON, security_key_required=auth.AUTH_ON and auth.REQUIRE_2FA, app="Alert-Now.in", version="1.3", storage="redis" if isinstance(store.redis(), store.RestRedis) else "memory")


@app.post("/api/v1/auth/login")
def do_login(body: LoginIn, request: Request):
    r = auth.login(body.username.strip(), body.password, client_ip(request), body.code, body.portal)
    audit(r["name"], f"Signed in ({r['role']}{' / ' + r['unit'] if r['unit'] else ''}).", "VERIFIED")
    return r


@app.get("/api/v1/auth/me")
def whoami(_p=Depends(auth.principal)):
    return _p


@app.get("/api/v1/my-requests")
def my_requests(ids: str = ""):
    """citizen-safe status lookup for the request ids this device submitted (no names / phones / addresses)"""
    want = [i for i in ids.split(",") if i][:20]
    return [{k: v for k, v in sos_out(S.sos[i]).items() if k in PUBLIC_SOS_KEYS} for i in want if i in S.sos]


def tick():
    """refresh the simulated telemetry / unit positions (runs at most every ~15 s, triggered by whoever polls first)"""
    st = store.load()
    tok = store.use(st)
    try:
        advance_sim()
    finally:
        store.release(tok)
    store.flush(st)


@app.get("/api/v1/events")
async def events(since: int = -1, tick_sim: int = 0, _p=Depends(auth.principal)):
    """Polling replacement for the old WebSocket. First call (since=-1) just returns the cursor; afterwards pass the returned cursor.
    A quiet poll costs one Redis command. The Control Room passes tick_sim=1 about every 15 s to keep the simulated telemetry moving."""
    if tick_sim and _p["role"] == auth.CONTROL and await run_in_threadpool(store.tick_due):
        try:
            await run_in_threadpool(tick)
        except Exception:
            pass
    seq = await run_in_threadpool(store.event_seq)
    if since < 0:
        return dict(cursor=seq, events=[])
    if seq <= since:
        return dict(cursor=since, events=[])
    out = []
    for eid, kind, data, ts in await run_in_threadpool(store.read_events):
        if eid > since - 10:   # small look-back covers writers that committed out of order; clients de-duplicate by id
            v = view_for(kind, data, _p)
            if v is not None:
                out.append(dict(id=eid, type=kind, data=v, ts=ts))
    return dict(cursor=seq, events=out)


# static front-ends (same origin → no CORS / mixed-content trouble)
for _url, _dir in (("/mobile", "mobile"), ("/control", "web-dashboard"), ("/", "portal")):   # "/" last: it is the catch-all
    if (ROOT / _dir).exists():
        app.mount(_url, StaticFiles(directory=ROOT / _dir, html=True), name=_dir)

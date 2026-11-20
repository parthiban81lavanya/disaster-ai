"""alertNow - persistence for serverless hosting (Vercel).

Serverless functions keep no memory between calls, so every request:
  1. loads the working data from Redis (one pipelined HTTP call),
  2. runs the normal application logic on plain Python dicts,
  3. writes back only what changed (one more pipelined call) BEFORE the response is returned.

Redis is Upstash over its REST API (stdlib urllib, no extra dependency):
  UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN   (or KV_REST_API_URL / KV_REST_API_TOKEN, as set by the Vercel integration)
When none are set (local development) an in-process memory Redis is used so `uvicorn` still works with zero setup.

Layout (all keys prefixed by SHIELD_NS, default "ds"):
  ds:sos / units / roads / shelters / alerts   hash   id -> JSON document
  ds:meta                                      hash   telemetry, surge, last_sim
  ds:audit                                     list   append-only, hash-chained rows
  ds:events  + ds:event_seq                    list   live-event log the screens poll (replaces WebSockets)
  ds:seq:sos / ds:seq:alert                    string atomic id counters
"""
import json
import os
import time
import urllib.error
import urllib.request
from contextvars import ContextVar
from datetime import datetime, timedelta, timezone

from . import ai, geo
from .seed import RIVER, ROADS, SECTORS, SHELTERS, UNITS, sos_seed  # noqa: F401  (RIVER/SECTORS re-exported for convenience)

NS = os.getenv("SHIELD_NS", "ds") + ":"
now = lambda: datetime.now(timezone.utc)
AUDIT_KEEP, EVENT_KEEP = 3000, 300


# ------------------------------------------------------------------ JSON that round-trips datetimes
def _default(o):
    if isinstance(o, datetime):
        return {"$dt": o.isoformat()}
    raise TypeError(f"not JSON serialisable: {type(o)}")


def _hook(d):
    if len(d) == 1 and "$dt" in d:
        return datetime.fromisoformat(d["$dt"])
    return d


def dumps(v) -> str:
    return json.dumps(v, default=_default, separators=(",", ":"))


def loads(s):
    return json.loads(s, object_hook=_hook)


# ------------------------------------------------------------------ Redis back-ends
class MemRedis:
    """Tiny in-process stand-in implementing just the commands this app uses (local dev + tests)."""

    def __init__(self):
        self.d, self.exp = {}, {}

    def _alive(self, k):
        if k in self.exp and self.exp[k] <= time.time():
            self.d.pop(k, None); self.exp.pop(k, None)
        return k in self.d

    def execute(self, cmds):
        return [self._one(c) for c in cmds]

    def _one(self, c):
        op, a = c[0].upper(), [str(x) for x in c[1:]]
        d = self.d
        if op == "GET":
            return d.get(a[0]) if self._alive(a[0]) else None
        if op == "SET":
            k, v, opts = a[0], a[1], [x.upper() for x in a[2:]]
            if "NX" in opts and self._alive(k):
                return None
            d[k] = v; self.exp.pop(k, None)
            if "EX" in opts:
                self.exp[k] = time.time() + int(a[[x.upper() for x in a].index("EX") + 1])
            return "OK"
        if op in ("INCR", "INCRBY"):
            n = int(a[1]) if op == "INCRBY" else 1
            d[a[0]] = str(int(d.get(a[0], 0) if self._alive(a[0]) else 0) + n)
            return int(d[a[0]])
        if op == "EXPIRE":
            self.exp[a[0]] = time.time() + int(a[1]); return 1
        if op == "DEL":
            n = 0
            for k in a:
                n += 1 if d.pop(k, None) is not None else 0; self.exp.pop(k, None)
            return n
        if op == "HSET":
            h = d.setdefault(a[0], {}); n = 0
            for i in range(1, len(a), 2):
                n += a[i] not in h; h[a[i]] = a[i + 1]
            return n
        if op == "HGET":
            return d.get(a[0], {}).get(a[1])
        if op == "HGETALL":
            return [x for kv in d.get(a[0], {}).items() for x in kv]
        if op == "RPUSH":
            l = d.setdefault(a[0], []); l.extend(a[1:]); return len(l)
        if op == "LLEN":
            return len(d.get(a[0], []))
        if op == "LRANGE":
            l, s, e = d.get(a[0], []), int(a[1]), int(a[2])
            s = max(len(l) + s, 0) if s < 0 else s
            e = len(l) + e if e < 0 else e
            return l[s:e + 1]
        if op == "LTRIM":
            l, s, e = d.get(a[0], []), int(a[1]), int(a[2])
            s = max(len(l) + s, 0) if s < 0 else s
            e = len(l) + e if e < 0 else e
            d[a[0]] = l[s:e + 1]; return "OK"
        raise NotImplementedError(op)


class RestRedis:
    """Upstash Redis over HTTPS: POST {url}/pipeline with a JSON array of commands."""

    def __init__(self, url, token):
        self.url, self.token = url.rstrip("/"), token

    def execute(self, cmds):
        req = urllib.request.Request(self.url + "/pipeline", data=json.dumps(cmds).encode(), method="POST",
                                     headers={"Authorization": "Bearer " + self.token, "Content-Type": "application/json"})
        last = None
        for attempt in range(2):
            try:
                with urllib.request.urlopen(req, timeout=8) as r:
                    res = json.loads(r.read())
                break
            except urllib.error.HTTPError as e:   # 4xx/5xx: do not retry blindly (writes are not idempotent)
                raise RuntimeError(f"Upstash HTTP {e.code}: {e.read()[:200]!r}")
            except (urllib.error.URLError, TimeoutError) as e:
                last = e
                if attempt:
                    raise RuntimeError(f"Upstash unreachable: {last}")
        out = []
        for x in res:
            if x.get("error"):
                raise RuntimeError("Upstash: " + x["error"])
            out.append(x.get("result"))
        return out


def _make_redis():
    url = os.getenv("UPSTASH_REDIS_REST_URL") or os.getenv("KV_REST_API_URL")
    tok = os.getenv("UPSTASH_REDIS_REST_TOKEN") or os.getenv("KV_REST_API_TOKEN")
    if url and tok:
        return RestRedis(url, tok)
    if os.getenv("VERCEL"):
        raise RuntimeError("Redis is not configured. Add the Upstash Redis integration (or set UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN).")
    return MemRedis()


_redis = None


def redis():
    global _redis
    if _redis is None:
        _redis = _make_redis()
    return _redis


class RateLimiter:
    """Shared (cross-instance) counters for login throttling and the public form."""

    def count(self, key) -> int:
        return int(redis().execute([["GET", NS + "rl:" + key]])[0] or 0)

    def hit(self, key, ttl) -> int:
        return int(redis().execute([["INCR", NS + "rl:" + key], ["EXPIRE", NS + "rl:" + key, ttl]])[0])

    def clear(self, key):
        redis().execute([["DEL", NS + "rl:" + key]])


# ------------------------------------------------------------------ working state (one per request)
COLLECTIONS = ("sos", "units", "roads", "shelters", "alerts")


def _entities(st, name):
    v = getattr(st, name)
    return ((str(e["id"]), e) for e in v) if isinstance(v, list) else v.items()


class State:
    def __init__(self):
        self.telemetry = {}
        self.surge = 0.0
        self.last_sim = None
        self.roads, self.shelters = [], []
        self.units, self.sos, self.alerts = {}, {}, {}
        self.risks = []                 # per-request scratch (not persisted)
        self.audit_last, self.audit_count, self.audit_new = None, 0, []
        self.events = []                # (kind, data, ts) published during this request
        self._orig = {}

    @staticmethod
    def fresh():
        st = State()
        st.telemetry = dict(rainfall_mm_hr=84.5, river_level_m=6.82, danger_level_m=7.20, rate_of_rise=0.24, prev_rainfall=67.0, recorded_at=now())
        st.last_sim = now()
        st.roads = [dict(id=i, name=n, **{"from": a, "to": b}, status=s, water_depth_m=d, updated_at=now()) for i, n, a, b, s, d in ROADS]
        st.shelters = [dict(id=i, name=n, node=node, total_beds=t, occupied_beds=o, status="READY") for i, n, node, t, o in SHELTERS]
        st.units = {u[0]: dict(id=u[0], name=u[1], lat=u[2], lon=u[3], status=u[4], sos=None) for u in UNITS}
        for s in sos_seed():
            s["sector"] = geo.sector_of(s["lat"], s["lon"]); s["route"] = None; s["client_id"] = None
            s.update(request_type="Flood Rescue", phone="", address="", description="", assigned_officer=s.get("assigned_unit_id"),
                     location_source="GPS", officer_notes=[])
            s["priority_score"], s["severity"] = ai.triage(s["water_depth_m"], s["vulnerability_tags"], s["household_size"], s["created_at"])
            st.sos[s["id"]] = s
        st.sos["SOS-103"]["route"] = None
        return st

    def next_id(self, name) -> int:
        """atomic counter shared by every instance (no duplicate SOS ids under concurrent submissions)"""
        return int(redis().execute([["INCR", NS + "seq:" + name]])[0])

    def publish(self, kind, data):
        self.events.append((kind, data, now().isoformat()))


class _Proxy:
    """`S` behaves like the old global store but resolves to the current request's State."""
    def __getattr__(self, k):
        return getattr(_cur.get(), k)

    def __setattr__(self, k, v):
        setattr(_cur.get(), k, v)


_cur: ContextVar = ContextVar("shield_state")
S = _proxy = _Proxy()


def use(st):
    return _cur.set(st)


def release(tok):
    _cur.reset(tok)


def _hgetall(flat):
    flat = flat or []
    return {flat[i]: flat[i + 1] for i in range(0, len(flat), 2)}


seed_hook = None   # set by main: runs the first-time audits + risk evaluation on the fresh state


def load() -> State:
    r = redis()
    res = r.execute([["GET", NS + "seeded"], *[["HGETALL", NS + c] for c in COLLECTIONS], ["HGETALL", NS + "meta"],
                     ["LRANGE", NS + "audit", -1, -1], ["LLEN", NS + "audit"]])
    if not res[0]:
        _seed_once()
        return load()
    st = State()
    for c, raw in zip(COLLECTIONS, res[1:6]):
        docs = {k: loads(v) for k, v in _hgetall(raw).items()}
        if c in ("roads", "shelters"):
            setattr(st, c, sorted(docs.values(), key=lambda e: e["id"]))
        else:
            setattr(st, c, docs)
    meta = _hgetall(res[6])
    st.telemetry = loads(meta["telemetry"]); st.surge = float(meta.get("surge", 0)); st.last_sim = datetime.fromisoformat(meta["last_sim"]) if meta.get("last_sim") else None
    st.audit_last = loads(res[7][0]) if res[7] else None
    st.audit_count = int(res[8] or 0)
    st._orig = {c: {k: dumps(e) for k, e in _entities(st, c)} for c in COLLECTIONS}
    st._orig["meta"] = dict(telemetry=dumps(st.telemetry), surge=str(st.surge), last_sim=st.last_sim.isoformat() if st.last_sim else "")
    return st


def flush(st: State) -> int:
    """write back changed documents, new audit rows and published events. Returns number of commands sent."""
    r = redis()
    cmds = []
    for c in COLLECTIONS:
        orig, changed = st._orig.get(c, {}), []
        for k, e in _entities(st, c):
            j = dumps(e)
            if orig.get(k) != j:
                changed += [k, j]
        if changed:
            cmds.append(["HSET", NS + c, *changed])
    meta = dict(telemetry=dumps(st.telemetry), surge=str(st.surge), last_sim=st.last_sim.isoformat() if st.last_sim else "")
    mchanged = [x for k, v in meta.items() if st._orig.get("meta", {}).get(k) != v for x in (k, v)]
    if mchanged:
        cmds.append(["HSET", NS + "meta", *mchanged])
    if st.audit_new:
        cmds += [["RPUSH", NS + "audit", *[dumps(x) for x in st.audit_new]], ["LTRIM", NS + "audit", -AUDIT_KEEP, -1]]
    if st.events:
        n = len(st.events)
        last = int(r.execute([["INCRBY", NS + "event_seq", n]])[0])      # reserve ids first so they are strictly increasing
        rows = [dumps([last - n + 1 + i, k, d, ts]) for i, (k, d, ts) in enumerate(st.events)]
        cmds += [["RPUSH", NS + "events", *rows], ["LTRIM", NS + "events", -EVENT_KEEP, -1]]
    if cmds:
        r.execute(cmds)
    st._orig = {c: {k: dumps(e) for k, e in _entities(st, c)} for c in COLLECTIONS}
    st._orig["meta"] = meta
    st.audit_count += len(st.audit_new); st.audit_new = []; st.events = []
    return len(cmds)


def _seed_once():
    """first request ever: build the demo dataset exactly once even if several instances start together"""
    r = redis()
    if r.execute([["SET", NS + "seed_lock", "1", "NX", "EX", 30]])[0] != "OK":
        for _ in range(40):                       # someone else is seeding: wait for them
            time.sleep(0.25)
            if r.execute([["GET", NS + "seeded"]])[0]:
                return
        raise RuntimeError("seeding did not finish")
    st = State.fresh()
    tok = use(st)
    try:
        if seed_hook:
            seed_hook()
        st.last_sim = now()
        flush(st)
    finally:
        release(tok)
    r.execute([["SET", NS + "seq:sos", 104, "NX"], ["SET", NS + "seq:alert", 0, "NX"], ["SET", NS + "seeded", "1"]])


def read_audit(limit=500):
    rows = redis().execute([["LRANGE", NS + "audit", -limit, -1]])[0] or []
    return [loads(x) for x in rows]


def event_seq() -> int:
    return int(redis().execute([["GET", NS + "event_seq"]])[0] or 0)


def read_events():
    return [loads(x) for x in (redis().execute([["LRANGE", NS + "events", -EVENT_KEEP, -1]])[0] or [])]


def tick_due(seconds=14) -> bool:
    """True for exactly one caller per `seconds` (shared across instances) when the simulation is stale"""
    res = redis().execute([["HGET", NS + "meta", "last_sim"], ["SET", NS + "tick_lock", "1", "NX", "EX", seconds]])
    stale = not res[0] or (now() - datetime.fromisoformat(res[0])).total_seconds() > 15
    return stale and res[1] == "OK"

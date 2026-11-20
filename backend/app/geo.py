"""Geo helpers: haversine, sector lookup, safe routing (Dijkstra that skips SUBMERGED/BLOCKED roads).
In PostGIS mode these map to ST_Distance / ST_Contains / pgRouting; see db/queries.sql."""
import heapq
import math

from .seed import SECTORS, NODES


def haversine_m(lat1, lon1, lat2, lon2):
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def sector_of(lat, lon):
    for code, s in SECTORS.items():
        south, west, north, east = s["box"]
        if south <= lat < north and west <= lon < east:
            return code
    return "E"  # clamp to the lowland basin if outside grid


def nearest_node(lat, lon, only=None):
    cands = [(haversine_m(lat, lon, *ll), k) for k, ll in NODES.items() if only is None or k in only]
    return min(cands)[1]


def safe_route(roads, start, goal):
    """roads: list of dicts {id,from,to,status}. Returns (node_path, road_ids, metres) or None."""
    adj = {}
    for r in roads:
        if r["status"] != "SAFE":
            continue
        d = haversine_m(*NODES[r["from"]], *NODES[r["to"]])
        adj.setdefault(r["from"], []).append((r["to"], d, r["id"]))
        adj.setdefault(r["to"], []).append((r["from"], d, r["id"]))
    pq, best, prev = [(0.0, start)], {start: 0.0}, {}
    while pq:
        d, u = heapq.heappop(pq)
        if u == goal:
            break
        if d > best.get(u, 1e18):
            continue
        for v, w, rid in adj.get(u, []):
            nd = d + w
            if nd < best.get(v, 1e18):
                best[v] = nd
                prev[v] = (u, rid)
                heapq.heappush(pq, (nd, v))
    if goal not in best:
        return None
    path, rids, cur = [goal], [], goal
    while cur != start:
        cur, rid = prev[cur][0], prev[cur][1]
        rids.append(rid)
        path.append(cur)
    path.reverse(); rids.reverse()
    return path, rids, best[goal]


def route_geometry(lat0, lon0, path, lat1, lon1):
    """GeoJSON-order [lon, lat] coordinates: origin -> hubs -> destination."""
    pts = [[lon0, lat0]] + [[NODES[n][1], NODES[n][0]] for n in path] + [[lon1, lat1]]
    return pts


def turn_steps(path, road_names):
    steps = []
    for i, rn in enumerate(road_names):
        steps.append(f"Continue on {rn} toward hub {path[i + 1]} (verified SAFE)")
    return steps

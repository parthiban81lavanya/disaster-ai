-- PostGIS equivalents of the Python geo helpers used by the API.

-- Nearest AVAILABLE responder to an SOS (POST /sos/{id}/dispatch):
SELECT u.id, ST_Distance(u.location, s.location) AS metres
FROM responder_units u, sos_beacons s
WHERE s.id = $1 AND u.status = 'AVAILABLE'
ORDER BY u.location <-> s.location LIMIT 1;

-- Safe-route graph (pgRouting): exclude flooded segments
-- SELECT * FROM pgr_dijkstra(
--   'SELECT id, source, target, ST_Length(geom) AS cost FROM road_segments WHERE status = ''SAFE''', $src, $dst);

-- Snap a field hazard report to the nearest road segment:
SELECT id FROM road_segments ORDER BY geom <-> ST_MakePoint($lon, $lat)::geography LIMIT 1;

-- SOS beacons inside a CAP alert polygon (geo-targeted delivery):
SELECT s.id FROM sos_beacons s JOIN cap_alerts a ON ST_Covers(a.target_polygon, s.location)
WHERE a.cap_identifier = $1;

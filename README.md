# DisasterShield AI – Ward 14, Adyar Basin (Chennai)

```
backend/        FastAPI API + AI (risk scoring, triage) + CAP v1.2 + WebSocket; serves both UIs
  app/            main.py (endpoints), ai.py, cap.py, geo.py (routing), seed.py
  db/migrations/  001_schema.sql (PostGIS + GIST indexes + append-only hash-chained audit), 002_seed.sql
  db/queries.sql  PostGIS equivalents of the Python spatial logic (ST_Distance, pgRouting)
web-dashboard/  Control Room (Tailwind + Leaflet, no build step)
mobile/         Citizen + Field Responder offline-first PWA (service worker, local action queue)
docker-compose.yml  PostGIS + Redis
```

## Run
```
cd backend
pip install -r requirements.txt        # optional: pip install xgboost numpy
python -m uvicorn app.main:app --port 8000
```
- Control Room: http://localhost:8000/  (Field Responder / Citizen tabs embed the mobile app)
- Mobile (open on a phone-sized window): http://localhost:8000/mobile/
- API docs: http://localhost:8000/docs

## Demo flow
1. Dashboard shows a pending CAP alert (risk ≥ 80). Switch language tabs, edit text, **Approve & Broadcast** (sends `X-Role: DUTY_OFFICER`).
2. Citizen tab receives the alert live in the chosen language; "Navigate to Nearest Safe Shelter".
3. Citizen: "Simulate loss of cellular data" → Send SOS → queued locally → restore → batch-synced, deduplicated, appears in triage queue.
4. Dispatch Nearest Responder on SOS-104 → safe route (skips SUBMERGED/BLOCKED roads) → Field Responder tab shows mission; one-tap status; flag a flooded road.
5. Surge Test raises rainfall/river rate and re-runs the model; Audit Log records every step.

## Honest scope notes
- **Store:** the API runs on an in-memory store seeded identically to `002_seed.sql` so it runs with zero infrastructure. The PostGIS schema/seed/queries are provided and tested only as SQL text, not wired to the API yet (swap `Store` for a psycopg repository).
- **Mobile:** delivered as an offline-first PWA rather than Expo/Flutter (no Node toolchain was available). The queue contract (`POST /sos` batch, idempotent `client_id`) is what a native SQLite/WatermelonDB client would reuse.
- **Dashboard:** plain HTML/JS instead of Next.js, for the same reason.
- **AI:** risk score is an explainable weighted model; XGBoost (if installed) is trained on synthetic data and supplies the confidence. It is not trained on real flood data.
- **Dispatch/channels:** SMS/IVR/Push are simulated via WebSocket + audit entries; RBAC is a header check, not real auth. Routing uses a small 7-node road graph.
- Map tiles use public OSM servers; the mobile app pre-caches ~100 tiles only.

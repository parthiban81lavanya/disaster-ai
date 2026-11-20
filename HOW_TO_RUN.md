# How to Run alertNow and See the Results

## 1. Requirements
- Python 3.10+ (check with `python --version`)
- A web browser (Chrome or Edge)
- No database, Node.js or Docker needed. The app runs on an in-memory store.

## 2. Start the server
Open PowerShell and run:

```powershell
cd C:\Users\USER\Documents\Lithu\Proj_SIH\backend
pip install -r requirements.txt
python -m uvicorn app.main:app --port 8000
```

Success looks like this:
```
INFO:     Uvicorn running on http://127.0.0.1:8000
```
Keep this window open. Press `Ctrl+C` to stop the server.

Optional: `pip install xgboost numpy` turns on the XGBoost confidence model.

## 3. Open the app
| What | URL |
|---|---|
| Access screen (pick Citizen, Rescue Officer or Control Room) | http://localhost:8000/ |
| Control Room (dashboard) | http://localhost:8000/control/ |
| Citizen help request (phone-sized window) | http://localhost:8000/mobile/?role=citizen |
| Rescue Officer app | http://localhost:8000/mobile/?role=officer |
| API docs (Swagger, try endpoints live) | http://localhost:8000/docs |

## 4. Walk through the demo (what you should see)
**A. Citizen raises a request** (http://localhost:8000/ then **Citizen**, or http://localhost:8000/mobile/?role=citizen)
1. Choose the type (Flood Rescue, Medical Emergency, Food & Water, Shelter, Trapped, Other).
2. Enter name, phone number and address or landmark, or click **Use my live location**.
3. Describe the situation and pick the **rescue team / officer** to assign it to.
4. Click **SUBMIT HELP REQUEST**. It shows under **My requests** with its live status.

**B. Rescue officer acts on it** (http://localhost:8000/ then **Rescue Officer**)
1. Select the same team or officer, for example Bravo-02.
2. The request appears under **Assigned requests** with the name, tap-to-call phone, address, location, details and priority. A **Navigate** link opens the route in Google Maps.
3. Add an optional note, then tap **Accept**, **En Route**, **On Scene**, **Evacuated to Shelter** or **Mark Resolved**.

**C. Control Room sees everything** (http://localhost:8000/control/)
- The request appears at once in **Citizen Help Requests & Triage Queue** with all the details, the assigned officer, the live status and the officer notes. A pin shows on the map.
- Every step is logged in the Audit Log.

**D. Notifications (pop-up and voice)**
- A pop-up card appears in the top-right corner of the Control Room and the mobile app. It shows when a new request is submitted and each time an officer acts on one. Hover to keep it open, click to dismiss.
- Control Room: every new request and every action.
- Rescue Officer: new requests assigned to the selected team, and dispatch orders.
- Citizen: "request received", and each status change on their own request.
- A spoken announcement and a short sound play with each pop-up. Use the **Voice on / Voice off** button in the header to switch them off. Browsers only allow sound after you have clicked or tapped on the page once.

**E. Search any location for live data** (search bar above the map on the Control Room, and on the citizen screen)
- Type a city, area, landmark or `lat, lon`. The map moves there and the screen shows live rainfall, river flow and an indicative flood risk. Ward 14 is simulated and labelled so. Press **Ward 14** to go back.
- On the citizen screen, **Use this place for my help request** fills in the address and location.

**F. Sign-in** (only when the server runs with `AUTH_MODE=on`; see DEPLOYMENT.md)
- Rescue officers and the control room sign in with a username, password and a 6-digit **security key** from an authenticator app. Citizens can ask for help without signing in.

**Other features**
- Approve and broadcast the CAP alert, run a Surge Test, dispatch with a safe route, and the offline queue (**Simulate loss of cellular data**) all still work.

## 5. Check the API directly (optional)
In a second PowerShell window:

```powershell
# Live telemetry
curl http://localhost:8000/api/v1/dashboard/telemetry
# Active alerts
curl http://localhost:8000/api/v1/alerts/active
# Triage queue
curl http://localhost:8000/api/v1/dashboard/queue
# Audit trail
curl http://localhost:8000/api/v1/audit
```
Each call returns JSON. For the CAP XML of an alert, open `/api/v1/alerts/{alert_id}/cap.xml` in the browser.
Write endpoints need a role header, for example `X-Role: DUTY_OFFICER`. Swagger at `/docs` lets you test them.

## 6. Troubleshooting
| Problem | Fix |
|---|---|
| `python` not found | Install Python and tick "Add to PATH", or try `py -m uvicorn ...`. |
| `No module named uvicorn` | Re-run `pip install -r requirements.txt`. |
| Port 8000 already in use | Use another port, such as `--port 8001`, and change the URLs to match. |
| Blank map | The map tiles come from OpenStreetMap, so check your internet connection. |
| Data looks reset | The store is in memory. Restarting the server restores the seed data. |

## 7. Deploy for other people (Vercel + Upstash Redis, Docker or Cloud Run) with sign-in
See **DEPLOYMENT.md**. It covers Vercel with Upstash Redis (serverless, data kept), Docker and Cloud Run, plus user accounts and roles (citizen, rescue officer, control room).

## 8. Optional: PostGIS and Redis
`docker compose up -d` (from the project root) starts PostGIS and Redis. The SQL schema, seed data and queries are in `backend/db/`. The API is not wired to them yet, so you don't need them to run the demo.



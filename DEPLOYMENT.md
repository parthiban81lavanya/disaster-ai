# Deploying alertNow

| Option | Use it for | Sign-in | Data kept in |
|---|---|---|---|
| **1. Local (Python)** | Development and demos on your PC | Off by default | Memory (lost on restart) |
| **2. Vercel + Upstash Redis (serverless)** | Shared use by everyone with permission | **On** | **Upstash Redis (survives restarts)** |
| 3. Docker / Cloud Run | Alternative hosting | Optional | Memory, or Redis if configured |

## How it works on Vercel
- The **screens** (`public/`) are static files served from Vercel's CDN.
- The **API** is one Python serverless function (`api/index.py`) that runs the FastAPI app.
- **Data** lives in **Upstash Redis**. Every API call loads what it needs, runs, and saves only what changed before it answers, so any number of function instances can run side by side.
- **Live updates** (new-request and status pop-ups, voice alerts, the live queue) come from a small event log in Redis. Each screen asks for new events every 4 seconds (30 seconds when its tab is hidden). Vercel functions do not support WebSockets, so a notification can arrive up to about 4 seconds after the action.
- The **risk and telemetry simulation** advances whenever someone uses the app, and the Control Room screen refreshes it about every 15 seconds. There is no background process.

## Access screens
Open the site root `/`. It shows one access screen per type of user:

| Screen | Address after sign-in | How to get in |
|---|---|---|
| **Citizen** | `/mobile/?role=citizen` | **Emergency guest access, no sign-in**, so nobody is blocked while asking for help. Registered citizens can also sign in. |
| **Rescue Officer** | `/mobile/?role=officer` | Username + password + **security key** |
| **Control Room** | `/control/` | Username + password + **security key** |

The **security key** is a 6-digit code from an authenticator app (Google Authenticator, Microsoft Authenticator, Authy and similar). It changes every 30 seconds and each code works once, so a password alone is not enough to get in. Choosing the wrong screen for an account is refused. With `AUTH_MODE=off` (local demo) the screens open directly.

## Live data for any location
The Control Room and the citizen app have a **search bar**. Type a city, an area, a landmark or coordinates (for example `13.05, 80.25`). The map moves there and the screen shows **live** rainfall (last hour, past and next 24 hours), temperature, humidity, wind, river flow and an indicative flood-risk level, plus the number of open requests within 25 km.
- **Ward 14 (Adyar)** is the pilot ward. Its values are **simulated demo data** and are labelled SIMULATED. Any searched place shows LIVE data. The **Ward 14** button returns to the pilot.
- Sources: Open-Meteo (weather forecast and the GloFAS river-discharge model) and OpenStreetMap Nominatim for place names. Open-Meteo's free service is for non-commercial use, and OpenStreetMap's servers are for light use only. A commercial or heavy-use deployment needs a paid plan or another provider.
- The risk level is an **indicative rule of thumb** (IMD 24-hour rainfall classes, peak rainfall intensity and river-flow trend). It is not an official IMD, CWC or NDMA warning.
- The place you search for is sent from the user's browser to these services. Nothing from your database is sent.

## Who can do what (when sign-in is on)
| Role | How they get in | Can do |
|---|---|---|
| **Citizen** | No account (guest), or a registered account | Submit a help request, see the status of their own requests, read alerts and shelters. Never sees anyone else's name, phone or address. |
| **Rescue officer** | Account tied to one team (for example Bravo-02) | Rescue Officer tab at `/mobile/`. Sees and acts only on that team's requests. |
| **Control room** | Account with the CONTROL_ROOM role | Open `/`. Sees everything, approves alerts, dispatches, reads the audit log. |

Passwords are stored as PBKDF2 hashes, sessions expire after 12 hours, 5 wrong passwords lock a login for 5 minutes (counted in Redis, so it holds across all instances), the public form is rate-limited per IP, and live events are filtered by role.

## Create the user accounts (once)
```powershell
cd backend
python -m app.auth init                        # makes users.json: control, alpha04, bravo02, charlie07
python -m app.auth add asha CONTROL_ROOM       # add a control-room user (asks for a password)
python -m app.auth add ravi OFFICER Bravo-02   # add an officer for team Bravo-02
```
`init` prints a random password and a **setup key** for each account, **once**. In the authenticator app choose "Enter a setup key", type the key, and name it DisasterShield. The app then shows the 6-digit security key. Write the passwords down and give each person only their own details. For a registered citizen account use `python -m app.auth add NAME CITIZEN`.
To lose a phone safely: run `python -m app.auth add` again for that user (it issues a new password and a new setup key), update `SHIELD_USERS`, and redeploy. For a quick check on your own machine, `python -m app.auth code control` prints the current code. `users.json` is git-ignored: never commit it. To remove someone, delete them from `users.json`, update the `SHIELD_USERS` variable and redeploy.

## 1. Local (Python)
```powershell
cd backend
pip install -r requirements.txt
python -m uvicorn app.main:app --port 8000
```
Open http://localhost:8000/. No Redis needed (it uses an in-process store). To run locally against a real Upstash database, set `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` first. To try sign-in locally, also set `AUTH_MODE=on`, `SHIELD_SECRET=<16+ random characters>` and `SHIELD_USERS` (the contents of `users.json`), or leave `users.json` in `backend/`.

## 2. Vercel + Upstash Redis

### Steps (browser only, no command line tools needed)
1. **Create the accounts** as above and keep `users.json` safe.
2. **Build the static site** (do this again whenever you change a screen):
   ```powershell
   python deploy/make_public.py
   ```
3. **Put the project on GitHub** (a private repository is fine). Run this inside `Proj_SIH`, and make sure `backend/users.json` is not included (`.gitignore` already excludes it):
   ```powershell
   git init; git add .; git commit -m "alertNow"
   ```
   Then create an empty repository on github.com and push to it as GitHub shows you.
4. **Import it in Vercel:** vercel.com, Add New, Project, pick the repository. Leave **Framework Preset = Other** and the build settings empty. Deploy. (The API will answer 503 until step 5 is done.)
5. **Add the database:** in your Vercel project open **Storage** (Marketplace), choose **Upstash Redis**, create a database in the **Mumbai (ap-south-1)** region and connect it to the project. Vercel adds `KV_REST_API_URL` and `KV_REST_API_TOKEN` automatically, and the app reads them.
6. **Add the environment variables** (Settings, Environment Variables, tick Production). Mark the secret ones as Sensitive:

   | Name | Value |
   |---|---|
   | `AUTH_MODE` | `on` |
   | `SHIELD_SECRET` | a random string of 32+ characters |
   | `SHIELD_USERS` | the whole contents of `backend/users.json` (it holds the security keys, so mark it Sensitive) |

7. **Redeploy** (Deployments, the latest one, Redeploy). Open your Vercel URL:
   - `/` is the access screen. Staff choose Rescue Officer or Control Room and sign in.
   - `/control/` is the Control Room, `/mobile/?role=citizen` the citizen help-request app and `/mobile/?role=officer` the officer app.
   - `/healthz` should answer `{"ok": true}`.

The first request after a fresh database loads the demo data (3 sample requests, units, shelters, roads) once.

### Command-line alternative
Install Node.js, then `npm i -g vercel`, `vercel login`, `vercel link`, add the same variables with `vercel env add NAME production`, and `vercel deploy --prod`. Add the Upstash database from the Marketplace in the dashboard as in step 5.

### Costs and limits to know about
- **Vercel Hobby is for personal, non-commercial use.** An organisation or a real emergency service should use a paid plan. Check Vercel's current terms.
- **Upstash charges per command** after its free allowance. A quiet screen costs one command per poll, about 900 commands per hour per open screen at the 4-second rate. A handful of staff on screen all day can pass the free monthly allowance, so use a pay-as-you-go database and set a budget alert. Check Upstash's current pricing and limits.
- **Hidden tabs** poll every 30 seconds, and the mobile app embedded inside the Control Room polls every 8 seconds.
- **Serverless function memory is not shared.** That is why everything shared goes through Redis. Do not add global variables for shared data.
- **Cold starts:** the first request after a quiet period can take a second or two longer.
- **Audit log under heavy load:** if two audit entries are written in the same millisecond on different instances, they may chain from the same previous entry. This does not lose data. For a legally strict audit trail, write audit rows through a Redis script or a Postgres table.
- **Reset the demo data:** in the Upstash console run `FLUSHDB` (or set a new `SHIELD_NS` value). The data is rebuilt on the next request.
- **SMS, IVR and push** are still simulated. Real delivery needs a provider such as Twilio or Amazon SNS.

## 3. Docker and Google Cloud Run
The same image still works:
```powershell
docker compose up --build app                # http://localhost:8000
.\deploy\cloudrun.ps1 -Project YOUR_PROJECT_ID
```
Without Redis variables it keeps data in memory, so the Cloud Run script pins it to one instance. If you also set `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`, data persists and you can raise `--max-instances`.

## Environment variables
| Variable | Meaning |
|---|---|
| `AUTH_MODE` | `off` (default) or `on` |
| `SHIELD_SECRET` | Signing key for sessions, at least 16 characters (required when `on`) |
| `SHIELD_USERS` | JSON of users, same content as `users.json` (or use `SHIELD_USERS_FILE`) |
| `SHIELD_TOKEN_HOURS` | Session length, default 12 |
| `SHIELD_REQUIRE_2FA` | Security key required at sign-in. Default on. Set to `0` only for testing |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | Redis connection (`KV_REST_API_URL` / `KV_REST_API_TOKEN` also work) |
| `SHIELD_NS` | Key prefix, default `ds`. Change it to run separate environments in one database |

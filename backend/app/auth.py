"""alertNow - authentication and role-based access control (stdlib only).

Modes (env AUTH_MODE):
  off (default)  local demo: everyone acts as Control Room, no login.
  on             cloud: login required for Control Room and Rescue Officer; citizens can still submit a request anonymously.

Sign-in = username + password + security key (6-digit code from an authenticator app, RFC 6238 TOTP).
Roles: CONTROL_ROOM (full access) | OFFICER (only the requests of their own team/unit) | CITIZEN (anonymous: submit + see own request status).

Users come from env SHIELD_USERS (JSON) or the file given by SHIELD_USERS_FILE (default backend/users.json).
Create them with:   python -m app.auth init        (users.json with random passwords + security keys, printed once)
                    python -m app.auth add NAME ROLE [UNIT]     (ROLE = CONTROL_ROOM | OFFICER | CITIZEN)
                    python -m app.auth code NAME             (developer helper: current 6-digit code)
"""
import base64
import hashlib
import hmac
import json
import os
import secrets
import struct
import sys
import time
from pathlib import Path
from typing import Optional

from fastapi import Depends, HTTPException, Request

AUTH_ON = os.getenv("AUTH_MODE", "off").strip().lower() == "on"
SECRET = os.getenv("SHIELD_SECRET", "")
TTL = int(os.getenv("SHIELD_TOKEN_HOURS", "12")) * 3600
USERS_FILE = Path(os.getenv("SHIELD_USERS_FILE", Path(__file__).resolve().parents[1] / "users.json"))
CONTROL, OFFICER, CITIZEN = "CONTROL_ROOM", "OFFICER", "CITIZEN"
REQUIRE_2FA = os.getenv("SHIELD_REQUIRE_2FA", "1").strip().lower() not in ("0", "off", "false", "no")
PORTALS = {"control": CONTROL, "officer": OFFICER, "citizen": CITIZEN}
PORTAL_LABEL = {CONTROL: "Control Room", OFFICER: "Rescue Officer", CITIZEN: "Citizen"}

if AUTH_ON and len(SECRET) < 16:
    raise RuntimeError("AUTH_MODE=on requires SHIELD_SECRET (at least 16 characters).")


# ---------------------------------------------------------------- passwords
def hash_password(pw: str, salt: Optional[bytes] = None, iters: int = 200_000) -> str:
    salt = salt or secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", pw.encode(), salt, iters)
    return f"pbkdf2${iters}${salt.hex()}${dk.hex()}"


def verify_password(pw: str, stored: str) -> bool:
    try:
        _, iters, salt, dk = stored.split("$")
        calc = hashlib.pbkdf2_hmac("sha256", pw.encode(), bytes.fromhex(salt), int(iters))
        return hmac.compare_digest(calc.hex(), dk)
    except Exception:
        return False


def load_users() -> dict:
    raw = os.getenv("SHIELD_USERS")
    if raw:
        return json.loads(raw)
    if USERS_FILE.exists():
        return json.loads(USERS_FILE.read_text(encoding="utf-8"))
    return {}


USERS = load_users()
if AUTH_ON and not USERS:
    raise RuntimeError("AUTH_MODE=on but no users found. Run: python -m app.auth init  (or set SHIELD_USERS).")


# ---------------------------------------------------------------- security key (TOTP, RFC 6238)
def new_totp_secret() -> str:
    return base64.b32encode(secrets.token_bytes(20)).decode().rstrip("=")


def totp(secret: str, at: Optional[float] = None, step: int = 30, digits: int = 6) -> str:
    key = base64.b32decode(secret.upper() + "=" * (-len(secret) % 8))
    h = hmac.new(key, struct.pack(">Q", int((at if at is not None else time.time()) // step)), hashlib.sha1).digest()
    o = h[-1] & 15
    return f"{(struct.unpack('>I', h[o:o + 4])[0] & 0x7FFFFFFF) % 10 ** digits:0{digits}d}"


def totp_ok(secret: str, code: str) -> Optional[int]:
    """returns the matched 30-second step (allowing +-1 step of clock drift) or None"""
    code = "".join(ch for ch in code if ch.isdigit())
    if len(code) != 6:
        return None
    now_ = time.time()
    for d in (0, -1, 1):
        if hmac.compare_digest(totp(secret, now_ + 30 * d), code):
            return int((now_ + 30 * d) // 30)
    return None


def otpauth_uri(username: str, secret: str) -> str:
    return f"otpauth://totp/alertNow:{username}?secret={secret}&issuer=alertNow&digits=6&period=30"


# ---------------------------------------------------------------- tokens (HMAC-signed, expiring)
def _b64(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def make_token(username: str, u: dict) -> str:
    body = _b64(json.dumps(dict(u=username, r=u["role"], unit=u.get("unit"), n=u.get("name", username), exp=int(time.time()) + TTL)).encode())
    sig = _b64(hmac.new(SECRET.encode(), body.encode(), hashlib.sha256).digest())
    return f"{body}.{sig}"


def parse_token(tok: str) -> Optional[dict]:
    try:
        body, sig = tok.split(".")
        good = _b64(hmac.new(SECRET.encode(), body.encode(), hashlib.sha256).digest())
        if not hmac.compare_digest(sig, good):
            return None
        d = json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))
        if d["exp"] < time.time():
            return None
        # the account must still exist (lets an admin revoke access by deleting the user)
        if d["u"] not in USERS or USERS[d["u"]].get("disabled"):
            return None
        return dict(username=d["u"], role=USERS[d["u"]]["role"], unit=USERS[d["u"]].get("unit"), name=d["n"])
    except Exception:
        return None


# ---------------------------------------------------------------- login throttle (per user+ip)
class _MemRL:
    """default (single process). main.py swaps in store.RateLimiter so all serverless instances share the counters."""
    def __init__(self):
        self.d = {}

    def count(self, key):
        self.d[key] = [x for x in self.d.get(key, []) if time.time() - x < 300]
        return len(self.d[key])

    def hit(self, key, ttl):
        self.count(key); self.d[key].append(time.time()); return len(self.d[key])

    def clear(self, key):
        self.d.pop(key, None)


RL = _MemRL()


def throttled(key: str) -> bool:
    return RL.count(key) >= 5


def record_fail(key: str):
    RL.hit(key, 300)


BAD = "Wrong username, password or security key"   # one message for every failure: do not reveal which part was wrong


def login(username: str, password: str, ip: str, code: str = "", portal: Optional[str] = None) -> dict:
    key = f"{username.lower()}|{ip}"
    if throttled(key):
        raise HTTPException(429, "Too many failed attempts. Try again in 5 minutes.")
    u = USERS.get(username)
    # always run a hash so unknown users and wrong passwords take the same time
    ok = verify_password(password, u["password_hash"] if u else hash_password("x", b"0" * 16, 1000)) and bool(u) and not u.get("disabled")
    if not ok:
        record_fail(key)
        raise HTTPException(401, BAD)
    if REQUIRE_2FA:
        if not u.get("totp_secret"):
            raise HTTPException(403, "No security key is set up for this account. Ask the administrator to reset it.")
        step = totp_ok(u["totp_secret"], code)
        # a code can be used once (blocks replay of a code someone watched you type)
        if step is None or RL.hit(f"totp|{username.lower()}|{step}", 120) > 1:
            record_fail(key)
            raise HTTPException(401, BAD)
    if portal and PORTALS.get(portal) != u["role"]:
        raise HTTPException(403, f"This is not a {PORTAL_LABEL.get(PORTALS.get(portal), portal)} account. Choose the access screen for your role.")
    RL.clear(key)
    return dict(token=make_token(username, u), role=u["role"], unit=u.get("unit"), name=u.get("name", username), expires_in=TTL)


# ---------------------------------------------------------------- request principals
DEV = dict(username="local", role=CONTROL, unit=None, name="Local demo (auth off)")
ANON = dict(username="anonymous", role=CITIZEN, unit=None, name="Citizen")


def token_from(request) -> Optional[str]:
    h = request.headers.get("authorization", "")
    if h.lower().startswith("bearer "):
        return h[7:].strip()
    return request.query_params.get("token")


def principal(request: Request) -> dict:
    if not AUTH_ON:
        return DEV
    tok = token_from(request)
    p = parse_token(tok) if tok else None
    if tok and not p:
        raise HTTPException(401, "Session expired - please sign in again")
    return p or ANON


def require(*roles):
    """FastAPI dependency: allow only the given roles (CONTROL_ROOM is always allowed unless roles == (CITIZEN,) only)."""
    def dep(p: dict = Depends(principal)) -> dict:
        if p["role"] in roles or (p["role"] == CONTROL and OFFICER in roles):
            return p
        raise HTTPException(401 if p["role"] == CITIZEN else 403, "Sign in with an authorised account" if p["role"] == CITIZEN else "Not permitted for your role")
    return dep


def can_see_unit(p: dict, unit_id: Optional[str]) -> bool:
    return p["role"] == CONTROL or (p["role"] == OFFICER and p.get("unit") == unit_id)


# ---------------------------------------------------------------- CLI
def _show(name, pw, role, secret):
    print(f"  user: {name:<10} password: {pw:<14} role: {role}\n    security key (setup key for the authenticator app): {secret}\n    {otpauth_uri(name, secret)}\n")


def _cli():
    a = sys.argv[1:]
    if a[:1] == ["init"]:
        if USERS_FILE.exists() and "--force" not in a:
            sys.exit(f"{USERS_FILE} already exists (use --force to overwrite).")
        spec = [("control", CONTROL, None, "Duty Officer"), ("alpha04", OFFICER, "Alpha-04", "NDRF Boat Team"),
                ("bravo02", OFFICER, "Bravo-02", "Chennai Fire & Rescue"), ("charlie07", OFFICER, "Charlie-07", "GCC Medical Response")]
        out, shown = {}, []
        for name, role, unit, label in spec:
            pw, sec = secrets.token_urlsafe(9), new_totp_secret()
            out[name] = dict(password_hash=hash_password(pw), role=role, unit=unit, name=label, totp_secret=sec)
            shown.append((name, pw, role, sec))
        USERS_FILE.write_text(json.dumps(out, indent=2), encoding="utf-8")
        print(f"Wrote {USERS_FILE}\nWrite these down now: passwords are NOT stored anywhere. In each person's authenticator app\n(Google/Microsoft Authenticator) choose 'Enter a setup key', type the key below and name it DisasterShield.\n")
        for s in shown:
            _show(*s)
        print("users.json holds the security keys too: keep it secret and never commit it.")
    elif a[:1] == ["add"] and len(a) >= 3:
        import getpass
        name, role = a[1], a[2].upper()
        if role not in (CONTROL, OFFICER, CITIZEN):
            sys.exit("ROLE must be CONTROL_ROOM, OFFICER or CITIZEN")
        unit = a[3] if len(a) > 3 else None
        if role == OFFICER and not unit:
            sys.exit("OFFICER needs a UNIT, e.g. Bravo-02")
        users = json.loads(USERS_FILE.read_text(encoding="utf-8")) if USERS_FILE.exists() else {}
        pw = getpass.getpass("Password: ")
        if len(pw) < 8:
            sys.exit("Use at least 8 characters.")
        sec = new_totp_secret()
        users[name] = dict(password_hash=hash_password(pw), role=role, unit=unit, name=name, totp_secret=sec)
        USERS_FILE.write_text(json.dumps(users, indent=2), encoding="utf-8")
        print(f"Saved {name} ({role}{' / ' + unit if unit else ''}) to {USERS_FILE}\n"); _show(name, "(as typed)", role, sec)
    elif a[:1] == ["code"] and len(a) == 2:
        u = USERS.get(a[1]) or sys.exit("unknown user")
        print(totp(u["totp_secret"]))
    else:
        print(__doc__)


if __name__ == "__main__":
    _cli()

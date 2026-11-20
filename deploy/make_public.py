"""Build the static site Vercel serves from its CDN:
     portal/        -> public/            (access screen at "/")
     web-dashboard/ -> public/control/    (Control Room)
     mobile/        -> public/mobile/     (Citizen + Rescue Officer app)

Run it after changing any front-end file:   python deploy/make_public.py
"""
import shutil
from pathlib import Path

root = Path(__file__).resolve().parents[1]
out = root / "public"
if out.exists():
    shutil.rmtree(out)
ign = shutil.ignore_patterns("__pycache__")
shutil.copytree(root / "portal", out, ignore=ign)
shutil.copytree(root / "web-dashboard", out / "control", ignore=ign)
shutil.copytree(root / "mobile", out / "mobile", ignore=ign)
print(f"Built {out}: {sum(1 for p in out.rglob('*') if p.is_file())} files")

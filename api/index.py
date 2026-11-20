"""Vercel serverless entry point: exposes the FastAPI app (ASGI) for every /api/* request."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
from app.main import app  # noqa: E402,F401

"""AI service: flood risk scoring (explainable weighted model + optional XGBoost confidence) and SOS triage ranking."""
import math
import random
from datetime import datetime, timezone

from .seed import SECTORS

# ---- Flood risk -----------------------------------------------------------------------------------------------
W = dict(rainfall=38.0, river=32.0, rise=15.0, saturation=7.0, elevation=8.0)


def features(rain_mm_hr, river_m, danger_m, rise_m_hr, saturation=0.8, elev=0.9):
    return dict(
        rainfall=min(rain_mm_hr / 85.0, 1.0),
        river=min(river_m / danger_m, 1.0) if danger_m else 0,
        rise=min(max(rise_m_hr, 0) / 0.4, 1.0),
        saturation=saturation,
        elevation=elev,
    )


def heuristic_score(f):
    contrib = {k: round(W[k] * min(f[k], 1.0), 2) for k in W}
    return min(100.0, sum(contrib.values())), contrib


def severity(score):
    return "CRITICAL" if score >= 80 else "HIGH" if score >= 60 else "WARNING" if score >= 40 else "LOW"


_XGB = None
try:  # optional dependency
    import numpy as np
    import xgboost as xgb

    rng = np.random.default_rng(14)
    X = rng.random((3000, 5))
    ys = (X * np.array(list(W.values()))).sum(axis=1) + rng.normal(0, 4, 3000)
    _XGB = xgb.XGBClassifier(n_estimators=80, max_depth=3, learning_rate=0.15, verbosity=0)
    _XGB.fit(X, (ys >= 80).astype(int))
except Exception:  # pragma: no cover
    _XGB = None


def confidence(f, score):
    """XGBoost P(critical) agreement when available, else logistic margin around the 80-pt CRITICAL threshold."""
    if _XGB is not None:
        import numpy as np
        p = float(_XGB.predict_proba(np.array([[f[k] for k in W]]))[0][1])
    else:
        p = 1 / (1 + math.exp(-(score - 80) / 4))
    agree = p if score >= 80 else 1 - p
    return round(0.5 + 0.5 * agree, 3)


def assess(rain, river, danger, rise, sector="ALL"):
    elev = SECTORS[sector]["elevation_risk"] if sector in SECTORS else 0.9
    f = features(rain, river, danger, rise, elev=elev)
    score, contrib = heuristic_score(f)
    return dict(sector_code=sector, risk_score=round(score, 1), severity=severity(score),
                xgboost_confidence=confidence(f, score), feature_contributions=contrib,
                model="xgboost" if _XGB is not None else "logistic-fallback")


# ---- SOS triage -----------------------------------------------------------------------------------------------
VULN_WEIGHT = {"Medical / Oxygen Need": 30, "Family with Infants": 22, "Elderly / Mobility Aid": 20}


def triage(depth_m, vuln_tags, household, created_at, depth_rising=True):
    depth = min(depth_m / 1.5, 1.0) * 45                     # water-depth risk
    vuln = min(sum(VULN_WEIGHT.get(t, 8) for t in vuln_tags), 40)  # vulnerability-weighted
    hh = min(household, 8) / 8 * 5
    wait = min((datetime.now(timezone.utc) - created_at).total_seconds() / 60, 60) / 60 * 10
    rise = 5 if depth_rising else 0
    score = round(min(depth + vuln + hh + wait + rise, 100), 1)
    return score, ("CRITICAL" if score >= 70 else "HIGH" if score >= 45 else "MODERATE")


def jitter(v, pct):
    return v * (1 + random.uniform(-pct, pct))

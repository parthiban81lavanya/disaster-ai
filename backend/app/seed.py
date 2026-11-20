"""Seed data for Ward 14 – Adyar Basin, Chennai (EPSG:4326, lon/lat order in GeoJSON, lat/lon in tuples here)."""
from datetime import datetime, timedelta, timezone

NOW = lambda: datetime.now(timezone.utc)

# 3x2 sector grid. (south, west, north, east)
LON = [80.235, 80.2523, 80.2696, 80.2869]
LAT = [12.992, 13.0085, 13.025]
SECTORS = {
    "A": dict(name="Sector A Highland", box=(LAT[1], LON[0], LAT[2], LON[1]), elevation_risk=0.55),
    "B": dict(name="Sector B Central", box=(LAT[1], LON[1], LAT[2], LON[2]), elevation_risk=0.75),
    "C": dict(name="Sector C North Ridge", box=(LAT[1], LON[2], LAT[2], LON[3]), elevation_risk=0.60),
    "D": dict(name="Sector D Canal Bank", box=(LAT[0], LON[0], LAT[1], LON[1]), elevation_risk=0.90),
    "E": dict(name="Sector E Lowland", box=(LAT[0], LON[1], LAT[1], LON[2]), elevation_risk=1.00),
    "F": dict(name="Sector F Tech Park", box=(LAT[0], LON[2], LAT[1], LON[3]), elevation_risk=0.80),
}

# Road graph nodes (lat, lon). Shelters sit on hub nodes.
NODES = {
    "A": (13.0170, 80.2440), "B": (13.0170, 80.2610), "C": (13.0170, 80.2780),
    "D": (13.0000, 80.2440), "E": (13.0000, 80.2610), "F": (13.0000, 80.2780),
    "M": (13.0085, 80.2610),  # mid junction B<->E
}
# id, name, from, to, status, depth
ROADS = [
    (1, "Sardar Patel Rd (A–B)", "A", "B", "SAFE", 0.0),
    (2, "Gandhi Mandapam Rd (B–C)", "B", "C", "SAFE", 0.0),
    (3, "Adyar Bridge Link (A–D)", "A", "D", "SAFE", 0.1),
    (4, "Besant Ave (B–M)", "B", "M", "SAFE", 0.0),
    (5, "Besant Ave South (M–E)", "M", "E", "SAFE", 0.15),
    (6, "Canal Bank Rd (D–E)", "D", "E", "SUBMERGED", 0.9),
    (7, "Tech Park Rd (E–F)", "E", "F", "BLOCKED", 1.4),
    (8, "Ridge Link (C–F)", "C", "F", "SUBMERGED", 0.55),
]

SHELTERS = [
    (1, "Shelter #1 – Corporation School, Sector A", "A", 200, 116),
    (2, "Shelter #2 – Community Hall, Sector C", "C", 250, 80),
    (3, "Shelter #3 – Govt. College, Sector B", "B", 200, 44),
]

# Adyar river polyline (lat, lon) running W→E through the lower basin
RIVER = [(13.0050, 80.2350), (13.0060, 80.2450), (13.0072, 80.2540), (13.0067, 80.2571),
         (13.0080, 80.2650), (13.0070, 80.2760), (13.0085, 80.2869)]

UNITS = [
    ("Alpha-04", "NDRF Boat Team", 13.0160, 80.2625, "BUSY"),
    ("Bravo-02", "Chennai Fire & Rescue", 13.0165, 80.2770, "AVAILABLE"),
    ("Charlie-07", "GCC Medical Response", 13.0175, 80.2450, "AVAILABLE"),
]

def sos_seed():
    n = NOW()
    return [
        dict(id="SOS-102", citizen_name="Meena R.", household_size=4, lat=12.9990, lon=80.2470, water_depth_m=0.6,
             vulnerability_tags=["Elderly / Mobility Aid"], status="OPEN", assigned_unit_id=None,
             synced_offline=False, created_at=n - timedelta(minutes=22)),
        dict(id="SOS-103", citizen_name="Karthik S.", household_size=3, lat=13.0022, lon=80.2590, water_depth_m=0.9,
             vulnerability_tags=["Family with Infants"], status="DISPATCHED", assigned_unit_id="Alpha-04",
             synced_offline=True, created_at=n - timedelta(minutes=14)),
        dict(id="SOS-104", citizen_name="Lakshmi V.", household_size=2, lat=13.0067, lon=80.2571, water_depth_m=1.2,
             vulnerability_tags=["Medical / Oxygen Need", "Elderly / Mobility Aid"], status="OPEN",
             assigned_unit_id=None, synced_offline=False, created_at=n - timedelta(minutes=6)),
    ]

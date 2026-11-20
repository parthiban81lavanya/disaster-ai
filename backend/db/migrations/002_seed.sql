-- Ward 14 – Adyar Basin seed (mirrors backend/app/seed.py). ST_MakePoint(lon, lat).
INSERT INTO telemetry_readings (source,rainfall_mm_hr) VALUES ('IMD',84.5);
INSERT INTO telemetry_readings (source,river_level_m,danger_level_m,rate_of_rise) VALUES ('CWC',6.82,7.20,0.24);

INSERT INTO shelters (name,location,total_beds,occupied_beds) VALUES
 ('Shelter #1 – Corporation School, Sector A', ST_MakePoint(80.2440,13.0170)::geography, 200, 116),
 ('Shelter #2 – Community Hall, Sector C',     ST_MakePoint(80.2780,13.0170)::geography, 250,  80),
 ('Shelter #3 – Govt. College, Sector B',      ST_MakePoint(80.2610,13.0170)::geography, 200,  44);

INSERT INTO road_segments (name,geom,status,water_depth_m) VALUES
 ('Sardar Patel Rd (A–B)',     ST_GeogFromText('LINESTRING(80.2440 13.0170,80.2610 13.0170)'),'SAFE',0),
 ('Gandhi Mandapam Rd (B–C)',  ST_GeogFromText('LINESTRING(80.2610 13.0170,80.2780 13.0170)'),'SAFE',0),
 ('Adyar Bridge Link (A–D)',   ST_GeogFromText('LINESTRING(80.2440 13.0170,80.2440 13.0000)'),'SAFE',0.1),
 ('Besant Ave (B–M)',          ST_GeogFromText('LINESTRING(80.2610 13.0170,80.2610 13.0085)'),'SAFE',0),
 ('Besant Ave South (M–E)',    ST_GeogFromText('LINESTRING(80.2610 13.0085,80.2610 13.0000)'),'SAFE',0.15),
 ('Canal Bank Rd (D–E)',       ST_GeogFromText('LINESTRING(80.2440 13.0000,80.2610 13.0000)'),'SUBMERGED',0.9),
 ('Tech Park Rd (E–F)',        ST_GeogFromText('LINESTRING(80.2610 13.0000,80.2780 13.0000)'),'BLOCKED',1.4),
 ('Ridge Link (C–F)',          ST_GeogFromText('LINESTRING(80.2780 13.0170,80.2780 13.0000)'),'SUBMERGED',0.55);

INSERT INTO responder_units (id,name,location,status) VALUES
 ('Alpha-04','NDRF Boat Team',         ST_MakePoint(80.2625,13.0160)::geography,'BUSY'),
 ('Bravo-02','Chennai Fire & Rescue',  ST_MakePoint(80.2770,13.0165)::geography,'AVAILABLE'),
 ('Charlie-07','GCC Medical Response', ST_MakePoint(80.2450,13.0175)::geography,'AVAILABLE');

INSERT INTO sos_beacons (id,citizen_name,household_size,location,sector,water_depth_m,vulnerability_tags,priority_score,severity,status,assigned_unit_id,synced_offline) VALUES
 ('SOS-102','Meena R.',   4, ST_MakePoint(80.2470,12.9990)::geography,'D',0.6,'{"Elderly / Mobility Aid"}',                         52,'HIGH',    'OPEN',      NULL,       FALSE),
 ('SOS-103','Karthik S.', 3, ST_MakePoint(80.2590,13.0022)::geography,'E',0.9,'{"Family with Infants"}',                            63,'HIGH',    'DISPATCHED','Alpha-04', TRUE),
 ('SOS-104','Lakshmi V.', 2, ST_MakePoint(80.2571,13.0067)::geography,'E',1.2,'{"Medical / Oxygen Need","Elderly / Mobility Aid"}',  88,'CRITICAL','OPEN',      NULL,       FALSE);

INSERT INTO flood_risk_assessments (ward_id,sector_code,risk_score,severity,xgboost_confidence,feature_contributions)
VALUES (14,'ALL',89.9,'CRITICAL',0.942,'{"rainfall":37.8,"river":30.3,"rise":9.0,"saturation":5.6,"elevation":7.2}');

INSERT INTO cap_alerts (cap_identifier,target_polygon,language,message_body,status) VALUES
 ('NDMA-SACHET-W14-SEED-001',
  ST_GeogFromText('POLYGON((80.235 12.992,80.2869 12.992,80.2869 13.025,80.235 13.025,80.235 12.992))'),'en',
  '[NDMA-SACHET / WARD-14] CRITICAL FLOOD WARNING: Adyar river 6.82 m (danger 7.20 m), +0.24 m/hr.','PENDING_APPROVAL');

INSERT INTO audit_logs (actor_module,action_rationale,verification_type) VALUES
 ('CAP Ingestion','NDMA-SACHET Orange alert for Chennai ingested and geo-matched to Ward 14.','VERIFIED'),
 ('XGBoost Flood-Risk Engine','Ward 14 risk 89.9/100 CRITICAL; drivers rainfall, river proximity to danger mark.','AI INFERENCE');

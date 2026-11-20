-- alertNow :: schema (PostgreSQL 15+ / PostGIS 3). All geometries EPSG:4326.
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE telemetry_readings (
  id BIGSERIAL PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('IMD','CWC')),
  rainfall_mm_hr NUMERIC(6,2), river_level_m NUMERIC(5,2), danger_level_m NUMERIC(5,2), rate_of_rise NUMERIC(5,2),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX telemetry_time_idx ON telemetry_readings (source, recorded_at DESC);

CREATE TABLE flood_risk_assessments (
  id BIGSERIAL PRIMARY KEY, ward_id INT NOT NULL, sector_code VARCHAR(3) NOT NULL,
  risk_score NUMERIC(5,1) CHECK (risk_score BETWEEN 0 AND 100), severity TEXT NOT NULL,
  xgboost_confidence NUMERIC(4,3), feature_contributions JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT now());

CREATE TABLE shelters (
  id SERIAL PRIMARY KEY, name TEXT NOT NULL, location GEOGRAPHY(Point,4326) NOT NULL,
  total_beds INT NOT NULL, occupied_beds INT NOT NULL DEFAULT 0 CHECK (occupied_beds <= total_beds),
  status TEXT NOT NULL DEFAULT 'READY');
CREATE INDEX shelters_gix ON shelters USING GIST (location);

CREATE TABLE road_segments (
  id SERIAL PRIMARY KEY, name TEXT NOT NULL, geom GEOGRAPHY(LineString,4326) NOT NULL,
  status TEXT NOT NULL DEFAULT 'SAFE' CHECK (status IN ('SAFE','SUBMERGED','BLOCKED')),
  water_depth_m NUMERIC(4,2) DEFAULT 0, updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX road_segments_gix ON road_segments USING GIST (geom);
CREATE INDEX road_segments_status_idx ON road_segments (status);

CREATE TABLE responder_units (
  id TEXT PRIMARY KEY, name TEXT, location GEOGRAPHY(Point,4326) NOT NULL,
  status TEXT NOT NULL DEFAULT 'AVAILABLE', updated_at TIMESTAMPTZ DEFAULT now());
CREATE INDEX responder_units_gix ON responder_units USING GIST (location);

CREATE TABLE sos_beacons (
  id TEXT PRIMARY KEY, client_id TEXT UNIQUE, citizen_name TEXT NOT NULL, household_size INT NOT NULL DEFAULT 1,
  location GEOGRAPHY(Point,4326) NOT NULL, sector CHAR(1), water_depth_m NUMERIC(4,2),
  vulnerability_tags TEXT[] NOT NULL DEFAULT '{}', priority_score NUMERIC(5,1), severity TEXT,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','DISPATCHED','RESOLVED')),
  assigned_unit_id TEXT REFERENCES responder_units(id), synced_offline BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX sos_beacons_gix ON sos_beacons USING GIST (location);
CREATE INDEX sos_queue_idx ON sos_beacons (status, priority_score DESC);

CREATE TABLE cap_alerts (
  id BIGSERIAL PRIMARY KEY, cap_identifier TEXT UNIQUE NOT NULL, target_polygon GEOGRAPHY(Polygon,4326),
  language TEXT NOT NULL DEFAULT 'en', message_body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING_APPROVAL' CHECK (status IN ('PENDING_APPROVAL','BROADCASTED')),
  approved_by TEXT, approved_at TIMESTAMPTZ);
CREATE INDEX cap_alerts_gix ON cap_alerts USING GIST (target_polygon);

CREATE TABLE audit_logs (
  id BIGSERIAL PRIMARY KEY, timestamp TIMESTAMPTZ NOT NULL DEFAULT now(), actor_module TEXT NOT NULL,
  action_rationale TEXT NOT NULL,
  verification_type TEXT NOT NULL CHECK (verification_type IN ('AI INFERENCE','VERIFIED','HUMAN APPROVED')),
  metadata_hash TEXT NOT NULL DEFAULT '');

-- Immutability: audit rows can never be updated or deleted.
CREATE FUNCTION audit_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'audit_logs is append-only'; END $$;
CREATE TRIGGER audit_no_mutate BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_immutable();

-- Hash chain: each row hashes its content together with the previous row's hash.
CREATE FUNCTION audit_chain() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prev TEXT;
BEGIN
  SELECT metadata_hash INTO prev FROM audit_logs ORDER BY id DESC LIMIT 1;
  NEW.metadata_hash := encode(digest(coalesce(prev,'GENESIS') || NEW.timestamp::text || NEW.actor_module
                       || NEW.action_rationale || NEW.verification_type, 'sha256'), 'hex');
  RETURN NEW;
END $$;
CREATE TRIGGER audit_hash BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION audit_chain();

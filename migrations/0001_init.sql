-- Rollo: esquema inicial
-- Todas las fechas son epoch en milisegundos (UTC).

CREATE TABLE trips (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  join_code         TEXT NOT NULL UNIQUE,
  timezone          TEXT NOT NULL,              -- IANA, ej: America/Argentina/Buenos_Aires
  starts_at         INTEGER NOT NULL,
  ends_at           INTEGER NOT NULL,
  reveal_at         INTEGER NOT NULL,           -- revelado automático
  revealed_at       INTEGER,                    -- revelado manual del admin (o null)
  daily_photo_limit INTEGER NOT NULL DEFAULT 10,
  daily_video_limit INTEGER NOT NULL DEFAULT 3,
  created_at        INTEGER NOT NULL
);

CREATE TABLE members (
  id          TEXT PRIMARY KEY,
  trip_id     TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  name        TEXT NOT NULL COLLATE NOCASE,
  role        TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  token_hash  TEXT NOT NULL UNIQUE,             -- SHA-256 del token; el token nunca se guarda
  created_at  INTEGER NOT NULL,
  removed_at  INTEGER
);

-- Un nombre por viaje (sin distinguir mayúsculas), ignorando miembros removidos.
CREATE UNIQUE INDEX idx_members_trip_name
  ON members (trip_id, name) WHERE removed_at IS NULL;

CREATE TABLE media (
  id            TEXT PRIMARY KEY,               -- UUID generado en el celular (idempotencia offline)
  trip_id       TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  member_id     TEXT NOT NULL REFERENCES members(id),
  type          TEXT NOT NULL CHECK (type IN ('photo', 'video')),
  taken_at      INTEGER NOT NULL,               -- hora del celular al disparar
  local_date    TEXT NOT NULL,                  -- YYYY-MM-DD en la zona horaria del viaje
  lat           REAL,
  lng           REAL,
  accuracy_m    REAL,
  caption       TEXT,
  duration_s    REAL,
  width         INTEGER,
  height        INTEGER,
  size_bytes    INTEGER,
  original_key  TEXT NOT NULL,
  thumb_key     TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'uploaded')),
  created_at    INTEGER NOT NULL,
  uploaded_at   INTEGER
);

CREATE INDEX idx_media_trip_time  ON media (trip_id, taken_at);
CREATE INDEX idx_media_member_day ON media (member_id, local_date, type);

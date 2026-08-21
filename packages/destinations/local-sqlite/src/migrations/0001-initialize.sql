CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL,
  ordinal INTEGER NOT NULL UNIQUE
) STRICT;

CREATE TABLE destination_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE traces (
  delivery_identity TEXT PRIMARY KEY,
  trace_id TEXT NOT NULL,
  start_time_unix_nano TEXT NOT NULL,
  start_time_sort_key TEXT NOT NULL,
  admission_time_unix_nano TEXT NOT NULL,
  admission_time_sort_key TEXT NOT NULL,
  protocol_compatibility_id TEXT NOT NULL,
  payload BLOB NOT NULL,
  payload_sha256 TEXT NOT NULL,
  payload_bytes INTEGER NOT NULL
) STRICT;

CREATE TABLE trace_dimensions (
  delivery_identity TEXT NOT NULL REFERENCES traces(delivery_identity) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  value TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY (delivery_identity, kind, value)
) STRICT;

CREATE INDEX traces_search_order
  ON traces(start_time_sort_key DESC, trace_id ASC);

CREATE INDEX trace_dimensions_lookup
  ON trace_dimensions(kind, value, delivery_identity);

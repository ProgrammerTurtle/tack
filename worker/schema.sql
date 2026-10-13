-- One row per board per user. `data` is the board's items as JSON.
-- Deleted boards are kept as tombstones (deleted = 1) so other devices learn about the delete.
CREATE TABLE IF NOT EXISTS boards (
  user       TEXT    NOT NULL,
  id         TEXT    NOT NULL,
  name       TEXT    NOT NULL DEFAULT '',
  data       TEXT    NOT NULL DEFAULT '[]',
  version    INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  deleted    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user, id)
);

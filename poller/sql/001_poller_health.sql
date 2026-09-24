-- Catatan kesehatan poller untuk dashboard "Status Poller".
-- Jalankan sekali sebagai root (user wifipoller tidak punya hak CREATE):
--   sudo mysql wifi_analytics < poller/sql/001_poller_health.sql
--
-- poller.php tetap jalan normal walau tabel ini belum dibuat -- penulisan
-- health dibungkus try/catch dan hanya menghasilkan WARN di log.

-- Satu baris per siklus poller.php (normalnya tiap menit).
CREATE TABLE IF NOT EXISTS poller_cycles (
  ts           DATETIME     NOT NULL,
  status       ENUM('ok','partial','error') NOT NULL,
  duration_ms  INT          NOT NULL,
  controllers_ok    TINYINT UNSIGNED NOT NULL,
  controllers_total TINYINT UNSIGNED NOT NULL,
  clients      INT          NOT NULL DEFAULT 0,
  resolved     INT          NULL,
  error        VARCHAR(500) NULL,
  PRIMARY KEY (ts)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Satu baris per controller per siklus.
CREATE TABLE IF NOT EXISTS poller_controller_runs (
  ts           DATETIME     NOT NULL,
  label        VARCHAR(64)  NOT NULL,
  type         VARCHAR(16)  NOT NULL,
  ok           TINYINT(1)   NOT NULL,
  clients      INT          NOT NULL DEFAULT 0,
  duration_ms  INT          NOT NULL,
  error        VARCHAR(500) NULL,
  PRIMARY KEY (ts, label),
  KEY idx_label_ts (label, ts)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

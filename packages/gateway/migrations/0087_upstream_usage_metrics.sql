CREATE TABLE upstream_usage_metrics (
  upstream_id TEXT NOT NULL,
  metric_key TEXT NOT NULL,
  bucket INTEGER NOT NULL,
  timestamp INTEGER NOT NULL,
  value REAL NOT NULL,
  PRIMARY KEY (upstream_id, metric_key, bucket)
);
CREATE INDEX upstream_usage_metrics_time ON upstream_usage_metrics (timestamp);
CREATE INDEX upstream_usage_metrics_series_time ON upstream_usage_metrics (upstream_id, metric_key, timestamp);

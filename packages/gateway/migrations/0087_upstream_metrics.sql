CREATE TABLE upstream_metrics (
  upstream_id TEXT NOT NULL,
  metric_name TEXT NOT NULL CHECK (length(metric_name) > 0),
  metric_labels JSON NOT NULL CHECK (json_valid(metric_labels) AND json_type(metric_labels) = 'object'),
  bucket INTEGER NOT NULL,
  timestamp INTEGER NOT NULL,
  value REAL NOT NULL,
  PRIMARY KEY (upstream_id, metric_name, metric_labels, bucket)
);
CREATE INDEX upstream_metrics_time ON upstream_metrics (timestamp);
CREATE INDEX upstream_metrics_series_time ON upstream_metrics (upstream_id, metric_name, metric_labels, timestamp);

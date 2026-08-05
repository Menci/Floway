CREATE INDEX idx_usage_metric_key_hour ON usage (key_id, hour);

CREATE INDEX idx_usage_requests_key_hour ON usage_requests (key_id, hour);

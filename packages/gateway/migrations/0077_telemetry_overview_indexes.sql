CREATE INDEX idx_api_keys_user_all ON api_keys (user_id, id);

CREATE INDEX idx_usage_metric_key_hour ON usage (key_id, hour);

CREATE INDEX idx_usage_requests_key_hour ON usage_requests (key_id, hour);

CREATE INDEX idx_performance_summary_key_hour ON performance_summary (key_id, hour);

CREATE INDEX idx_performance_buckets_key_hour ON performance_buckets (key_id, hour);

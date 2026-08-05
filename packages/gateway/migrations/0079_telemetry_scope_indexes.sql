CREATE INDEX idx_api_keys_user_all ON api_keys (user_id, id);

CREATE INDEX idx_performance_buckets_key_hour ON performance_buckets (key_id, hour);

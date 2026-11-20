-- Draft probes used to persist proxy backoff rows under the synthetic upstream
-- id 'draft'. No upstream row can ever match it, so GET /api/proxies/backoffs
-- threw on every dashboard load until an operator reset the proxy by hand.
-- New probes skip backoff bookkeeping (see DRAFT_UPSTREAM_ID); this clears the
-- rows left behind by older builds. The proxy-side condition covers the same
-- class of orphan left by a delete racing an in-flight dial: both tables sweep
-- their rows explicitly because proxy_upstream_backoffs has no foreign keys.
DELETE FROM proxy_upstream_backoffs
WHERE upstream_id = 'draft'
   OR NOT EXISTS (SELECT 1 FROM upstreams WHERE upstreams.id = proxy_upstream_backoffs.upstream_id)
   OR NOT EXISTS (SELECT 1 FROM proxies WHERE proxies.id = proxy_upstream_backoffs.proxy_id);

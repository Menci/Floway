-- Rename the three role-compatibility flags onto neutral `rewrite-` ids:
--
--   demote-interleaved-system-to-user -> rewrite-mid-conv-system-to-user
--   demote-developer-to-system        -> rewrite-developer-to-system
--   promote-system-to-developer       -> rewrite-system-to-developer
--
-- The old ids are gone from the catalog (packages/provider/src/flags.ts), so a
-- saved row that still carries one would be rejected at write time by
-- parseFlagOverridesWire's "Unknown flag_overrides ids" guard and at read time
-- by the per-model flagOverridesField validator. Each rename is a pure
-- relabel: the stored boolean carries over verbatim, so an operator's
-- force-on and force-off decisions survive.
--
-- Three passes, mirroring the three places a flag id can be stored:
--   1. upstreams.flag_overrides (every provider kind)
--   2. upstreams.config_json.models[*].flagOverrides (manual model rows)
--   3. upstreams.models_cache_json (resolved catalog snapshot)

-- Pass 1: upstream-level flag_overrides. `json_extract` on a JSON boolean
-- yields SQLite's 0/1 integer, so the value is re-encoded through a literal
-- `json('true')` / `json('false')` to keep the column a map of JSON booleans.
UPDATE upstreams
SET flag_overrides = json_set(
  json_remove(flag_overrides, '$."demote-interleaved-system-to-user"'),
  '$."rewrite-mid-conv-system-to-user"',
  json(CASE WHEN json_extract(flag_overrides, '$."demote-interleaved-system-to-user"') = 1 THEN 'true' ELSE 'false' END)
)
WHERE json_valid(flag_overrides)
  AND json_type(flag_overrides, '$."demote-interleaved-system-to-user"') IS NOT NULL;

UPDATE upstreams
SET flag_overrides = json_set(
  json_remove(flag_overrides, '$."demote-developer-to-system"'),
  '$."rewrite-developer-to-system"',
  json(CASE WHEN json_extract(flag_overrides, '$."demote-developer-to-system"') = 1 THEN 'true' ELSE 'false' END)
)
WHERE json_valid(flag_overrides)
  AND json_type(flag_overrides, '$."demote-developer-to-system"') IS NOT NULL;

UPDATE upstreams
SET flag_overrides = json_set(
  json_remove(flag_overrides, '$."promote-system-to-developer"'),
  '$."rewrite-system-to-developer"',
  json(CASE WHEN json_extract(flag_overrides, '$."promote-system-to-developer"') = 1 THEN 'true' ELSE 'false' END)
)
WHERE json_valid(flag_overrides)
  AND json_type(flag_overrides, '$."promote-system-to-developer"') IS NOT NULL;

-- Pass 2: per-model overrides (config_json.models[*].flagOverrides). Rebuild
-- the models array via json_group_array(CASE …) so entries without the flag
-- fall through the ELSE branch byte-for-byte unchanged. The outer EXISTS gate
-- keeps the rewrite off rows that hold no affected entry, which also makes a
-- re-run a no-op. One statement per flag; a row carrying several of them is
-- visited once per flag it carries.
UPDATE upstreams
SET config_json = json_set(
  config_json,
  '$.models',
  (
    SELECT json_group_array(
      CASE
        WHEN json_type(model.value, '$.flagOverrides."demote-interleaved-system-to-user"') IS NOT NULL
        THEN json_set(
          model.value,
          '$.flagOverrides',
          json_set(
            json_remove(
              json_extract(model.value, '$.flagOverrides'),
              '$."demote-interleaved-system-to-user"'
            ),
            '$."rewrite-mid-conv-system-to-user"',
            json(CASE WHEN json_extract(model.value, '$.flagOverrides."demote-interleaved-system-to-user"') = 1 THEN 'true' ELSE 'false' END)
          )
        )
        ELSE model.value
      END
    )
    FROM json_each(json_extract(upstreams.config_json, '$.models')) AS model
  )
)
WHERE json_valid(config_json)
  AND json_type(config_json, '$.models') = 'array'
  AND EXISTS (
    SELECT 1
    FROM json_each(json_extract(upstreams.config_json, '$.models')) AS model
    WHERE json_type(model.value, '$.flagOverrides."demote-interleaved-system-to-user"') IS NOT NULL
  );

UPDATE upstreams
SET config_json = json_set(
  config_json,
  '$.models',
  (
    SELECT json_group_array(
      CASE
        WHEN json_type(model.value, '$.flagOverrides."demote-developer-to-system"') IS NOT NULL
        THEN json_set(
          model.value,
          '$.flagOverrides',
          json_set(
            json_remove(
              json_extract(model.value, '$.flagOverrides'),
              '$."demote-developer-to-system"'
            ),
            '$."rewrite-developer-to-system"',
            json(CASE WHEN json_extract(model.value, '$.flagOverrides."demote-developer-to-system"') = 1 THEN 'true' ELSE 'false' END)
          )
        )
        ELSE model.value
      END
    )
    FROM json_each(json_extract(upstreams.config_json, '$.models')) AS model
  )
)
WHERE json_valid(config_json)
  AND json_type(config_json, '$.models') = 'array'
  AND EXISTS (
    SELECT 1
    FROM json_each(json_extract(upstreams.config_json, '$.models')) AS model
    WHERE json_type(model.value, '$.flagOverrides."demote-developer-to-system"') IS NOT NULL
  );

UPDATE upstreams
SET config_json = json_set(
  config_json,
  '$.models',
  (
    SELECT json_group_array(
      CASE
        WHEN json_type(model.value, '$.flagOverrides."promote-system-to-developer"') IS NOT NULL
        THEN json_set(
          model.value,
          '$.flagOverrides',
          json_set(
            json_remove(
              json_extract(model.value, '$.flagOverrides'),
              '$."promote-system-to-developer"'
            ),
            '$."rewrite-system-to-developer"',
            json(CASE WHEN json_extract(model.value, '$.flagOverrides."promote-system-to-developer"') = 1 THEN 'true' ELSE 'false' END)
          )
        )
        ELSE model.value
      END
    )
    FROM json_each(json_extract(upstreams.config_json, '$.models')) AS model
  )
)
WHERE json_valid(config_json)
  AND json_type(config_json, '$.models') = 'array'
  AND EXISTS (
    SELECT 1
    FROM json_each(json_extract(upstreams.config_json, '$.models')) AS model
    WHERE json_type(model.value, '$.flagOverrides."promote-system-to-developer"') IS NOT NULL
  );

-- Pass 3: the resolved catalog snapshot. Every cached model carries the
-- already-resolved `enabledFlags` plus the provider's per-model `flagOverrides`
-- overlay, both keyed on flag id, and a snapshot written before this migration
-- names the old ids. Nothing rejects those at read time — the data plane simply
-- asks the Set for the new id and gets `false` — so an untouched snapshot would
-- silently drop the rewrite until the entry ages out, and Copilot's Claude < 4.8
-- rows would start sending inline `role:'system'` to a Vertex backend that
-- rejects it. The entry is a cache, so the snapshot is discarded rather than
-- edited: the affected upstreams re-fetch their catalog on the first request
-- after deploy, which is the same work an expiry would have caused.
UPDATE upstreams
SET models_cache_json = NULL
WHERE models_cache_json IS NOT NULL
  AND (
    models_cache_json LIKE '%demote-interleaved-system-to-user%'
    OR models_cache_json LIKE '%demote-developer-to-system%'
    OR models_cache_json LIKE '%promote-system-to-developer%'
  );

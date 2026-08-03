-- Replace the per-upstream badge color with a hue.
--
-- The color could be a preset key, a raw #RRGGBB hex, or NULL meaning "inherit
-- a per-provider-kind default". Only the hue ever carried identity: the badge
-- washes it to 10% for the fill and 35% for the outline and solves the label
-- against that fill for a contrast floor, so lightness and chroma were never
-- the operator's to choose. The kind-default mechanism is gone with it — every
-- upstream now carries its own hue.
--
-- Rebuilt rather than ALTERed: SQLite cannot add a NOT NULL column without a
-- default, and a default hue would outlive the migration that needed it.
--
-- The hue is an OKLCH hue angle in degrees, which is the space the dashboard
-- generates the badge in.

CREATE TABLE upstreams_with_hue (
  id                         TEXT PRIMARY KEY,
  provider                   TEXT NOT NULL CHECK (provider IN ('copilot', 'custom', 'azure', 'codex', 'claude-code', 'ollama')),
  name                       TEXT NOT NULL,
  enabled                    INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  sort_order                 INTEGER NOT NULL DEFAULT 0,
  created_at                 TEXT NOT NULL,
  updated_at                 TEXT NOT NULL,
  config_json                TEXT NOT NULL,
  state_json                 TEXT NULL,
  flag_overrides             TEXT NOT NULL DEFAULT '[]',
  disabled_public_model_ids  TEXT NOT NULL DEFAULT '[]',
  proxy_fallback_list_json   TEXT NOT NULL DEFAULT '[]',
  model_prefix_json          TEXT NULL,
  models_cache_json          TEXT NULL,
  hue                        INTEGER NOT NULL CHECK (hue >= 0 AND hue < 360)
);

-- Three ways a row arrives at its hue, innermost query outward:
--
--   * A preset key takes the OKLCH hue of the hex the picker showed for it —
--     the color the operator actually clicked. The tones the badge painted are
--     not used: they were hand-tuned per scheme, disagreed with the swatch by
--     up to 33° and with each other by up to 20°, so the swatch is the only
--     value that records an intent.
--   * A NULL took its kind's default, so it takes that default's hue. Every
--     upstream of a kind lands on the same hue, which is what it looked like.
--   * A #RRGGBB value is converted here. sRGB → linear → LMS → OKLab, then
--     atan2 over the OKLab a/b pair. An achromatic value has no hue to
--     recover — a/b are float noise a few parts in 1e8 wide — so those rows
--     draw a random one instead.
--
-- workerd builds SQLite with SQLITE_ENABLE_MATH_FUNCTIONS and D1's authorizer
-- allowlists what this needs; Node has shipped the same define since v22.14.0.
-- https://github.com/cloudflare/workerd/blob/05e868985ed7496ee7e162c22bce4f8a3f206038/build/BUILD.sqlite3#L18
-- https://github.com/cloudflare/workerd/blob/05e868985ed7496ee7e162c22bce4f8a3f206038/src/workerd/util/sqlite.c%2B%2B#L450-L476
-- https://github.com/nodejs/node/blob/20da4aeadabc5b0a01e3fcf520f91df8285c68a2/deps/sqlite/sqlite.gyp#L23
--
-- That allowlist rejects the pow/ceil/log aliases (power, ceiling, log10), so
-- the cube roots and the transfer function spell it `pow`.
--
-- Matrices and transfer function: Björn Ottosson's OKLab derivation.
-- https://bottosson.github.io/posts/oklab/#converting-from-linear-srgb-to-oklab
-- https://www.w3.org/TR/css-color-4/#color-conversion-code
INSERT INTO upstreams_with_hue (
  id,
  provider,
  name,
  enabled,
  sort_order,
  created_at,
  updated_at,
  config_json,
  state_json,
  flag_overrides,
  disabled_public_model_ids,
  proxy_fallback_list_json,
  model_prefix_json,
  models_cache_json,
  hue
)
SELECT
  id,
  provider,
  name,
  enabled,
  sort_order,
  created_at,
  updated_at,
  config_json,
  state_json,
  flag_overrides,
  disabled_public_model_ids,
  proxy_fallback_list_json,
  model_prefix_json,
  models_cache_json,
  CASE
    WHEN oklab_a IS NULL THEN named_hue
    WHEN sqrt(oklab_a * oklab_a + oklab_b * oklab_b) < 1e-6 THEN (random() % 360 + 360) % 360
    -- atan2 returns (-180, 180], so one branch on the sign brings the angle
    -- onto [0, 360) without a floating-point modulo. The outer one catches the
    -- single value that rounds up onto 360, which is 0 under another name.
    ELSE CAST(round(CASE
      WHEN degrees(atan2(oklab_b, oklab_a)) < 0 THEN degrees(atan2(oklab_b, oklab_a)) + 360.0
      ELSE degrees(atan2(oklab_b, oklab_a))
    END) AS INTEGER) % 360
  END
FROM (
  SELECT
    *,
    1.9779984951 * lms_l - 2.4285922050 * lms_m + 0.4505937099 * lms_s AS oklab_a,
    0.0259040371 * lms_l + 0.7827717662 * lms_m - 0.8086757660 * lms_s AS oklab_b
  FROM (
    SELECT
      *,
      pow(0.4122214708 * linear_r + 0.5363325363 * linear_g + 0.0514459929 * linear_b, 1.0 / 3.0) AS lms_l,
      pow(0.2119034982 * linear_r + 0.6806995451 * linear_g + 0.1073969566 * linear_b, 1.0 / 3.0) AS lms_m,
      pow(0.0883024619 * linear_r + 0.2817188376 * linear_g + 0.6299787005 * linear_b, 1.0 / 3.0) AS lms_s
    FROM (
      SELECT
        *,
        CASE WHEN srgb_r <= 0.04045 THEN srgb_r / 12.92 ELSE pow((srgb_r + 0.055) / 1.055, 2.4) END AS linear_r,
        CASE WHEN srgb_g <= 0.04045 THEN srgb_g / 12.92 ELSE pow((srgb_g + 0.055) / 1.055, 2.4) END AS linear_g,
        CASE WHEN srgb_b <= 0.04045 THEN srgb_b / 12.92 ELSE pow((srgb_b + 0.055) / 1.055, 2.4) END AS linear_b
      FROM (
        -- A CASE with no ELSE leaves every non-hex color's channels NULL,
        -- which is what routes those rows to `named_hue` further out.
        SELECT
          id,
          provider,
          name,
          enabled,
          sort_order,
          created_at,
          updated_at,
          config_json,
          state_json,
          flag_overrides,
          disabled_public_model_ids,
          proxy_fallback_list_json,
          model_prefix_json,
          models_cache_json,
          CASE color
            WHEN 'amber' THEN 93
            WHEN 'emerald' THEN 152
            WHEN 'cyan' THEN 209
            WHEN 'violet' THEN 294
            WHEN 'rose' THEN 25
            WHEN 'orange' THEN 64
            ELSE CASE provider
              WHEN 'custom' THEN 93
              WHEN 'azure' THEN 152
              WHEN 'copilot' THEN 209
              WHEN 'codex' THEN 294
              WHEN 'claude-code' THEN 64
              WHEN 'ollama' THEN 25
            END
          END AS named_hue,
          CASE WHEN color LIKE '#______' THEN (
            (instr('0123456789abcdef', substr(lower(color), 2, 1)) - 1) * 16
            + (instr('0123456789abcdef', substr(lower(color), 3, 1)) - 1)
          ) / 255.0 END AS srgb_r,
          CASE WHEN color LIKE '#______' THEN (
            (instr('0123456789abcdef', substr(lower(color), 4, 1)) - 1) * 16
            + (instr('0123456789abcdef', substr(lower(color), 5, 1)) - 1)
          ) / 255.0 END AS srgb_g,
          CASE WHEN color LIKE '#______' THEN (
            (instr('0123456789abcdef', substr(lower(color), 6, 1)) - 1) * 16
            + (instr('0123456789abcdef', substr(lower(color), 7, 1)) - 1)
          ) / 255.0 END AS srgb_b
        FROM upstreams
      )
    )
  )
);

DROP TABLE upstreams;
ALTER TABLE upstreams_with_hue RENAME TO upstreams;
CREATE INDEX idx_upstreams_sort ON upstreams (sort_order, created_at);
CREATE INDEX idx_upstreams_provider_enabled_sort
  ON upstreams (provider, enabled, sort_order, created_at);

-- Bounty metadata: tags, a rough size, and an optional deadline -- what the board filters and sorts on.
--
-- - tags: a JSON array of strings from the fixed set in @osstrace/contract's BOUNTY_TAGS
--   ("frontend", "backend", "docs", "data", "other"), validated by the route. Bounties opened before
--   this migration get '[]' -- no tag is invented for them.
-- - difficulty: 'small' | 'medium' | 'large'. Required for every bounty opened from now on (the route
--   enforces it), but NULL for the ones opened before it existed -- guessing a size for someone
--   else's bounty would be made-up data, so those simply show no size.
-- - deadline: a calendar date (YYYY-MM-DD), or NULL for an open-ended bounty. Informational only: a
--   passed deadline never changes a bounty's status on its own (only its opener can resolve it).
--
-- Plain ADD COLUMNs: nothing else references these, and no existing column or constraint changes.
ALTER TABLE bounties ADD COLUMN tags TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags) AND json_type(tags) = 'array');
ALTER TABLE bounties ADD COLUMN difficulty TEXT CHECK (difficulty IS NULL OR difficulty IN ('small', 'medium', 'large'));
ALTER TABLE bounties ADD COLUMN deadline TEXT CHECK (deadline IS NULL OR deadline GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]');

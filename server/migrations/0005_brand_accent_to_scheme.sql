-- Depot no longer has a free-form brand accent color; it ships curated schemes
-- (brand_scheme, one of ledger / graphite / linen / harbor / ember, default ledger).
-- The old key is no longer in the settings allowlist, so a leftover row is dead
-- data that would only confuse a future audit of system_settings. Remove it; the
-- workspace lands on Ledger, and the admin picks a scheme under Settings → System.
DELETE FROM system_settings WHERE key = 'brand_accent';

-- A library of their own for everyone who can add files but was never given one.
--
-- 0011 gave one to everybody who had signed in, and the app has made one on every first
-- sign-in since. Neither reached two kinds of person: somebody who arrived as a viewer
-- (skipped, rightly, at the time) and was later made a contributor or an admin, and
-- somebody an administrator gave a role before they ever signed in, whose first sign-in
-- then found a role row and skipped the step that makes the library. The app now covers
-- both as they happen; this catches up everyone it missed.
--
-- The same rule as 0011: named after them where a display name is known, otherwise the
-- part of their address before the @, and never a second one. Skipped: viewers, anybody
-- switched off (their things are archived, not added to), and anybody whose address is
-- not known yet, who gets theirs from the app the next time they sign in.

INSERT INTO libraries (name, created_by, created_by_email, owner_id, owner_email, personal)
SELECT coalesce(nullif(btrim(p.display_name), ''), split_part(a.email, '@', 1)),
       ur.user_id, a.email, ur.user_id, a.email, true
  FROM user_roles ur
  CROSS JOIN LATERAL (SELECT coalesce(nullif(lower(ur.email), ''), ur.verified_email) AS email) a
  LEFT JOIN user_profiles p ON p.user_id = ur.user_id
 WHERE ur.role <> 'viewer'
   AND ur.disabled_at IS NULL
   AND a.email IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM libraries l WHERE l.owner_id = ur.user_id AND l.personal)
ON CONFLICT DO NOTHING;

-- Everyone gets a library of their own.
--
-- Depot has had two separate ideas of "private" living side by side: a library you own
-- and have not shared, and a file marked personal (documents.library_scoped = false)
-- hiding inside somebody else's library. The second exists for one historical reason --
-- it protected files uploaded before sharing existed, so switching sharing on did not
-- expose them -- and it was never meant to be how people organise their work.
--
-- From here the LIBRARY is the unit of privacy. Each person has one that is theirs,
-- private until they decide otherwise, and it is where anything they upload lands when
-- they have not said where. The personal-file flag stays exactly as it is for what is
-- already stored, and quietly dies out.
--
-- `personal` marks a library as somebody's own. It is not a permission -- access is
-- decided by the same rule as everywhere else, and the owner branch is what lets them in
-- -- it is how the app knows to name it in the switcher, and how this file guarantees
-- nobody ends up with two.

ALTER TABLE libraries ADD COLUMN IF NOT EXISTS personal BOOLEAN NOT NULL DEFAULT false;

-- One each, enforced rather than remembered: first sign-in creates a library, and two
-- requests arriving together would otherwise make two.
CREATE UNIQUE INDEX IF NOT EXISTS libraries_personal_owner_uniq
  ON libraries (owner_id) WHERE personal;

-- Everyone who has already signed in gets theirs now, so the app never has to cope with
-- somebody who has nowhere of their own. Named after them where a display name is known,
-- otherwise the part of their address before the @. Viewers are skipped: they cannot add
-- files, so a library of their own would only be a thing that could never be used.
INSERT INTO libraries (name, created_by, created_by_email, owner_id, owner_email, personal)
SELECT coalesce(nullif(btrim(p.display_name), ''), split_part(ur.email, '@', 1)),
       ur.user_id, lower(ur.email), ur.user_id, lower(ur.email), true
  FROM user_roles ur
  LEFT JOIN user_profiles p ON p.user_id = ur.user_id
 WHERE ur.role <> 'viewer'
   AND NOT EXISTS (SELECT 1 FROM libraries l WHERE l.owner_id = ur.user_id AND l.personal)
ON CONFLICT DO NOTHING;

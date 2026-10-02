-- In-browser Office editing is now a switch an admin sets in Settings, and it starts
-- switched off: the editor costs about 600 MB of memory whether or not anyone uses it.
-- Older installs had it on through COLLABORA_ENABLED=true in .env; a database row wins
-- over the environment, so writing 'false' here switches every install off once, at
-- the update that brings the switch. An admin who wants editing turns it back on in
-- Settings → Branding & links → In-browser editing, and that choice is never touched again.
INSERT INTO system_settings (key, value, updated_at)
VALUES ('collabora_enabled', 'false', NOW())
ON CONFLICT (key) DO UPDATE SET value = 'false', updated_at = NOW();

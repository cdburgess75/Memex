'use strict';
// "Using the Depot API": the plain-language guide served at /api/docs/guide, beside the
// reference. One source for the page and for the PDF edition. Every sample is written against
// the Depot it is read on (origin), so a reader can copy it as it stands.
//
// Blocks: { p } a paragraph (**bold** and `code` allowed); { steps } a numbered list;
// { bullets }; { code, label, text } a sample ('curl' | 'powershell' | 'json' | 'text');
// { table: { head, rows } }; { note }.
//
// TEACHES lists every endpoint the guide shows, so a test can hold it to lib/openapi.js: a
// sample for a call that does not exist, or that moved, fails the build rather than a reader.

const TEACHES = [
  ['GET', '/me'], ['GET', '/libraries'], ['GET', '/libraries/{id}/files'],
  ['PUT', '/libraries/{id}/files/{path}'], ['GET', '/files/{id}'], ['GET', '/files/{id}/content'],
  ['GET', '/libraries/{id}/folders/zip'], ['GET', '/search'],
  ['POST', '/files/{id}/links'], ['GET', '/files/{id}/links'], ['DELETE', '/files/{id}/links/{linkId}'],
  ['POST', '/libraries/{id}/shares'], ['GET', '/libraries/{id}/shares'], ['DELETE', '/libraries/{id}/shares/{shareId}'],
  ['POST', '/libraries/{id}/folders'], ['POST', '/libraries/{id}/folders/rename'], ['POST', '/libraries/{id}/folders/move'], ['DELETE', '/libraries/{id}/folders'],
  ['DELETE', '/files/{id}'], ['GET', '/trash'], ['POST', '/files/{id}/restore'],
  ['GET', '/activity'], ['POST', '/uploads'],
  ['GET', '/users'], ['PUT', '/users/{id}/disabled'], ['GET', '/admin/settings'], ['PATCH', '/admin/settings'],
  ['GET', '/admin/access-review.csv'], ['GET', '/admin/tokens'],
];

const TITLE = 'Using the Depot API';
const SUBTITLE = 'A plain guide for anyone who wants a script, a scheduled job or another system to work with Depot.';

function sections(origin = 'https://depot.example.com') {
  const O = origin.replace(/\/+$/, '');
  const A = `${O}/api/v1`;
  return [
    {
      id: 'start', title: 'What you can do with it',
      blocks: [
        { p: 'Anything you do in Depot on the website, a script can do too, as you: list folders, add and fetch files, search, make share links, share a library with someone, and follow what happened. An administrator\'s script can also run the workspace: people, settings, connections and the audit feed.' },
        { p: `Every call is an ordinary web request to **${A}/…**, over HTTPS, and every answer is JSON. There is nothing to install. If you can use curl, PowerShell, Python, Power Automate or any tool that makes web requests, you can use the API.` },
        { p: `This guide walks through the everyday tasks with copy-and-paste samples. The complete list of calls, with every field, is the **reference** at ${O}/api/docs, and the machine-readable description (OpenAPI) is at ${O}/api/v1/openapi.json.` },
      ],
    },
    {
      id: 'token', title: 'Step 1: make a token',
      blocks: [
        { p: 'A token is what a script signs in with. It stands for you: it can do no more than you can, and only what its scope allows. You need to be a contributor or an administrator to make one.' },
        { steps: [
          'In Depot, open **Settings** (the gear at the top right), then **You**, then **API tokens**.',
          'Name the token after what will use it, such as *Nightly report script*. Later, the activity log shows this name beside everything the token did.',
          'Pick a scope: **Read only** (list, search and download), **Read and write** (also add, change, delete and share) or, for administrators, **Admin** (also what the Admin page does). Choose the smallest one the job needs.',
          'Pick when it expires: 30 days, 90 days, a year (the usual choice) or never.',
          'Click **Create token** and **copy it now**. Depot shows it once and cannot show it again. Keep it like a password.',
        ] },
        { p: 'A token looks like `depot_` followed by 43 letters and digits. Revoke it from the same screen and it stops working at once. An administrator can see and revoke everyone\'s tokens under Admin.' },
        { note: 'One token per script, named for the script. When a job is finished with, revoke its token. Never paste a token into a chat, an email or a file others can read.' },
      ],
    },
    {
      id: 'first-call', title: 'Step 2: your first call',
      blocks: [
        { p: 'Every request carries the token in an `Authorization` header. Set the address and the token once, then ask Depot who you are. If the answer names you, everything is in place.' },
        { code: 'curl', text: `export DEPOT=${O}\nexport TOKEN=depot_YOUR_TOKEN\n\ncurl -s "$DEPOT/api/v1/me" -H "Authorization: Bearer $TOKEN"` },
        { code: 'powershell', text: `$Depot = '${O}'\n$Token = 'depot_YOUR_TOKEN'\n$H = @{ Authorization = "Bearer $Token" }\n\nInvoke-RestMethod -Uri "$Depot/api/v1/me" -Headers $H` },
        { code: 'json', text: `{\n  "user":  { "id": "7f3c…", "email": "you@example.com", "role": "contributor" },\n  "scope": "write",\n  "token": { "id": "a91d…", "name": "Nightly report script", "scope": "write" }\n}` },
        { p: 'A `401` answer means the token was missing, mistyped, expired or revoked. A `403` means the token\'s scope, or your own rights, do not allow that call.' },
        { note: 'On Windows, type `curl.exe` rather than `curl` inside PowerShell, where `curl` is a shortcut for a different command. Windows 10 and 11 include curl.exe.' },
      ],
    },
    {
      id: 'libraries', title: 'Find the library you want',
      blocks: [
        { p: 'Files live in libraries, as on the website. Most calls need a library\'s **id**, so list them first and note the id of the one you want.' },
        { code: 'curl', text: `curl -s "$DEPOT/api/v1/libraries" -H "Authorization: Bearer $TOKEN"` },
        { code: 'powershell', text: `(Invoke-RestMethod -Uri "$Depot/api/v1/libraries" -Headers $H).libraries | Format-Table name, id, my_access` },
        { code: 'json', text: `{\n  "libraries": [\n    { "id": "4d3e5f60-…", "name": "Finance", "personal": false, "owner_email": "pat@example.com", "my_access": "rw", "archived_at": null },\n    { "id": "9a1b2c3d-…", "name": "Jordan Lee", "personal": true, "owner_email": "you@example.com", "my_access": "owner", "archived_at": null }\n  ]\n}` },
        { p: '`my_access` says what you can do there: **owner** or **admin** (it is yours to manage), **rw** (add and change files), **r** (read only), **folders** (only certain folders are yours to open) or **listed** (you can see it exists, not what is in it).' },
      ],
    },
    {
      id: 'list', title: 'See what is in a folder',
      blocks: [
        { p: 'Ask for a folder by its path. Leave `folder` out for the top of the library. The answer lists the folders inside it and the files directly in it; add `recursive=true` for everything underneath.' },
        { code: 'curl', text: `curl -s "$DEPOT/api/v1/libraries/<library-id>/files?folder=Reports/2026" -H "Authorization: Bearer $TOKEN"` },
        { code: 'powershell', text: `$r = Invoke-RestMethod -Uri "$Depot/api/v1/libraries/<library-id>/files?folder=Reports/2026" -Headers $H\n$r.folders | Format-Table name, count\n$r.files   | Format-Table name, size, modified_at, id` },
        { code: 'json', text: `{\n  "library_id": "4d3e5f60-…", "folder": "Reports/2026", "recursive": false,\n  "folders": [ { "path": "Reports/2026/Q1", "name": "Q1", "count": 12 } ],\n  "files": [\n    { "id": "0c2e…", "name": "Budget.xlsx", "path": "Reports/2026/Budget.xlsx", "folder": "Reports/2026",\n      "size": 38912, "mime_type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",\n      "modified_at": "2026-10-14T09:12:40.000Z", "content_hash": "3b7e…" }\n  ]\n}` },
        { p: 'Every file carries an **id** (use it to download, share or delete the file), its **path**, its **size** in bytes, when it was last changed (**modified_at**) and a fingerprint of its bytes (**content_hash**). Two files with the same hash hold the same bytes. Long folders come in pages: add `limit` and `offset`.' },
      ],
    },
    {
      id: 'upload', title: 'Add a file',
      blocks: [
        { p: 'Send the file\'s bytes with PUT to the path where it should live. Folders along the way are made as needed. Say the file\'s type in `Content-Type` when you know it; `application/octet-stream` is fine when you do not.' },
        { code: 'curl', text: `curl -s -X PUT "$DEPOT/api/v1/libraries/<library-id>/files/Reports/2026/Q1%20report.pdf" \\\n  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/pdf" \\\n  --data-binary @"Q1 report.pdf"` },
        { code: 'powershell', text: `$name = [uri]::EscapeDataString('Q1 report.pdf')\nInvoke-RestMethod -Method Put -Uri "$Depot/api/v1/libraries/<library-id>/files/Reports/2026/$name" \`\n  -Headers $H -ContentType 'application/pdf' -InFile 'C:\\Reports\\Q1 report.pdf'` },
        { p: 'The answer is the new file, under `doc`, with its id. Names with spaces or other special characters are URL-encoded, one folder or file name at a time (`Q1%20report.pdf`); the slashes between folders stay as they are.' },
        { p: 'If a live file is already at that path, the answer is `409` and carries its id. Either choose another name, or add `?replace=true` to put the new bytes into that file: it keeps its id and its place, what it held is kept as a version, and identical bytes change nothing (the answer then says `"unchanged": true`).' },
        { code: 'curl', text: `curl -s -X PUT "$DEPOT/api/v1/libraries/<library-id>/files/Reports/2026/Q1%20report.pdf?replace=true" \\\n  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/pdf" --data-binary @"Q1 report.pdf"` },
        { p: 'Files over the server\'s upload limit answer `413`. For those, and for weak connections, use the resumable upload: `POST /uploads` with the path, library and size opens a session, each chunk goes with PUT, and `POST /uploads/{id}/complete` finishes it. Chunks can be sent again and in any order. The reference has the details.' },
        { p: 'A `415` means an administrator has refused that file type under Settings, Network, limits and calls (blocked upload types).' },
      ],
    },
    {
      id: 'download', title: 'Get a file back',
      blocks: [
        { p: 'Download by the file\'s id. The bytes come back as they were uploaded, and a download can resume with a `Range` header.' },
        { code: 'curl', text: `curl -s "$DEPOT/api/v1/files/<file-id>/content" -H "Authorization: Bearer $TOKEN" -o "Q1 report.pdf"` },
        { code: 'powershell', text: `Invoke-WebRequest -Uri "$Depot/api/v1/files/<file-id>/content" -Headers $H -OutFile 'C:\\Reports\\Q1 report.pdf'` },
        { p: 'A file\'s details alone (name, path, size, who added it) are at `GET /files/{id}`. A whole folder comes as one ZIP:' },
        { code: 'curl', text: `curl -s "$DEPOT/api/v1/libraries/<library-id>/folders/zip?path=Reports/2026" -H "Authorization: Bearer $TOKEN" -o Reports-2026.zip` },
      ],
    },
    {
      id: 'search', title: 'Search',
      blocks: [
        { p: 'Search looks through file names and the text inside files, in every library you can open, and finds folders by name too.' },
        { code: 'curl', text: `curl -s -G "$DEPOT/api/v1/search" --data-urlencode "q=northfield proposal" -H "Authorization: Bearer $TOKEN"` },
        { code: 'powershell', text: `$q = [uri]::EscapeDataString('northfield proposal')\n$r = Invoke-RestMethod -Uri "$Depot/api/v1/search?q=$q" -Headers $H\n$r.folders | Format-Table library_name, path\n$r.files   | Format-Table name, path, library_id` },
        { p: 'The answer has `folders` (each saying which library it is in) and `files`, best match first, up to 100 files and 50 folders.' },
      ],
    },
    {
      id: 'links', title: 'Share a file with a link',
      blocks: [
        { p: 'A share link lets anyone with the link open the file, with no Depot account. It expires after 7 days unless you say otherwise (up to 365, or never), and it can carry a password.' },
        { code: 'curl', text: `curl -s -X POST "$DEPOT/api/v1/files/<file-id>/links" -H "Authorization: Bearer $TOKEN" \\\n  -H "Content-Type: application/json" -d '{"expires_in_days": 30, "password": "autumn-leaves"}'` },
        { code: 'powershell', text: `$body = @{ expires_in_days = 30; password = 'autumn-leaves' } | ConvertTo-Json\n(Invoke-RestMethod -Method Post -Uri "$Depot/api/v1/files/<file-id>/links" -Headers $H -ContentType 'application/json' -Body $body).share.url` },
        { code: 'json', text: `{ "share": { "id": "c5d1…", "url": "${O}/s/K3f9…", "expires_at": "2026-11-16T09:12:40.000Z" } }` },
        { p: 'Send the `url` to whoever should have it. `GET /files/{id}/links` lists a file\'s links, and `DELETE /files/{id}/links/{linkId}` revokes one: it stops working at once.' },
      ],
    },
    {
      id: 'shares', title: 'Share a library or a folder with a person',
      blocks: [
        { p: 'Sharing with a person (or a group) gives them the library, or one folder in it, at **read** or **write**. Files added later are covered, and they are told by email. Only the library\'s owner or an administrator can do this.' },
        { code: 'curl', text: `curl -s -X POST "$DEPOT/api/v1/libraries/<library-id>/shares" -H "Authorization: Bearer $TOKEN" \\\n  -H "Content-Type: application/json" -d '{"email": "pat@example.com", "permission": "read", "folder": "Reports/2026"}'` },
        { code: 'powershell', text: `$body = @{ email = 'pat@example.com'; permission = 'read'; folder = 'Reports/2026' } | ConvertTo-Json\nInvoke-RestMethod -Method Post -Uri "$Depot/api/v1/libraries/<library-id>/shares" -Headers $H -ContentType 'application/json' -Body $body` },
        { p: 'Leave `folder` out to share the whole library, or send `group_id` instead of `email` to share with a group. `GET /libraries/{id}/shares` lists who has what, and `DELETE /libraries/{id}/shares/{shareId}` takes a share back.' },
      ],
    },
    {
      id: 'folders', title: 'Folders',
      blocks: [
        { p: 'Folders are made by path, and any missing parents are made with them. Renaming or moving a folder carries everything in it, and its shares, along.' },
        { code: 'curl', text: `# make\ncurl -s -X POST "$DEPOT/api/v1/libraries/<library-id>/folders" -H "Authorization: Bearer $TOKEN" \\\n  -H "Content-Type: application/json" -d '{"path": "Reports/2027"}'\n\n# rename Reports/2027 to Reports/Next year\ncurl -s -X POST "$DEPOT/api/v1/libraries/<library-id>/folders/rename" -H "Authorization: Bearer $TOKEN" \\\n  -H "Content-Type: application/json" -d '{"path": "Reports/2027", "name": "Next year"}'\n\n# move it under Archive (an empty to_folder means the top of the library)\ncurl -s -X POST "$DEPOT/api/v1/libraries/<library-id>/folders/move" -H "Authorization: Bearer $TOKEN" \\\n  -H "Content-Type: application/json" -d '{"path": "Reports/Next year", "to_folder": "Archive"}'\n\n# delete it (to the Trash, with everything in it)\ncurl -s -X DELETE "$DEPOT/api/v1/libraries/<library-id>/folders?path=Archive/Next%20year" -H "Authorization: Bearer $TOKEN"` },
        { code: 'powershell', text: `Invoke-RestMethod -Method Post -Uri "$Depot/api/v1/libraries/<library-id>/folders" -Headers $H \`\n  -ContentType 'application/json' -Body (@{ path = 'Reports/2027' } | ConvertTo-Json)` },
      ],
    },
    {
      id: 'trash', title: 'Delete and restore',
      blocks: [
        { p: 'Deleting a file moves it to the Trash, where it can be restored until the trash retention runs out, as on the website.' },
        { code: 'curl', text: `curl -s -X DELETE "$DEPOT/api/v1/files/<file-id>" -H "Authorization: Bearer $TOKEN"\ncurl -s "$DEPOT/api/v1/trash" -H "Authorization: Bearer $TOKEN"\ncurl -s -X POST "$DEPOT/api/v1/files/<file-id>/restore" -H "Authorization: Bearer $TOKEN"` },
        { code: 'powershell', text: `Invoke-RestMethod -Method Delete -Uri "$Depot/api/v1/files/<file-id>" -Headers $H\n(Invoke-RestMethod -Uri "$Depot/api/v1/trash" -Headers $H).files | Format-Table name, path\nInvoke-RestMethod -Method Post -Uri "$Depot/api/v1/files/<file-id>/restore" -Headers $H` },
      ],
    },
    {
      id: 'activity', title: 'Keep another system in step',
      blocks: [
        { p: 'To mirror Depot somewhere else, or to react when something changes, ask what happened since you last looked. Events come newest first; remember the newest `at` you have seen and send it as `since` next time.' },
        { code: 'curl', text: `curl -s "$DEPOT/api/v1/activity?since=2026-10-16T00:00:00Z&limit=200" -H "Authorization: Bearer $TOKEN"` },
        { code: 'powershell', text: `$since = (Get-Date).AddDays(-1).ToUniversalTime().ToString('o')\n(Invoke-RestMethod -Uri "$Depot/api/v1/activity?since=$since&limit=200" -Headers $H).events | Format-Table at, type, actor_email, path` },
        { code: 'json', text: `{\n  "since": "2026-10-16T00:00:00Z",\n  "events": [\n    { "id": "e1…", "type": "uploaded", "actor_email": "pat@example.com", "detail": null,\n      "at": "2026-10-16T14:02:11.000Z", "file_id": "0c2e…", "path": "Reports/2026/Budget.xlsx" }\n  ]\n}` },
        { p: 'To copy only what changed, compare each file\'s `content_hash` with the one you kept: the same hash means the same bytes, so there is nothing to fetch. A poll every few minutes is plenty; each token may make 6,000 requests per 15 minutes.' },
      ],
    },
    {
      id: 'admin', title: 'For administrators',
      blocks: [
        { p: 'With an **admin** token, a script can do what the Admin page does. A few of the useful ones:' },
        { code: 'curl', text: `# everyone who has signed in, with roles\ncurl -s "$DEPOT/api/v1/users" -H "Authorization: Bearer $TOKEN"\n\n# switch a leaver off: sign-in refused, their links and tokens stop, their own library put away\ncurl -s -X PUT "$DEPOT/api/v1/users/pat@example.com/disabled" -H "Authorization: Bearer $TOKEN" \\\n  -H "Content-Type: application/json" -d '{"disabled": true, "reason": "left the company"}'\n\n# read the workspace settings, and change one\ncurl -s "$DEPOT/api/v1/admin/settings" -H "Authorization: Bearer $TOKEN"\ncurl -s -X PATCH "$DEPOT/api/v1/admin/settings" -H "Authorization: Bearer $TOKEN" \\\n  -H "Content-Type: application/json" -d '{"max_upload_mb": "4096"}'\n\n# the access review as a spreadsheet, and every live token\ncurl -s "$DEPOT/api/v1/admin/access-review.csv" -H "Authorization: Bearer $TOKEN" -o access-review.csv\ncurl -s "$DEPOT/api/v1/admin/tokens" -H "Authorization: Bearer $TOKEN"` },
        { p: 'Four things are changed in Depot itself and never through the API: the storage encryption key, the sign-in methods, backup destinations and updates. Everything an admin token changes goes in the audit feed, as you, marked with the token\'s name.' },
      ],
    },
    {
      id: 'errors', title: 'When something goes wrong',
      blocks: [
        { p: 'An error is JSON with the reason in plain words, `{ "error": "File not found" }`, and one of the usual status codes:' },
        { table: { head: ['Code', 'What it means', 'What to do'], rows: [
          ['400', 'The request itself was wrong: a missing field, a bad value.', 'Check the body and the parameters against the reference.'],
          ['401', 'No token, or a token Depot does not know (mistyped, expired, revoked).', 'Check the Authorization header; make a new token if it has expired.'],
          ['403', 'The token\'s scope, or your own rights, do not allow it. A disabled account answers this too.', 'Use a token with a bigger scope, or ask the owner for access.'],
          ['404', 'Not there, or not yours to see. Depot does not say which.', 'Check the id. A file in someone else\'s private library looks the same as no file.'],
          ['409', 'Something is in the way: a file already at that path, or a change made meanwhile.', 'Use another name, send replace=true, or fetch the current state and try again.'],
          ['413', 'Too big for the server\'s upload limit.', 'Use the resumable upload, or ask an administrator to raise the limit.'],
          ['415', 'That file type is refused here.', 'An administrator can allow it under Settings, Network, limits and calls.'],
          ['429', 'Too many requests from this token in 15 minutes.', 'Wait the seconds given in the Retry-After header, then carry on.'],
        ] } },
        { p: 'Some answers also carry a `code` you can test for in a script: `FILE_TYPE_BLOCKED` (415), `FILE_CHANGED` (409, when a file was changed by someone else meanwhile) and `ACCOUNT_DISABLED` (403).' },
      ],
    },
    {
      id: 'habits', title: 'Good habits',
      blocks: [
        { bullets: [
          'One token per script, named for the script, with the smallest scope that does the job. Give a one-off job a short expiry.',
          'Keep the token out of the script: read it from an environment variable or a secrets store, never from a file in version control.',
          'Use HTTPS, always. A token sent over plain HTTP can be read on the way.',
          'URL-encode names (`Q1%20report.pdf`), one segment at a time, and keep the slashes between folders.',
          'Use `content_hash` and `modified_at` to skip work: do not download or upload what has not changed.',
          'Poll `activity` every few minutes rather than every second, and honour `Retry-After` when you see a 429.',
          'Check the activity log in Depot after a first run: everything the token did is there under your name, marked with the token\'s name.',
        ] },
      ],
    },
    {
      id: 'example', title: 'A complete example: a nightly upload',
      blocks: [
        { p: 'A PowerShell script, fit for Task Scheduler, that puts every PDF in a folder into the *Finance* library under *Reports/2026*, replacing any that are already there. It takes its token from an environment variable called `DEPOT_TOKEN`.' },
        { code: 'powershell', text: `$Depot = '${O}'\n$Token = $env:DEPOT_TOKEN                    # a read-and-write token, set outside the script\n$H = @{ Authorization = "Bearer $Token" }\n\n$lib = (Invoke-RestMethod -Uri "$Depot/api/v1/libraries" -Headers $H).libraries | Where-Object name -eq 'Finance'\nif (-not $lib) { throw 'No library called Finance' }\n\nGet-ChildItem 'C:\\Reports\\*.pdf' | ForEach-Object {\n  $name = [uri]::EscapeDataString($_.Name)\n  $url  = "$Depot/api/v1/libraries/$($lib.id)/files/Reports/2026/$name?replace=true"\n  $r = Invoke-RestMethod -Method Put -Uri $url -Headers $H -ContentType 'application/pdf' -InFile $_.FullName\n  "{0}  ->  {1}" -f $_.Name, $r.doc.id\n}` },
        { p: 'The same in a shell script, for a Mac or Linux machine:' },
        { code: 'curl', text: `#!/bin/sh\nDEPOT=${O}\nTOKEN="$DEPOT_TOKEN"\nLIB=$(curl -s "$DEPOT/api/v1/libraries" -H "Authorization: Bearer $TOKEN" | python3 -c 'import sys,json; print(next(l["id"] for l in json.load(sys.stdin)["libraries"] if l["name"]=="Finance"))')\n\nfor f in /srv/reports/*.pdf; do\n  name=$(python3 -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1]))' "$(basename "$f")")\n  curl -s -X PUT "$DEPOT/api/v1/libraries/$LIB/files/Reports/2026/$name?replace=true" \\\n    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/pdf" --data-binary @"$f" > /dev/null\n  echo "$(basename "$f") uploaded"\ndone` },
      ],
    },
    {
      id: 'drive', title: 'If you only want the files on a computer',
      blocks: [
        { p: `You may not need the API at all. Depot can be opened as a drive on a computer: each library is a folder, and files open and save as they do anywhere else. You sign in the way you do on the website, so no token is needed. See **Connect as a drive** in the reference at ${O}/api/docs#drive.` },
      ],
    },
    {
      id: 'more', title: 'Everything else',
      blocks: [
        { p: `The reference at ${O}/api/docs lists every call: groups, who can open what and why, moving and copying between libraries, resumable uploads, the compliance and audit calls, connections, and more. Each call says which scope it needs.` },
        { p: 'Version 1 only grows. Fields and calls may be added; nothing that exists changes shape, so a script written today keeps working. A breaking change would ship as a separate version 2 beside this one.' },
      ],
    },
  ];
}

module.exports = { TITLE, SUBTITLE, TEACHES, sections };

'use strict';
// The public API's description (OpenAPI 3.1), served at /api/v1/openapi.json and rendered
// at /api/docs. Written by hand, next to the routes it describes (routes/v1.js); a test
// checks that every route the router registers is described here, and the other way round.

const FILE = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    name: { type: 'string', description: 'The file name on its own' },
    path: { type: 'string', description: 'Folder path and file name, such as Reports/2026/q1.pdf' },
    folder: { type: 'string', description: 'The folder it is in; empty at the library root' },
    size: { type: 'integer', description: 'Bytes' },
    mime_type: { type: 'string', nullable: true },
    library_id: { type: 'string', format: 'uuid', nullable: true },
    library_content: { type: 'boolean', description: 'True when the file belongs to the library (shared with the library), false when it is the uploader\'s own' },
    uploaded_by: { type: 'string', format: 'uuid', nullable: true },
    uploaded_by_email: { type: 'string', nullable: true },
    content_hash: { type: 'string', nullable: true, description: 'sha256 of the bytes, in hex; null for a file whose hash was never computed (a large file added before release 3)' },
    modified_at: { type: 'string', format: 'date-time', description: 'When the bytes last changed; the same as created_at until they do' },
    created_at: { type: 'string', format: 'date-time' },
    deleted_at: { type: 'string', format: 'date-time', nullable: true },
  },
};
const FOLDER = { type: 'object', properties: { path: { type: 'string' }, name: { type: 'string' }, count: { type: 'integer', description: 'Files under it, at any depth' } } };
const LIBRARY = { type: 'object', properties: { id: { type: 'string', format: 'uuid' }, name: { type: 'string' }, personal: { type: 'boolean' }, owner_email: { type: 'string', nullable: true }, my_access: { type: 'string', description: "'owner', 'admin', 'rw', 'r', 'folders' or 'listed'" }, archived_at: { type: 'string', format: 'date-time', nullable: true } } };
const ERROR = { type: 'object', properties: { error: { type: 'string' } } };
const ok = (description, schema) => ({ description, content: { 'application/json': { schema } } });
const err = (description) => ({ description, content: { 'application/json': { schema: ERROR } } });
const idParam = (name, description) => ({ name, in: 'path', required: true, schema: { type: 'string', format: 'uuid' }, description });
const json = (schema, required = []) => ({ required: true, content: { 'application/json': { schema: { ...schema, required } } } });
const op = (tag, scope, summary, description, extra = {}) => ({ tags: [tag], summary, description: `${description}\n\nScope: **${scope}**.`, 'x-scope': scope, responses: { 401: err('No sign-in or token, or the token is revoked or expired'), 403: err('The token\'s scope or the person\'s rights do not allow it'), ...(extra.responses || {}) }, ...Object.fromEntries(Object.entries(extra).filter(([k]) => k !== 'responses')) });

const paths = {
  '/me': { get: op('Account', 'read', 'Who the caller is', 'The person the token acts as, the scope in force, and the token itself when one was used.',
    { responses: { 200: ok('The caller', { type: 'object', properties: { user: { type: 'object', properties: { id: { type: 'string' }, email: { type: 'string' }, role: { type: 'string', enum: ['admin', 'contributor', 'viewer'] } } }, scope: { type: 'string', enum: ['read', 'write', 'admin'] }, token: { type: 'object', nullable: true, properties: { id: { type: 'string' }, name: { type: 'string' }, scope: { type: 'string' }, expires_at: { type: 'string', nullable: true } } } } }) } }) },

  '/libraries': {
    get: op('Libraries', 'read', 'List libraries', 'Every library the caller can open, with their access to each.', { responses: { 200: ok('Libraries', { type: 'object', properties: { libraries: { type: 'array', items: LIBRARY } } }) } }),
    post: op('Libraries', 'write', 'Create a library', 'A new library owned by the caller. Contributors and administrators only.', { requestBody: json({ type: 'object', properties: { name: { type: 'string' } } }, ['name']), responses: { 200: ok('The new library', LIBRARY), 400: err('No name') } }),
  },
  '/libraries/{id}': {
    get: op('Libraries', 'read', 'One library', 'A library the caller can open.', { parameters: [idParam('id', 'Library id')], responses: { 200: ok('The library', LIBRARY), 404: err('Not found, or not yours to see') } }),
    patch: op('Libraries', 'write', 'Rename a library', 'Only its owner (while a contributor) or an administrator.', { parameters: [idParam('id', 'Library id')], requestBody: json({ type: 'object', properties: { name: { type: 'string' } } }, ['name']), responses: { 200: ok('The library', LIBRARY), 404: err('Not found, or not yours to manage') } }),
  },
  '/libraries/{id}/files': {
    get: op('Files', 'read', 'List a folder', 'The files directly in a folder (or, with recursive=true, everything under it) and the folders inside it. Folder markers are not files. Paged by limit and offset.',
      { parameters: [idParam('id', 'Library id'), { name: 'folder', in: 'query', schema: { type: 'string' }, description: 'Folder path; leave out for the root' }, { name: 'recursive', in: 'query', schema: { type: 'boolean' } }, { name: 'limit', in: 'query', schema: { type: 'integer', default: 1000, maximum: 5000 } }, { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 } }],
        responses: { 200: ok('The listing', { type: 'object', properties: { library_id: { type: 'string' }, folder: { type: 'string' }, recursive: { type: 'boolean' }, folders: { type: 'array', items: FOLDER }, files: { type: 'array', items: FILE }, total: { type: 'integer' }, limit: { type: 'integer' }, offset: { type: 'integer' } } }) } }),
  },
  '/libraries/{id}/files/{path}': {
    put: op('Files', 'write', 'Upload a file in one request', 'The request body is the file. Send Content-Type: application/octet-stream (or the file\'s own type) and Content-Length. Folders in the path are made as needed. A live file already at that path is a 409 carrying its id: rename or delete it first, choose another path, or send replace=true to put these bytes into that file (it keeps its id and place, what it held is kept as a version, and identical bytes change nothing). Files over the server\'s upload limit are refused; for very large files use the resumable upload.',
      { parameters: [idParam('id', 'Library id'), { name: 'path', in: 'path', required: true, schema: { type: 'string' }, description: 'Folder path and file name, URL-encoded per segment, such as Reports%2F2026%2Fq1.pdf or Reports/2026/q1.pdf' }, { name: 'replace', in: 'query', schema: { type: 'boolean', default: false }, description: 'true: a file already at this path takes these bytes' }],
        requestBody: { required: true, content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } },
        responses: { 200: ok('The stored file', { type: 'object', properties: { doc: FILE, replaced: { type: 'boolean', description: 'true when an existing file took these bytes' }, unchanged: { type: 'boolean', description: 'true when the file already held exactly these bytes' } } }), 409: ok('A file is already at that path (and replace was not asked for)', { type: 'object', properties: { error: { type: 'string' }, existing_id: { type: 'string' } } }), 413: err('Over the upload limit'), 415: err('A file type the workspace refuses') } }),
  },
  '/files/{id}': {
    get: op('Files', 'read', 'A file\'s details', 'Name, path, size and who added it.', { parameters: [idParam('id', 'File id')], responses: { 200: ok('The file', FILE), 404: err('Not found, or not yours to see') } }),
    patch: op('Files', 'write', 'Rename or move a file', 'Give a new name, a new folder in the same library, or both. Moving needs the right to add files where it lands.', { parameters: [idParam('id', 'File id')], requestBody: json({ type: 'object', properties: { name: { type: 'string', description: 'The file name only' }, folder: { type: 'string', description: 'Folder path; empty string for the root' } } }), responses: { 200: ok('Done', { type: 'object', properties: { success: { type: 'boolean' }, name: { type: 'string', description: 'The full path now' } } }), 404: err('Not found'), 409: err('The file changed meanwhile; read it again') } }),
    delete: op('Files', 'write', 'Move a file to the trash', 'It can be restored until the trash retention runs out.', { parameters: [idParam('id', 'File id')], responses: { 200: ok('Done', { type: 'object', properties: { success: { type: 'boolean' } } }), 404: err('Not found') } }),
  },
  '/files/{id}/content': {
    get: op('Files', 'read', 'Download a file', 'The bytes, as an attachment. Range requests are honoured, so a download can resume.', { parameters: [idParam('id', 'File id'), { name: 'Range', in: 'header', schema: { type: 'string' }, description: 'Optional, such as bytes=0-1023' }], responses: { 200: { description: 'The file', content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } }, 206: { description: 'The requested range' }, 404: err('Not found') } }),
    put: op('Files', 'write', 'Replace a file\'s content', 'The request body is the new bytes. The file keeps its id, name and place; what it held is kept as a version; identical bytes change nothing. The type stays unless Content-Type names a real one.', { parameters: [idParam('id', 'File id')], requestBody: { required: true, content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } }, responses: { 200: ok('The file now', { type: 'object', properties: { doc: FILE, replaced: { type: 'boolean' }, unchanged: { type: 'boolean' } } }), 404: err('Not found, or not yours to change'), 413: err('Over the upload limit') } }),
  },
  '/files/{id}/restore': {
    post: op('Files', 'write', 'Restore a file from the trash', 'Puts it back where it was.', { parameters: [idParam('id', 'File id')], responses: { 200: ok('Done', { type: 'object', properties: { success: { type: 'boolean' } } }), 404: err('Not in the trash') } }),
  },
  '/trash': {
    get: op('Files', 'write', 'List the trash', 'Trashed files the caller could change.', { responses: { 200: ok('Trashed files', { type: 'object', properties: { files: { type: 'array', items: FILE } } }) } }),
  },
  '/search': {
    get: op('Files', 'read', 'Search', 'Files whose name or indexed text matches, across every library the caller can open. Up to 100.', { parameters: [{ name: 'q', in: 'query', required: true, schema: { type: 'string' } }], responses: { 200: ok('Matches', { type: 'object', properties: { q: { type: 'string' }, files: { type: 'array', items: { allOf: [FILE, { type: 'object', properties: { headline: { type: 'string', nullable: true, description: 'Matching text, with <<...>> around the hits' } } }] } } } }), 400: err('No q') } }),
  },
  '/files/{id}/links': {
    get: op('Share links', 'write', 'List a file\'s share links', 'Everyone\'s links for someone who manages the file; otherwise the caller\'s own.', { parameters: [idParam('id', 'File id')], responses: { 200: ok('Links', { type: 'object', properties: { scope: { type: 'string' }, shares: { type: 'array', items: { type: 'object' } } } }), 404: err('Not found') } }),
    post: op('Share links', 'write', 'Make a share link', 'A link anyone can open, optionally with a password. Expires after expires_in_days (default 7, at most 365) unless never_expires is true.', { parameters: [idParam('id', 'File id')], requestBody: json({ type: 'object', properties: { expires_in_days: { type: 'integer' }, never_expires: { type: 'boolean' }, password: { type: 'string' } } }), responses: { 200: ok('The link', { type: 'object', properties: { share: { type: 'object', properties: { id: { type: 'string' }, url: { type: 'string' }, expires_at: { type: 'string', nullable: true } } } } }), 404: err('Not found') } }),
  },
  '/files/{id}/links/{linkId}': {
    delete: op('Share links', 'write', 'Revoke a share link', 'The link stops working at once.', { parameters: [idParam('id', 'File id'), idParam('linkId', 'Link id')], responses: { 200: ok('Done', { type: 'object', properties: { success: { type: 'boolean' } } }), 404: err('Not found') } }),
  },
  '/libraries/{id}/folders': {
    post: op('Folders', 'write', 'Create a folder', 'Makes the folder (and any missing parents) in the library.', { parameters: [idParam('id', 'Library id')], requestBody: json({ type: 'object', properties: { path: { type: 'string' } } }, ['path']), responses: { 200: ok('Done', { type: 'object', properties: { ok: { type: 'boolean' }, path: { type: 'string' } } }), 400: err('No path') } }),
    delete: op('Folders', 'write', 'Delete a folder', 'Moves the folder and everything in it to the trash. Send the path in the JSON body or as ?path=.', { parameters: [idParam('id', 'Library id'), { name: 'path', in: 'query', schema: { type: 'string' } }], requestBody: { required: false, content: { 'application/json': { schema: { type: 'object', properties: { path: { type: 'string' } } } } } }, responses: { 200: ok('Done', { type: 'object' }), 404: err('No such folder') } }),
  },
  '/libraries/{id}/folders/rename': {
    post: op('Folders', 'write', 'Rename a folder', 'Everything in it moves with it; shares of the folder follow it.', { parameters: [idParam('id', 'Library id')], requestBody: json({ type: 'object', properties: { path: { type: 'string' }, name: { type: 'string', description: 'The new name of the folder itself' } } }, ['path', 'name']), responses: { 200: ok('Done', { type: 'object' }), 404: err('No such folder') } }),
  },
  '/libraries/{id}/folders/move': {
    post: op('Folders', 'write', 'Move a folder', 'With to_library_id: to another library, keeping its path there. With to_folder: under another folder of this library (an empty string for the root). One or the other.', { parameters: [idParam('id', 'Source library id')], requestBody: json({ type: 'object', properties: { path: { type: 'string' }, to_library_id: { type: 'string', format: 'uuid' }, to_folder: { type: 'string', description: 'A folder path in this library; empty for the root' } } }, ['path']), responses: { 200: ok('Done', { type: 'object' }), 400: err('Both given, or a move into itself'), 404: err('No such folder') } }),
  },
  '/libraries/{id}/folders/copy': {
    post: op('Folders', 'write', 'Copy a folder to another library', 'Copies every file under it, keeping their paths, as new files in the other library. The caller needs the right to add files there.', { parameters: [idParam('id', 'Source library id')], requestBody: json({ type: 'object', properties: { path: { type: 'string' }, to_library_id: { type: 'string', format: 'uuid' } } }, ['path', 'to_library_id']), responses: { 200: ok('Done', { type: 'object', properties: { ok: { type: 'boolean' }, count: { type: 'integer', description: 'Files copied' } } }), 404: err('No such folder, or nothing in it'), 413: err('Too many files to copy at once') } }),
  },
  '/libraries/{id}/folders/zip': {
    get: op('Folders', 'read', 'Download a folder as a ZIP', 'Every file under the folder that the caller can read, streamed as one ZIP. Folders over the server\'s ZIP limit are refused.', { parameters: [idParam('id', 'Library id'), { name: 'path', in: 'query', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'The ZIP', content: { 'application/zip': { schema: { type: 'string', format: 'binary' } } } }, 404: err('No such folder, or nothing in it'), 413: err('Too large for one ZIP'), 503: err('Too many ZIPs being made right now; try again shortly') } }),
  },
  '/uploads': {
    post: op('Resumable uploads', 'write', 'Start a resumable upload', 'For big files or weak links. Say the path, library, size and type; the answer gives the session id, chunk size and how many chunks to send. Then PUT each chunk and POST complete.', { requestBody: json({ type: 'object', properties: { path: { type: 'string' }, library_id: { type: 'string', format: 'uuid' }, size: { type: 'integer' }, mime_type: { type: 'string' }, chunk_size: { type: 'integer', description: 'Optional; the server clamps it' } } }, ['path', 'library_id', 'size']), responses: { 200: ok('The session', { type: 'object', properties: { session: { type: 'object' } } }), 413: err('Over the upload limit') } }),
  },
  '/uploads/{id}': {
    get: op('Resumable uploads', 'write', 'Where an upload stands', 'Which chunks have arrived, so a client can resume.', { parameters: [idParam('id', 'Upload session id')], responses: { 200: ok('The session', { type: 'object' }), 404: err('No such session') } }),
    delete: op('Resumable uploads', 'write', 'Abandon an upload', 'Discards the chunks received so far.', { parameters: [idParam('id', 'Upload session id')], responses: { 200: ok('Done', { type: 'object' }), 404: err('No such session') } }),
  },
  '/uploads/{id}/chunks/{index}': {
    put: op('Resumable uploads', 'write', 'Send one chunk', 'The body is the chunk\'s bytes (Content-Type: application/octet-stream). Chunks may arrive in any order and be sent again.', { parameters: [idParam('id', 'Upload session id'), { name: 'index', in: 'path', required: true, schema: { type: 'integer' }, description: 'From 0' }], requestBody: { required: true, content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } }, responses: { 200: ok('Received', { type: 'object' }), 400: err('Wrong size for that chunk'), 404: err('No such session') } }),
  },
  '/uploads/{id}/complete': {
    post: op('Resumable uploads', 'write', 'Finish an upload', 'Joins the chunks into the file. Safe to send again: a finished upload answers with the file it made.', { parameters: [idParam('id', 'Upload session id')], responses: { 200: ok('The stored file', { type: 'object', properties: { doc: FILE } }), 400: err('Chunks missing'), 404: err('No such session') } }),
  },
  '/activity': {
    get: op('Activity', 'read', 'What happened', 'Events on files the caller can see (an administrator: everything), newest first. Poll it with since set to the newest time you have seen.', { parameters: [{ name: 'since', in: 'query', schema: { type: 'string', format: 'date-time' } }, { name: 'limit', in: 'query', schema: { type: 'integer', default: 100, maximum: 500 } }], responses: { 200: ok('Events', { type: 'object', properties: { since: { type: 'string', nullable: true }, events: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, type: { type: 'string' }, actor_email: { type: 'string', nullable: true }, detail: { type: 'string', nullable: true }, at: { type: 'string', format: 'date-time' }, file_id: { type: 'string', nullable: true }, path: { type: 'string', nullable: true }, library_id: { type: 'string', nullable: true } } } } } }) } }),
  },
};

// ---- release 2: people, groups, sharing and administration ----
const T = { str: { type: 'string' }, uuid: { type: 'string', format: 'uuid' }, dt: { type: 'string', format: 'date-time' }, bool: { type: 'boolean' }, int: { type: 'integer' }, nstr: { type: 'string', nullable: true }, ndt: { type: 'string', format: 'date-time', nullable: true }, obj: { type: 'object' } };
const ROLE = { type: 'string', enum: ['admin', 'contributor', 'viewer'] };
const LEVEL = { type: 'string', enum: ['read', 'write'] };
const USER = { type: 'object', properties: { user_id: T.uuid, email: T.str, role: ROLE, assigned_at: T.dt, disabled_at: T.ndt, disabled_reason: T.nstr } };
const GROUP = { type: 'object', properties: { id: T.uuid, name: T.str, owner_id: T.uuid, owner_email: T.str, created_at: T.dt, can_manage: T.bool } };
const GROUP_LISTED = { type: 'object', properties: { ...GROUP.properties, member_count: T.int, is_member: T.bool } };
const GROUP_MEMBER = { type: 'object', properties: { id: { type: 'string', format: 'uuid', description: 'The membership, for removing it' }, member_email: T.str, display_name: T.nstr, has_signed_in: T.bool, added_by_email: T.nstr, created_at: T.dt } };
const SHARE = { type: 'object', properties: { id: T.uuid, library_id: T.uuid, folder_path: { type: 'string', description: 'Empty for the whole library' }, subject_type: { type: 'string', enum: ['user', 'group'] }, subject_email: T.nstr, group: { type: 'object', nullable: true, properties: { id: T.uuid, name: T.str, owner_email: T.str, member_count: T.int } }, permission: LEVEL, granted_by_email: T.str, created_at: T.dt, updated_at: T.dt, account: { type: 'string', nullable: true, enum: ['ok', 'unverified', 'none'], description: "For a person: whether the address belongs to a verified account (a share only ever matches a verified address)" }, folder_present: T.bool, folder_state: T.nstr } };
const GRANT = { type: 'object', properties: { id: T.uuid, document_id: T.uuid, subject_email: T.str, permission: { type: 'string', enum: ['read', 'write', 'admin'] }, granted_by_email: T.str, created_at: T.dt } };
const TOKEN = { type: 'object', properties: { id: T.uuid, name: T.str, prefix: T.str, scope: { type: 'string', enum: ['read', 'write', 'admin'] }, created_at: T.dt, expires_at: T.ndt, last_used_at: T.ndt, user_id: T.uuid, user_email: T.nstr } };
const CONNECTOR = { type: 'object', properties: { id: T.uuid, name: T.str, kind: { type: 'string', enum: ['sharepoint', 'smb'] }, label: T.str, caps: T.obj, config: { type: 'object', description: 'Its settings other than secrets' }, hasSecrets: T.bool, enabled: T.bool, readOnly: T.bool, delegated: T.bool, lastStatus: T.nstr, lastError: T.nstr, lastCheckedAt: T.ndt } };
const personParam = { name: 'id', in: 'path', required: true, schema: T.str, description: "The account id, or the person's email address" };
const folderQuery = { name: 'folder', in: 'query', schema: T.str, description: 'A folder path; leave out for the library itself' };
const okDone = ok('Done', { type: 'object', properties: { ok: T.bool } });
const csv = { description: 'CSV, as a download', content: { 'text/csv': { schema: T.str } } };

Object.assign(paths, {
  '/users': {
    get: op('People', 'admin', 'List accounts', 'Everyone who has signed in, with their role and whether they are switched off.', { parameters: [{ name: 'q', in: 'query', schema: T.str, description: 'Part of an address' }], responses: { 200: ok('Accounts', { type: 'object', properties: { users: { type: 'array', items: USER } } }) } }),
  },
  '/users/{id}': {
    get: op('People', 'admin', 'One account', 'By account id, or by email address.', { parameters: [personParam], responses: { 200: ok('The account', USER), 404: err('No such account'), 409: err('More than one account uses that address; use the id') } }),
  },
  '/users/{id}/departure': {
    get: op('People', 'admin', 'What only this person can do', 'The list to look at before switching someone off: the libraries and groups only they manage, the links that would stop working, the shares addressed to them, and the files only they can read.', { parameters: [personParam], responses: { 200: ok('The summary', { type: 'object', properties: { user: USER, owns_libraries: { type: 'array', items: { type: 'object', properties: { id: T.uuid, name: T.str, personal: T.bool, files: T.int } } }, owns_groups: { type: 'array', items: { type: 'object', properties: { id: T.uuid, name: T.str, members: T.int } } }, live_file_links: T.int, live_folder_links: T.int, shares_to_them: T.int, personal_files: T.int } }), 404: err('No such account') } }),
  },
  '/users/{id}/role': {
    put: op('People', 'admin', 'Change a role', 'admin, contributor or viewer. Someone who can now add files gets a personal library if they have none. Recorded in the audit log.', { parameters: [personParam], requestBody: json({ type: 'object', properties: { role: ROLE } }, ['role']), responses: { 200: ok('Done', { type: 'object', properties: { role: ROLE } }), 400: err('Not a role'), 404: err('No such account') } }),
  },
  '/users/{id}/disabled': {
    put: op('People', 'admin', 'Switch an account off, or back on', 'Off: sign-in is refused, their links and tokens stop working, and a library that was theirs alone is put away until they are back. What they own and what they were given stays as it is. Not your own account, and not the last administrator.', { parameters: [personParam], requestBody: json({ type: 'object', properties: { disabled: T.bool, reason: T.str } }, ['disabled']), responses: { 200: ok('The account', { type: 'object', properties: { ...USER.properties, own_library_archived: T.bool } }), 400: err('Your own account'), 404: err('No such account'), 409: err('The last administrator') } }),
  },

  '/groups': {
    get: op('Groups', 'read', 'List groups', 'Groups the caller owns or belongs to; an administrator sees every group.', { responses: { 200: ok('Groups', { type: 'array', items: GROUP_LISTED }) } }),
    post: op('Groups', 'write', 'Make a group', 'The caller becomes its owner. Names are unique across the workspace. Contributors and administrators only.', { requestBody: json({ type: 'object', properties: { name: T.str } }, ['name']), responses: { 201: ok('The group', GROUP_LISTED), 400: err('No name'), 409: err('That name is taken') } }),
  },
  '/groups/{id}': {
    get: op('Groups', 'read', 'One group', 'Its owner and, for whoever manages it, how many shares its membership carries.', { parameters: [idParam('id', 'Group id')], responses: { 200: ok('The group', { type: 'object', properties: { ...GROUP.properties, share_count: { type: 'integer', description: 'For whoever manages it: how many shares its membership carries' } } }), 404: err('Not found, or not yours to see') } }),
    patch: op('Groups', 'write', 'Rename a group', 'Only its owner or an administrator.', { parameters: [idParam('id', 'Group id')], requestBody: json({ type: 'object', properties: { name: T.str } }, ['name']), responses: { 200: ok('The group', GROUP), 404: err('Not found'), 409: err('That name is taken, or the group changed meanwhile') } }),
    delete: op('Groups', 'write', 'Delete a group', 'Its members and every share made to it go with it.', { parameters: [idParam('id', 'Group id')], responses: { 200: okDone, 404: err('Not found') } }),
  },
  '/groups/{id}/members': {
    get: op('Groups', 'read', 'Who is in a group', 'Members see names and addresses; whoever manages the group also sees who added each person and whether they have signed in.', { parameters: [idParam('id', 'Group id')], responses: { 200: ok('Members', { type: 'array', items: GROUP_MEMBER }), 404: err('Not found') } }),
    post: op('Groups', 'write', 'Add someone', 'By email address; people outside the organisation are allowed. Someone already in it answers 200 with already_member true.', { parameters: [idParam('id', 'Group id')], requestBody: json({ type: 'object', properties: { email: T.str } }, ['email']), responses: { 201: ok('Added', { type: 'object', properties: { ...GROUP_MEMBER.properties, already_member: T.bool } }), 200: ok('Already a member', GROUP_MEMBER), 400: err('Not an email address'), 404: err('Not found') } }),
  },
  '/groups/{id}/members/{memberId}': {
    delete: op('Groups', 'write', 'Remove someone', 'Whatever they could open through this group closes at once.', { parameters: [idParam('id', 'Group id'), idParam('memberId', 'Membership id, from the member list')], responses: { 200: okDone, 404: err('Not in this group') } }),
  },
  '/groups/{id}/owner': {
    put: op('Groups', 'write', 'Hand a group to someone else', 'The new owner must have signed in to Depot and be able to add files.', { parameters: [idParam('id', 'Group id')], requestBody: json({ type: 'object', properties: { email: T.str } }, ['email']), responses: { 200: ok('The group', GROUP), 400: err('They cannot own a group'), 404: err('Not found'), 409: err('The group changed meanwhile') } }),
  },

  '/shared-with-me': {
    get: op('Sharing', 'read', 'What is shared with me', 'The libraries, folders and files the caller was given, with the level and who gave each.', { responses: { 200: ok('Shared with the caller', { type: 'object', properties: { email_verified: T.bool, libraries: { type: 'array', items: T.obj }, folders: { type: 'array', items: T.obj }, files: { type: 'array', items: T.obj } } }) } }),
  },
  '/libraries/{id}/shares': {
    get: op('Sharing', 'read', 'Who a library is shared with', 'Every share of the library and of folders in it, with people and with groups. Only its owner or an administrator. With folder, also the shares that ended when that folder was deleted and can still be put back.', { parameters: [idParam('id', 'Library id'), folderQuery], responses: { 200: ok('Shares', { type: 'object', properties: { library: T.obj, shares: { type: 'array', items: SHARE }, ended_shares: { type: 'array', items: T.obj } } }), 404: err('Not found') } }),
    post: op('Sharing', 'write', 'Share a library, or a folder in it', 'With one person (email) or one group (group_id), at read or write, for the whole library or for one folder. Files added later are covered. The person or group is told.', { parameters: [idParam('id', 'Library id')], requestBody: json({ type: 'object', properties: { email: T.str, group_id: T.uuid, permission: LEVEL, folder: { type: 'string', description: 'A folder path; leave out for the whole library' } } }, ['permission']), responses: { 201: ok('The share', { type: 'object', properties: { share: SHARE } }), 400: err('Choose one person or one group, and read or write'), 404: err('No such library, folder or group'), 409: err('Already shared with them; change the level instead') } }),
  },
  '/libraries/{id}/shares/{shareId}': {
    patch: op('Sharing', 'write', "Change a share's level", 'read or write.', { parameters: [idParam('id', 'Library id'), idParam('shareId', 'Share id')], requestBody: json({ type: 'object', properties: { permission: LEVEL } }, ['permission']), responses: { 200: ok('The share', { type: 'object', properties: { share: SHARE } }), 404: err('Not found'), 409: err('Changed meanwhile') } }),
    delete: op('Sharing', 'write', 'End a share', 'Their access through it closes at once.', { parameters: [idParam('id', 'Library id'), idParam('shareId', 'Share id')], responses: { 200: okDone, 404: err('Not found') } }),
  },
  '/libraries/{id}/shares/{shareId}/resend': {
    post: op('Sharing', 'write', 'Send the "shared with you" email again', 'For a share with a person.', { parameters: [idParam('id', 'Library id'), idParam('shareId', 'Share id')], responses: { 200: ok('Sent, or why not', { type: 'object', properties: { sent: T.bool, reason: T.nstr } }), 404: err('Not a share with a person') } }),
  },
  '/libraries/{id}/access': {
    get: op('Sharing', 'read', 'Who can open a library or a folder, and why', "The caller's own access always; the full list of people, and the shares, grants and links that let each of them in, for whoever manages the library.", { parameters: [idParam('id', 'Library id'), folderQuery], responses: { 200: ok('The answer', { type: 'object', properties: { door: T.obj, you: T.obj, can_see_keys: T.bool, people: { type: 'array', items: T.obj }, keys: { type: 'array', items: T.obj }, links: { type: 'array', items: T.obj } } }), 404: err('Not found') } }),
  },
  '/files/{id}/access': {
    get: op('Sharing', 'read', 'Who can open a file, and why', "The caller's own access, and the full list for whoever manages the file.", { parameters: [idParam('id', 'File id')], responses: { 200: ok('The answer', { type: 'object', properties: { door: T.obj, you: T.obj, can_see_keys: T.bool, people: { type: 'array', items: T.obj }, keys: { type: 'array', items: T.obj } } }), 404: err('Not found') } }),
  },
  '/files/{id}/grants': {
    get: op('Sharing', 'read', "A file's own grants", 'People given this one file, as opposed to the library it is in. Only someone who manages the file.', { parameters: [idParam('id', 'File id')], responses: { 200: ok('Grants', { type: 'object', properties: { grants: { type: 'array', items: GRANT } } }), 404: err('Not found, or not yours to manage') } }),
    put: op('Sharing', 'write', 'Give someone a file', 'By email, at read, write or admin (admin lets them manage its access too). Giving them the file again changes their level. They are told.', { parameters: [idParam('id', 'File id')], requestBody: json({ type: 'object', properties: { email: T.str, permission: { type: 'string', enum: ['read', 'write', 'admin'], default: 'read' } } }, ['email']), responses: { 200: ok('The grant', { type: 'object', properties: { grant: GRANT } }), 400: err('Not an email address, or not a level'), 404: err('Not found') } }),
  },
  '/files/{id}/grants/{grantId}': {
    delete: op('Sharing', 'write', 'Take a file back', 'Removes one grant.', { parameters: [idParam('id', 'File id'), idParam('grantId', 'Grant id')], responses: { 200: ok('Done', { type: 'object', properties: { success: T.bool } }), 404: err('Not found') } }),
  },
  '/files/{id}/grants/resend': {
    post: op('Sharing', 'write', 'Send the "shared a file with you" email again', 'To someone who already has a grant on it.', { parameters: [idParam('id', 'File id')], requestBody: json({ type: 'object', properties: { email: T.str } }, ['email']), responses: { 200: ok('Sent, or why not', { type: 'object', properties: { sent: T.bool, reason: T.nstr } }), 404: err('No such file, or they do not have it') } }),
  },

  '/libraries/{id}/archived': {
    put: op('Libraries', 'admin', 'Put a library away, or bring it back', 'An archived library is listed to administrators only and takes no new files; whoever could read what is in it still can.', { parameters: [idParam('id', 'Library id')], requestBody: json({ type: 'object', properties: { archived: T.bool } }, ['archived']), responses: { 200: ok('The library', { type: 'object', properties: { id: T.uuid, name: T.str, personal: T.bool, owner_email: T.nstr, archived_at: T.ndt } }), 404: err('Not found') } }),
  },
  '/libraries/{id}/owner': {
    post: op('Libraries', 'admin', 'Give an ownerless library an owner', 'Only fills in a missing owner; an owned library is not handed over this way.', { parameters: [idParam('id', 'Library id')], requestBody: json({ type: 'object', properties: { owner_email: T.str } }, ['owner_email']), responses: { 200: ok('The library', { type: 'object', properties: { id: T.uuid, name: T.str, owner_id: T.uuid, owner_email: T.str } }), 400: err('Someone who can only look at files cannot own a library'), 404: err('No such library, or nobody with that address has signed in'), 409: err('It already has an owner') } }),
  },
  '/libraries/{id}/reassign': {
    post: op('Libraries', 'admin', "Hand a switched-off person's library to someone else", 'Only while its owner is switched off. The new owner must be here and able to add files.', { parameters: [idParam('id', 'Library id')], requestBody: json({ type: 'object', properties: { owner_email: T.str } }, ['owner_email']), responses: { 200: ok('The library', { type: 'object', properties: { id: T.uuid, name: T.str, owner_id: T.uuid, owner_email: T.str, personal: T.bool, archived_at: T.ndt } }), 400: err('That account cannot be given a library'), 404: err('No such library, or nobody with that address has signed in'), 409: err('Its owner still has an account, or it has no owner to take it from') } }),
  },
  '/libraries/{id}/adopt': {
    post: op('Libraries', 'write', 'Hand your own files to the library', "Files the caller uploaded that are still theirs alone become the library's shared content; other people's are left as they are. Optionally only under one folder. Only the owner or an administrator.", { parameters: [idParam('id', 'Library id')], requestBody: { required: false, content: { 'application/json': { schema: { type: 'object', properties: { folder: T.str } } } } }, responses: { 200: ok('How many', { type: 'object', properties: { ok: T.bool, count: T.int, left_with_their_owners: { type: 'integer', description: 'Administrators only' } } }), 404: err('Not found') } }),
  },

  '/admin/settings': {
    get: op('Administration', 'admin', 'Workspace settings', 'Every setting the Settings screens hold, by key, except those changed in Depot itself: the storage encryption key, the sign-in methods (login_*) and backups (backup_*). Secrets come back masked.', { responses: { 200: ok('Settings, by key', { type: 'object', additionalProperties: T.str }) } }),
    patch: op('Administration', 'admin', 'Change settings', 'Send only the keys to change, as strings; an empty string clears one. A masked secret sent back is left as it is. Keys that are changed in Depot itself, and keys that are not settings, are refused. Which keys changed (never the values) goes in the audit log.', { requestBody: json({ type: 'object', additionalProperties: T.str }), responses: { 200: okDone, 400: err('A key is not a setting, or is changed in Depot only') } }),
  },
  '/admin/editor': {
    get: op('Administration', 'admin', 'The in-browser editing switch', 'Whether Office editing is switched on, and whether the editor is answering.', { responses: { 200: ok('The switch', { type: 'object', properties: { enabled: T.bool, state: { type: 'string', enum: ['off', 'stopping', 'lingering', 'starting', 'on', 'failed'] }, running: T.bool } }) } }),
    put: op('Administration', 'admin', 'Turn in-browser editing on or off', 'The host starts or stops the editor to match within a minute.', { requestBody: json({ type: 'object', properties: { enabled: T.bool } }, ['enabled']), responses: { 200: ok('The switch', { type: 'object', properties: { enabled: T.bool, state: T.str, running: T.bool } }), 400: err('enabled must be true or false') } }),
  },
  '/admin/files': {
    get: op('Administration', 'admin', 'Every file in the workspace', 'The newest files, or those whose name or uploader matches q, with the workspace totals.', { parameters: [{ name: 'q', in: 'query', schema: T.str }, { name: 'limit', in: 'query', schema: { type: 'integer', default: 200, maximum: 1000 } }], responses: { 200: ok('Files', { type: 'object', properties: { total: T.int, bytes: T.int, matched: T.int, files: { type: 'array', items: T.obj } } }) } }),
  },
  '/admin/stats': {
    get: op('Administration', 'admin', 'Recent activity and top contributors', 'The newest entries of the activity log, and who has been most active.', { responses: { 200: ok('The summary', { type: 'object', properties: { recentActivity: { type: 'array', items: T.obj }, topContributors: { type: 'array', items: { type: 'object', properties: { email: T.str, count: T.int } } } } }) } }),
  },
  '/admin/usage': {
    get: op('Administration', 'admin', 'AI usage', 'Tokens and cost this month, by person and by operation, and by day for the last 30 days.', { responses: { 200: ok('Usage', { type: 'object', properties: { thisMonth: T.obj, byUser: { type: 'array', items: T.obj }, byOperation: { type: 'array', items: T.obj }, daily: { type: 'array', items: T.obj } } }) } }),
  },
  '/admin/activity': {
    get: op('Administration', 'admin', 'The audit feed', 'Every file event in the workspace, newest first, with filters. For following what happens to files you can see, use /activity instead.', { parameters: [{ name: 'actor', in: 'query', schema: T.str, description: 'Part of an address' }, { name: 'event', in: 'query', schema: T.str, description: 'An event type, as eventTypes lists them' }, { name: 'q', in: 'query', schema: T.str, description: 'Part of a file name' }, { name: 'from', in: 'query', schema: { type: 'string', format: 'date' } }, { name: 'to', in: 'query', schema: { type: 'string', format: 'date' } }, { name: 'limit', in: 'query', schema: { type: 'integer', default: 50, maximum: 200 } }, { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 } }], responses: { 200: ok('Events', { type: 'object', properties: { events: { type: 'array', items: T.obj }, total: T.int, limit: T.int, offset: T.int, eventTypes: { type: 'array', items: T.str } } }) } }),
  },
  '/admin/activity.csv': {
    get: op('Administration', 'admin', 'The audit feed as CSV', 'The same feed and filters, up to 10,000 rows.', { parameters: [{ name: 'actor', in: 'query', schema: T.str }, { name: 'event', in: 'query', schema: T.str }, { name: 'q', in: 'query', schema: T.str }, { name: 'from', in: 'query', schema: { type: 'string', format: 'date' } }, { name: 'to', in: 'query', schema: { type: 'string', format: 'date' } }], responses: { 200: csv } }),
  },
  '/admin/compliance': {
    get: op('Administration', 'admin', 'Compliance readiness', 'The readiness profiles with their controls and evidence, the update posture, and the last runtime checks.', { responses: { 200: ok('Readiness', { type: 'object', properties: { disclaimer: T.str, frameworks: { type: 'array', items: T.obj }, updates: T.obj, summary: T.obj, probes: T.obj } }) } }),
    patch: op('Administration', 'admin', 'Turn readiness profiles on or off', 'enabled maps profile ids (soc2, hipaa, gdpr, pci_dss, iso27001, cmmc) to true or false.', { requestBody: json({ type: 'object', properties: { enabled: { type: 'object', additionalProperties: T.bool } } }, ['enabled']), responses: { 200: ok('Done', { type: 'object', properties: { ok: T.bool, frameworks: { type: 'array', items: T.obj } } }) } }),
  },
  '/admin/compliance/probe': {
    post: op('Administration', 'admin', 'Run the runtime checks', 'HTTPS, the dependency audit and backup freshness. Takes a moment.', { responses: { 200: ok('Results', { type: 'object', properties: { ok: T.bool, frameworks: { type: 'array', items: T.obj }, summary: T.obj, probes: T.obj } }) } }),
  },
  '/admin/compliance/attest': {
    put: op('Administration', 'admin', 'Record a manual control', 'Who attests that a control is met (or not), with a note.', { requestBody: json({ type: 'object', properties: { control_id: T.str, met: T.bool, note: T.str } }, ['control_id']), responses: { 200: ok('Done', { type: 'object', properties: { ok: T.bool, frameworks: { type: 'array', items: T.obj }, summary: T.obj } }), 400: err('No such control') } }),
  },
  '/admin/compliance/audit-verify': {
    get: op('Administration', 'admin', 'Verify the audit log', 'Walks the tamper-evident chain and reports the first break, if there is one.', { responses: { 200: ok('The result', { type: 'object', properties: { ok: T.bool, count: T.int, head: T.nstr } }) } }),
  },
  '/admin/compliance/evidence': {
    get: op('Administration', 'admin', 'The evidence bundle', 'Posture, profiles, the access review and the chain verification in one document. Runs the checks first.', { responses: { 200: ok('The bundle', T.obj) } }),
  },
  '/admin/compliance/evidence.md': {
    get: op('Administration', 'admin', 'The evidence bundle as Markdown', 'The same bundle, as a download.', { responses: { 200: { description: 'Markdown, as a download', content: { 'text/markdown': { schema: T.str } } } } }),
  },
  '/admin/access-review': {
    get: op('Administration', 'admin', 'Access review', 'For each person: their role and when it was given, what they can reach and why, and when they were last active.', { responses: { 200: ok('The review', { type: 'object', properties: { users: { type: 'array', items: T.obj }, openLibraries: { type: 'array', items: T.str }, userCount: T.int } }) } }),
  },
  '/admin/access-review.csv': {
    get: op('Administration', 'admin', 'Access review as CSV', 'The same review, as a download.', { responses: { 200: csv } }),
  },
  '/admin/tokens': {
    get: op('Administration', 'admin', 'Every live API token', 'Whose each one is, its scope, and when it was last used. Never the tokens themselves. Tokens are made in Depot, under Settings, not here.', { responses: { 200: ok('Tokens', { type: 'object', properties: { tokens: { type: 'array', items: TOKEN } } }) } }),
  },
  '/admin/tokens/{id}': {
    delete: op('Administration', 'admin', 'Revoke any token', 'Whoever it belongs to. Anything still using it stops at once.', { parameters: [idParam('id', 'Token id')], responses: { 200: okDone, 404: err('Not found') } }),
  },
  '/admin/connectors': {
    get: op('Administration', 'admin', 'SharePoint and SMB connections', 'Every connection, with its settings other than secrets.', { responses: { 200: ok('Connections', { type: 'object', properties: { connectors: { type: 'array', items: CONNECTOR } } }) } }),
    post: op('Administration', 'admin', 'Add a connection', 'kind is sharepoint or smb; the other fields are those /admin/connectors/kinds lists for that kind, secrets included (sent this once, stored sealed). enabled and readOnly default to true.', { requestBody: json({ type: 'object', properties: { name: T.str, kind: { type: 'string', enum: ['sharepoint', 'smb'] }, enabled: T.bool, readOnly: T.bool }, additionalProperties: true }, ['name', 'kind']), responses: { 201: ok('The connection', CONNECTOR), 400: err('A required field is missing') } }),
  },
  '/admin/connectors/kinds': {
    get: op('Administration', 'admin', 'What connections can be made', 'Each kind, with the fields it takes.', { responses: { 200: ok('Kinds', { type: 'object', properties: { kinds: { type: 'array', items: { type: 'object', properties: { kind: T.str, label: T.str, blurb: T.str, caps: T.obj, fields: { type: 'array', items: T.obj } } } } } }) } }),
  },
  '/admin/connectors/{id}': {
    patch: op('Administration', 'admin', 'Change a connection', 'Send the fields to change. A blank secret leaves the stored one alone.', { parameters: [idParam('id', 'Connection id')], requestBody: json({ type: 'object', properties: { name: T.str, enabled: T.bool, readOnly: T.bool }, additionalProperties: true }), responses: { 200: ok('The connection', CONNECTOR), 404: err('Not found') } }),
    delete: op('Administration', 'admin', 'Remove a connection', 'Nothing in the remote system is touched; it is simply no longer reachable from Depot.', { parameters: [idParam('id', 'Connection id')], responses: { 200: okDone, 404: err('Not found') } }),
  },
  '/admin/connectors/{id}/test': {
    post: op('Administration', 'admin', 'Test a connection', 'Proves the credentials and the root path. Answers 200 either way, with ok and a message; the result is kept on the connection.', { parameters: [idParam('id', 'Connection id')], responses: { 200: ok('The result', { type: 'object', properties: { ok: T.bool, message: T.str } }), 404: err('Not found') } }),
  },
  '/admin/license': {
    get: op('Administration', 'admin', 'License status', 'Whether a license is present and accepted, where it is in its term, and what it entitles. Updates themselves are run from Depot, not through the API.', { responses: { 200: ok('The status', { type: 'object', properties: { configured: T.bool, present: T.bool, valid: T.bool, accepted: T.bool, state: { type: 'string', enum: ['ok', 'expiring', 'lapsed', 'readonly', 'unlicensed'] }, stateReason: T.nstr, readOnly: T.bool, seatFreeze: T.bool, updatesEntitled: T.bool, reason: T.nstr, version: { type: 'integer', nullable: true }, customer: T.nstr, plan: T.nstr, type: T.nstr, issued: T.nstr, expires: T.nstr, updatesUntil: T.nstr, graceDays: T.int, graceEnds: T.ndt, daysLeft: { type: 'integer', nullable: true }, domain: T.nstr, domainMatch: { type: 'boolean', nullable: true }, serial: T.nstr, kid: T.nstr, seats: { type: 'object', properties: { licensed: { type: 'integer', nullable: true }, used: { type: 'integer', nullable: true }, policy: T.nstr, overCap: T.bool } }, features: { type: 'array', nullable: true, items: T.str }, warnings: { type: 'array', items: T.str } } }) } }),
  },
  '/admin/security': {
    get: op('Administration', 'admin', 'Host security status', 'What the host firewall monitor reports, when one is connected.', { responses: { 200: ok('The status', { type: 'object', properties: { level: { type: 'string', enum: ['ok', 'info', 'warning', 'critical'] }, configured: T.bool, firewall: T.str, recentConnections: T.int, window: T.str, message: T.str, updatedAt: T.dt } }) } }),
  },
});


Object.assign(paths, {
  '/files/{id}/move': {
    post: op('Files', 'write', 'Move a file to another library', 'The file keeps its path and its id in the other library. Library content may be carried off only by whoever manages its library; a file that stays put is reported as kept.', { parameters: [idParam('id', 'File id')], requestBody: json({ type: 'object', properties: { library_id: { type: 'string', format: 'uuid' } } }, ['library_id']), responses: { 200: ok('The outcome', { type: 'object', properties: { ok: { type: 'boolean' }, moved: { type: 'boolean' }, kept: { type: 'boolean', description: 'Still where it was: not the caller\'s to carry off' }, skipped: { type: 'boolean', description: 'Not found, or not the caller\'s to change' } } }), 400: err('No library_id') } }),
  },
  '/files/{id}/copy': {
    post: op('Files', 'write', 'Copy a file to another library', 'A new file at the same path in the other library, owned by the caller. Reading the file is enough to copy it; the caller needs the right to add files where it lands.', { parameters: [idParam('id', 'File id')], requestBody: json({ type: 'object', properties: { library_id: { type: 'string', format: 'uuid' } } }, ['library_id']), responses: { 200: ok('The outcome', { type: 'object', properties: { ok: { type: 'boolean' }, copied: { type: 'boolean' }, copy: { allOf: [FILE], nullable: true, description: 'The new file' } } }), 400: err('No library_id') } }),
  },
});

const INTRO = `Depot's API lets a script or another system do what a person does in Depot: list, add, fetch, move and share files; run groups and decide who can open what; follow what happened; and, with an admin token, run the workspace itself: people, settings, connections, compliance and the audit feed.

**Base path:** \`/api/v1\` on your Depot server, over HTTPS.

**Sign in with a token.** Make a personal access token in Depot under Settings, API tokens, and send it on every request:

\`\`\`
Authorization: Bearer depot_...
\`\`\`

A token acts as the person who made it, with their normal rights, held to the **scope** chosen when it was made: **read** (list, search, download), **write** (read plus add, change, delete and share) or **admin** (write plus what the Admin page can do; administrators only). It can be revoked at any time from the same screen, and an expiry can be set when it is made.

**Limits.** Each token may make 6,000 requests per 15 minutes unless an administrator changes that. Over the limit, requests answer 429 with a Retry-After header.

**Audit.** Everything a token changes appears in Depot's activity log as the person, marked with the token's name.

**Changed in Depot itself, never here:** the storage encryption key, the sign-in methods, backup destinations, and updates.

**Changes.** Release 3 (12 October 2026) added replacing a file in place (\`replace=true\` on the upload, and \`PUT /files/{id}/content\`), \`content_hash\` and \`modified_at\` on every file, moving and copying a file to another library, copying a folder, moving a folder within its library, and downloading a folder as a ZIP. Release 2 added people, groups, sharing and administration.

**Stability.** Version 1 only grows. Fields and endpoints may be added; nothing that exists changes shape. A breaking change would ship as /api/v2 beside this one.

**Errors** are JSON: \`{ "error": "what went wrong" }\` with the usual status codes: 400 for a bad request, 401 for no or a bad token, 403 when the scope or the person's rights do not allow it, 404 when the thing is not there or not theirs to see, 409 when something changed meanwhile, 429 when over the limit.`;

function spec() {
  return {
    openapi: '3.1.0',
    info: { title: 'Depot API', version: '1', description: INTRO },
    servers: [{ url: '/api/v1' }],
    security: [{ bearerAuth: [] }],
    components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', description: 'A personal access token (depot_...) or a Depot sign-in token' } }, schemas: { File: FILE, Folder: FOLDER, Library: LIBRARY, Error: ERROR, User: USER, Group: GROUP, GroupMember: GROUP_MEMBER, Share: SHARE, Grant: GRANT, Token: TOKEN, Connector: CONNECTOR } },
    tags: ['Account', 'People', 'Groups', 'Libraries', 'Files', 'Folders', 'Sharing', 'Share links', 'Resumable uploads', 'Activity', 'Administration'].map(name => ({ name })),
    paths,
  };
}

module.exports = { spec, paths };

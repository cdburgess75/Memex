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
    put: op('Files', 'write', 'Upload a file in one request', 'The request body is the file. Send Content-Type: application/octet-stream (or the file\'s own type) and Content-Length. Folders in the path are made as needed. A live file already at that path is a 409 carrying its id: rename or delete it first, or choose another path. Files over the server\'s upload limit are refused; for very large files use the resumable upload.',
      { parameters: [idParam('id', 'Library id'), { name: 'path', in: 'path', required: true, schema: { type: 'string' }, description: 'Folder path and file name, URL-encoded per segment, such as Reports%2F2026%2Fq1.pdf or Reports/2026/q1.pdf' }],
        requestBody: { required: true, content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } },
        responses: { 200: ok('The stored file', { type: 'object', properties: { doc: FILE } }), 409: ok('A file is already at that path', { type: 'object', properties: { error: { type: 'string' }, existing_id: { type: 'string' } } }), 413: err('Over the upload limit'), 415: err('A file type the workspace refuses') } }),
  },
  '/files/{id}': {
    get: op('Files', 'read', 'A file\'s details', 'Name, path, size and who added it.', { parameters: [idParam('id', 'File id')], responses: { 200: ok('The file', FILE), 404: err('Not found, or not yours to see') } }),
    patch: op('Files', 'write', 'Rename or move a file', 'Give a new name, a new folder in the same library, or both. Moving needs the right to add files where it lands.', { parameters: [idParam('id', 'File id')], requestBody: json({ type: 'object', properties: { name: { type: 'string', description: 'The file name only' }, folder: { type: 'string', description: 'Folder path; empty string for the root' } } }), responses: { 200: ok('Done', { type: 'object', properties: { success: { type: 'boolean' }, name: { type: 'string', description: 'The full path now' } } }), 404: err('Not found'), 409: err('The file changed meanwhile; read it again') } }),
    delete: op('Files', 'write', 'Move a file to the trash', 'It can be restored until the trash retention runs out.', { parameters: [idParam('id', 'File id')], responses: { 200: ok('Done', { type: 'object', properties: { success: { type: 'boolean' } } }), 404: err('Not found') } }),
  },
  '/files/{id}/content': {
    get: op('Files', 'read', 'Download a file', 'The bytes, as an attachment. Range requests are honoured, so a download can resume.', { parameters: [idParam('id', 'File id'), { name: 'Range', in: 'header', schema: { type: 'string' }, description: 'Optional, such as bytes=0-1023' }], responses: { 200: { description: 'The file', content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } }, 206: { description: 'The requested range' }, 404: err('Not found') } }),
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
    post: op('Folders', 'write', 'Move a folder to another library', 'The folder keeps its path in the destination library.', { parameters: [idParam('id', 'Source library id')], requestBody: json({ type: 'object', properties: { path: { type: 'string' }, to_library_id: { type: 'string', format: 'uuid' } } }, ['path', 'to_library_id']), responses: { 200: ok('Done', { type: 'object' }), 404: err('No such folder') } }),
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

const INTRO = `Depot's API lets a script or another system do what a person does in Depot: list, add, fetch, move and share files, and follow what happened.

**Base path:** \`/api/v1\` on your Depot server, over HTTPS.

**Sign in with a token.** Make a personal access token in Depot under Settings, API tokens, and send it on every request:

\`\`\`
Authorization: Bearer depot_...
\`\`\`

A token acts as the person who made it, with their normal rights, held to the **scope** chosen when it was made: **read** (list, search, download), **write** (read plus add, change, delete and share) or **admin** (write plus what the Admin page can do; administrators only). It can be revoked at any time from the same screen, and an expiry can be set when it is made.

**Limits.** Each token may make 6,000 requests per 15 minutes unless an administrator changes that. Over the limit, requests answer 429 with a Retry-After header.

**Audit.** Everything a token changes appears in Depot's activity log as the person, marked with the token's name.

**Stability.** Version 1 only grows. Fields and endpoints may be added; nothing that exists changes shape. A breaking change would ship as /api/v2 beside this one.

**Errors** are JSON: \`{ "error": "what went wrong" }\` with the usual status codes: 400 for a bad request, 401 for no or a bad token, 403 when the scope or the person's rights do not allow it, 404 when the thing is not there or not theirs to see, 409 when something changed meanwhile, 429 when over the limit.`;

function spec() {
  return {
    openapi: '3.1.0',
    info: { title: 'Depot API', version: '1', description: INTRO },
    servers: [{ url: '/api/v1' }],
    security: [{ bearerAuth: [] }],
    components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', description: 'A personal access token (depot_...) or a Depot sign-in token' } }, schemas: { File: FILE, Folder: FOLDER, Library: LIBRARY, Error: ERROR } },
    tags: ['Account', 'Libraries', 'Files', 'Folders', 'Share links', 'Resumable uploads', 'Activity'].map(name => ({ name })),
    paths,
  };
}

module.exports = { spec, paths };

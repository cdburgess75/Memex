'use strict';
process.env.LINK_UPLOAD_TMP = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'depot-ext-test-'));
// A folder link, as its recipient meets it: a page that lists the folder, serves each file
// on its own or the folder as a ZIP. A link sent to a PERSON shows the folder as it is now;
// an anonymous one stays the snapshot it was. Either way it serves only what its maker can
// still publish, and only things that are IN the set computed for it -- never something the
// visitor named. A colleague's link opens for that colleague, signed in, and nobody else.
const request = require('supertest');
const express = require('express');
const crypto = require('crypto');
const { Readable } = require('stream');

const mockHash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const mockQueries = [];
const mockState = { link: null, docs: [], creator: null, known: [], claimed: new Set(), right: null, manages: false, listed: [], revoked: null };
jest.mock('../../lib/db', () => ({
  query: jest.fn(async (sql, params) => {
    mockQueries.push({ sql, params });
    if (/^UPDATE folder_share_links SET opened_at = NOW\(\)/.test(sql)) { if (mockState.claimed.has(params[0])) return []; mockState.claimed.add(params[0]); return [{ id: params[0] }]; }
    // (anchored: the access predicate inside the document queries mentions user_roles too)
    if (/^SELECT lower\(verified_email\) AS email FROM user_roles/.test(sql)) return mockState.known.map(email => ({ email }));
    // a LIVE link reads the folder as it is: by library and path, as the maker may publish it
    if (/FROM documents d\s+WHERE d\.library_id = \$6/.test(sql)) return mockState.docs.filter(d => d.name.startsWith(params[6] + '/'));
    if (/^SELECT l\.id, l\.folder_path[\s\S]*FROM folder_share_links l/.test(sql)) return mockState.listed;
    if (/FROM documents d/.test(sql)) return mockState.docs.map(d => ({ id: d.id }));
    return [];
  }),
  queryOne: jest.fn(async (sql, params) => {
    mockQueries.push({ sql, params });
    if (/FROM folder_share_links WHERE token_hash/.test(sql)) return mockState.link && params[0] === mockState.link.token_hash ? { ...mockState.link } : null;
    if (/^UPDATE folder_share_links f\s+SET revoked_at = NOW\(\)/.test(sql)) return mockState.revoked;
    if (/^UPDATE folder_share_links SET upload_count = upload_count \+ 1/.test(sql)) return mockState.full ? null : { id: params[0] };
    if (/SELECT 1 FROM documents d/.test(sql)) return { '?column?': 1 };
    return null;
  }),
  withTransaction: jest.fn(),
}));
jest.mock('../../lib/auditLog', () => ({ append: jest.fn().mockResolvedValue({}) }));
const mockSettings = { folder_zip_max_mb: null };
jest.mock('../../lib/settings', () => ({ getOrEnv: jest.fn(async (k) => (k === 'app_url' ? 'https://depot.example' : k === 'folder_zip_max_mb' ? mockSettings.folder_zip_max_mb : null)) }));
jest.mock('../../lib/storage', () => ({ downloadStream: jest.fn(async () => ({ stream: require('stream').Readable.from(['abc']), length: 3 })) }));
jest.mock('../../lib/notifications', () => ({ create: jest.fn().mockResolvedValue({}) }));
jest.mock('../../lib/emailEvents', () => ({ send: jest.fn().mockResolvedValue({ sent: true }) }));
jest.mock('../../lib/email', () => ({ sendMail: jest.fn(async () => ({ sent: true })), actingAs: jest.requireActual('../../lib/email').actingAs }));
jest.mock('../../lib/linkAccess', () => ({
  linkCreator: jest.fn(async () => mockState.creator),
  // a SNAPSHOT link: the ids it holds, as its maker may still publish them
  servableDocs: jest.fn(async (_by, ids) => ({ creator: mockState.creator, docs: mockState.creator ? mockState.docs.filter(d => ids.includes(d.id)) : [] })),
}));
const mockActor = { value: undefined };
jest.mock('../../lib/documentAccess', () => ({ ...jest.requireActual('../../lib/documentAccess'), resolveActor: jest.fn(async (id) => (mockActor.value === undefined ? { id, email: 'sharer@corp.com', emailVerified: true, role: 'contributor' } : mockActor.value)) }));
jest.mock('../../lib/libraries', () => ({ writeRight: jest.fn(async () => mockState.right || { right: 'grant', scoped: true }), defaultLibraryFor: jest.fn(async () => 'lib-1'), managesLibrary: jest.fn(async () => mockState.manages) }));
// The upload's landing place is decided under the library lock: stand in for that, and let
// each test say what the link row looks like by then.
const mockPlaced = { calls: [], linkNow: undefined };
jest.mock('../../lib/documents', () => ({ ...jest.requireActual('../../lib/documents'),
  createDocumentRecord: jest.fn(async (o) => {
    const q = { queryOne: async () => (mockPlaced.linkNow === undefined ? { folder_path: 'Clients/Acme', library_id: o.libraryId } : mockPlaced.linkNow) };
    const where = await o.resolve(q, { libraryId: o.libraryId });
    mockPlaced.calls.push({ ...o, ...where }); return { doc: { id: 'new-doc' } };
  }) }));
jest.mock('../../lib/externalUpload', () => ({ ...jest.requireActual('../../lib/externalUpload'), hasDiskRoom: jest.fn(async () => true) }));
const mockLimits = { value: null };
jest.mock('../../lib/externalChunks', () => { const real = jest.requireActual('../../lib/externalChunks'); return { ...real, limits: jest.fn(async () => mockLimits.value || { maxFileMb: 10240, maxFileBytes: 10240 * 1048576, maxFiles: 5000, maxTotalBytes: 100 * 1024 ** 3 }) }; });
const mockUser = { value: null };
jest.mock('../../middleware/auth', () => (req, _res, next) => { req.user = mockUser.value; next(); });

const email = require('../../lib/email');
const notifications = require('../../lib/notifications');
const emailEvents = require('../../lib/emailEvents');
const zipLarge = require('../../lib/zipLarge');
const { passwordParts, issueShareTicket } = require('../../lib/shareLinks');
const app = () => { const a = express(); a.use(express.json()); a.use('/api/files/folder', require('../../routes/files/folders')); return a; };
const API = '/api/files/folder/share/tok';
const LIB = 'aaaaaaaa-0000-4000-8000-000000000001';
const ID = (n) => `dddddddd-0000-4000-8000-00000000000${n}`;
const LINK = 'ffffffff-0000-4000-8000-000000000001';
const SHARER = { id: 'u1', email: 'sharer@corp.com', emailVerified: true, role: 'contributor' };
const AMY = { id: 'u2', email: 'amy@corp.com', emailVerified: true, role: 'contributor' };
const doc = (n, name, size = 10) => ({ id: ID(n), name, size, storage_path: 'p' + n, mime_type: 'text/html', created_at: null });
const link = (over = {}) => ({ id: LINK, token_hash: mockHash('tok'), folder_path: 'Clients/Acme', document_ids: [ID(1), ID(2), ID(3)], library_id: LIB, live: false,
  recipient_email: null, require_signin: false, password_hash: null, password_salt: null, expires_at: null, revoked_at: null, created_by: 'u1', created_by_email: 'sharer@corp.com', ...over });
const opened = () => notifications.create.mock.calls.map(c => c[0]).filter(n => n.type === 'share_opened');

beforeEach(() => {
  mockQueries.length = 0; mockState.claimed.clear(); mockSettings.folder_zip_max_mb = null;
  Object.assign(mockState, { link: link(), creator: SHARER, known: [], right: null, manages: false, listed: [], revoked: null,
    docs: [doc(1, 'Clients/Acme/scope.pdf'), doc(2, 'Clients/Acme/Invoices/inv-1.pdf', 20), doc(3, 'Clients/Acme/Invoices/2026/inv-2.pdf', 30), doc(4, 'Clients/Acme/added-later.pdf', 40), doc(9, 'Clients/AcmeSecret/payroll.xlsx', 99)] });
  mockUser.value = SHARER; mockActor.value = undefined; jest.clearAllMocks();
  mockPlaced.calls.length = 0; mockPlaced.linkNow = undefined; mockState.full = false; mockLimits.value = null;
});

describe('the listing', () => {
  test('one level at a time: subfolders with what is in them, then files', async () => {
    const res = await request(app()).get(`${API}/info`);
    expect(res.body).toMatchObject({ name: 'Acme', unlocked: true, live: false, count: 3, bytes: 60 });
    expect(res.body.folders).toEqual([{ name: 'Invoices', path: 'Invoices', files: 2, bytes: 50 }]);
    expect(res.body.files.map(f => f.name)).toEqual(['scope.pdf']);
    expect(JSON.stringify(res.body)).not.toMatch(/storage_path|library|Clients/); // nothing about where it lives
  });
  test('a subfolder, and a subfolder of that', async () => {
    const res = await request(app()).get(`${API}/info?path=Invoices`);
    expect(res.body.files.map(f => f.name)).toEqual(['inv-1.pdf']);
    expect(res.body.folders.map(f => f.path)).toEqual(['Invoices/2026']);
  });
  test('a subfolder is its own contents, never a neighbour whose name merely starts the same', async () => {
    mockState.docs.push(doc(5, 'Clients/Acme/Invoices-old/archived.pdf', 7));
    mockState.link = link({ document_ids: [ID(1), ID(2), ID(3), ID(5)] });
    const res = await request(app()).get(`${API}/info?path=Invoices`);
    expect(res.body).toMatchObject({ count: 2, bytes: 50 });
    const zip = await request(app()).get(`${API}/zip?path=Invoices`).buffer(true).parse((r, cb) => { const b = []; r.on('data', c => b.push(c)); r.on('end', () => cb(null, Buffer.concat(b))); });
    expect(zip.body.toString('latin1')).not.toContain('archived.pdf');
  });
  test.each([['..'], ['Invoices/../../Secret'], ['./Invoices']])('a path that climbs (%s) is not a folder in this link', async (p) => {
    expect((await request(app()).get(`${API}/info?path=${encodeURIComponent(p)}`)).status).toBe(400);
  });
  test('a folder that is not in the link is not found, whatever exists beside it', async () => {
    expect((await request(app()).get(`${API}/info?path=${encodeURIComponent('../AcmeSecret')}`)).status).toBe(400);
    expect((await request(app()).get(`${API}/info?path=Nope`)).status).toBe(404);
  });
  test('an anonymous link is a SNAPSHOT: a file added later is not in it', async () => {
    const names = (await request(app()).get(`${API}/info`)).body.files.map(f => f.name);
    expect(names).not.toContain('added-later.pdf');
  });
  test('a link sent to a person is LIVE: it shows the folder as it is, and never the folder next door', async () => {
    mockState.link = link({ live: true, recipient_email: 'ap@supplier.com' });
    const res = await request(app()).get(`${API}/info`);
    expect(res.body.live).toBe(true);
    expect(res.body.files.map(f => f.name)).toEqual(['added-later.pdf', 'scope.pdf']);
    const q = mockQueries.find(x => /WHERE d\.library_id = \$6/.test(x.sql));
    expect(q.params.slice(-2)).toEqual([LIB, 'Clients/Acme']);                 // this library, this folder
    expect(q.sql).toMatch(/d\.name ~>=~ \(\$7 \|\| '\/'\)/);                       // "Acme/", so never "AcmeSecret"
    expect(q.params.slice(0, 5)).toEqual(require('../../lib/documentAccess').userParams(SHARER, 'write')); // as its MAKER may publish it
  });
});

describe('what a link will not do', () => {
  test.each([['revoked', { revoked_at: new Date().toISOString() }, 404], ['expired', { expires_at: '2020-01-01T00:00:00Z' }, 410]])('a %s link', async (_l, over, status) => {
    mockState.link = link(over);
    for (const u of ['/info', `/file/${ID(1)}`, '/zip', '']) expect((await request(app()).get(API + u)).status).toBe(status);
  });
  test('a link whose maker can no longer publish is gone, live or not', async () => {
    mockState.creator = null;
    expect((await request(app()).get(`${API}/info`)).status).toBe(404);
    mockState.link = link({ live: true });
    expect((await request(app()).get(`${API}/info`)).status).toBe(404);
    expect((await request(app()).get(`${API}/zip`)).status).toBe(404);
  });
  test('a file is served only if it is IN the link: not by an id the visitor happens to know', async () => {
    expect((await request(app()).get(`${API}/file/${ID(9)}`)).status).toBe(404); // real file, real id, other folder
    expect((await request(app()).get(`${API}/file/${ID(4)}`)).status).toBe(404); // added after the snapshot
    expect((await request(app()).get(`${API}/file/not-an-id`)).status).toBe(404);
    expect(require('../../lib/storage').downloadStream).not.toHaveBeenCalled();
  });
  test('a file is a DOWNLOAD, never something the browser renders on this origin', async () => {
    const res = await request(app()).get(`${API}/file/${ID(1)}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/octet-stream/); // the file itself is text/html
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="scope\.pdf"$/);
  });
});

describe('a password', () => {
  beforeEach(() => { const { salt, hash } = passwordParts('hunter2'); mockState.link = link({ password_salt: salt, password_hash: hash }); });
  test('nothing is shown, served or counted as opened until it is given', async () => {
    const info = (await request(app()).get(`${API}/info`)).body;
    expect(info).toMatchObject({ needsPassword: true, unlocked: false }); expect(info.files).toBeUndefined();
    expect((await request(app()).get(`${API}/file/${ID(1)}`)).status).toBe(401);
    expect((await request(app()).get(`${API}/zip`)).status).toBe(401);
    expect((await request(app()).post(`${API}/opened`)).status).toBe(401);
    expect(opened()).toHaveLength(0);
  });
  test('the password buys a ticket; the ticket is what downloads carry', async () => {
    expect((await request(app()).post(`${API}/ticket`).set('x-share-password', 'wrong')).status).toBe(401);
    const { ticket } = (await request(app()).post(`${API}/ticket`).set('x-share-password', 'hunter2')).body;
    expect((await request(app()).get(`${API}/info`).set('x-share-ticket', ticket)).body.unlocked).toBe(true);
    expect((await request(app()).get(`${API}/file/${ID(1)}?dl=${encodeURIComponent(ticket)}`)).status).toBe(200);
  });
  test("a ticket for another link opens nothing here", async () => {
    const other = issueShareTicket('ffffffff-0000-4000-8000-0000000000ff');
    expect((await request(app()).get(`${API}/file/${ID(1)}?dl=${encodeURIComponent(other)}`)).status).toBe(401);
  });
  test('the old ZIP address still takes its password the way links already out there pass it', async () => {
    expect((await request(app()).get(`${API}?password=hunter2`)).status).toBe(200);
    expect((await request(app()).get(`${API}/zip?password=hunter2`)).status).toBe(401); // the new routes never take it on the URL
  });
});

describe("a colleague's link", () => {
  beforeEach(() => { mockState.link = link({ live: true, require_signin: true, recipient_email: 'amy@corp.com' }); });
  test('does not exist for anyone without the ticket only its recipient can get', async () => {
    for (const [m, u] of [['get', '/info'], ['post', '/ticket'], ['post', '/opened'], ['get', `/file/${ID(1)}`], ['get', '/zip'], ['get', '']]) expect((await request(app())[m](API + u)).status).toBe(404);
  });
  test('its recipient, signed in, is handed a ticket for the page', async () => {
    mockUser.value = AMY;
    const res = await request(app()).get('/api/files/folder/signin-link/tok');
    expect(res.status).toBe(200);
    const ticket = decodeURIComponent(res.body.pageUrl.match(/^\/f\/tok#t=(.+)$/)[1]); // in the FRAGMENT: never sent to a server, never logged
    expect((await request(app()).get(`${API}/info`).set('x-share-ticket', ticket)).body.files.map(f => f.name)).toContain('scope.pdf');
    expect(opened()[0]).toMatchObject({ userEmail: 'sharer@corp.com' });
  });
  test.each([
    ['somebody else', { ...AMY, id: 'u3', email: 'bob@corp.com' }],
    ["an account that only CLAIMS the recipient's address", { ...AMY, id: 'u9', emailVerified: false }],
  ])('is refused to %s, without saying who it was for', async (_l, user) => {
    mockUser.value = user;
    const res = await request(app()).get('/api/files/folder/signin-link/tok');
    expect(res.status).toBe(403); expect(res.body.error).not.toContain('amy@'); expect(res.body.pageUrl).toBeUndefined();
  });
  test('an ordinary link is not a sign-in link', async () => {
    mockState.link = link(); mockUser.value = AMY;
    expect((await request(app()).get('/api/files/folder/signin-link/tok')).status).toBe(404);
  });
});

describe('the maker hears about the first open, once', () => {
  test('loading the listing is not an open (a mail scanner does that); a person touching the page is', async () => {
    await request(app()).get(`${API}/info`);
    expect(opened()).toHaveLength(0);
    await request(app()).post(`${API}/opened`); await request(app()).post(`${API}/opened`);
    expect(opened()).toHaveLength(1);
    expect(emailEvents.send.mock.calls.filter(c => c[0] === 'share_opened')).toHaveLength(1);
  });
  test('a download with no page first IS the open; after that it is a note in the app, never another email', async () => {
    await request(app()).get(`${API}/file/${ID(1)}`);
    await request(app()).get(`${API}/file/${ID(2)}`);
    expect(notifications.create.mock.calls.map(c => c[0].type)).toEqual(['share_opened', 'share_downloaded']);
    expect(emailEvents.send.mock.calls.map(c => c[0])).toEqual(['share_opened']);
  });
});

describe('the ZIP', () => {
  test('the folder, or any subfolder of it, named as it sits in the link', async () => {
    expect((await request(app()).get(`${API}/zip`)).headers['content-disposition']).toBe('attachment; filename="Acme.zip"');
    const res = await request(app()).get(`${API}/zip?path=Invoices`).buffer(true).parse((r, cb) => { const b = []; r.on('data', c => b.push(c)); r.on('end', () => cb(null, Buffer.concat(b))); });
    expect(res.headers['content-disposition']).toBe('attachment; filename="Invoices.zip"');
    const names = res.body.toString('latin1');
    expect(names).toContain('Acme/Invoices/inv-1.pdf'); expect(names).toContain('Acme/Invoices/2026/inv-2.pdf');
    expect(names).not.toContain('scope.pdf');      // not in the subfolder asked for
    expect(names).not.toContain('Clients/');        // and never where it lives in the library
  });
  test('answers to ONE limit, which an administrator sets; files still download one by one', async () => {
    mockSettings.folder_zip_max_mb = '1';
    mockState.docs = [doc(1, 'Clients/Acme/scope.pdf', 900 * 1024), doc(2, 'Clients/Acme/Invoices/inv-1.pdf', 900 * 1024)]; // 1.8 MB against a 1 MB limit
    const res = await request(app()).get(`${API}/zip`);
    expect(res.status).toBe(413); expect(res.body.code).toBe('ZIP_TOO_LARGE');
    expect((await request(app()).get(`${API}/info`)).body.zip).toMatchObject({ allowed: false });
    expect((await request(app()).get(`${API}/file/${ID(1)}`)).status).toBe(200);
    expect((await request(app()).get(`${API}/zip?check=1`)).status).toBe(413);
  });
  test('the limit defaults to 8192 MB', async () => expect(await zipLarge.maxMb()).toBe(8192));
  test('only so many build at once; the next one is told to come back, and nothing breaks', async () => {
    const held = [zipLarge.takeSlot(), zipLarge.takeSlot(), zipLarge.takeSlot()];
    try {
      const res = await request(app()).get(`${API}/zip`);
      expect(res.status).toBe(503); expect(res.body.error).toMatch(/Try again in a minute/);
      expect((await request(app()).get(`${API}/zip?check=1`)).status).toBe(503);
      expect((await request(app()).get(`${API}/file/${ID(1)}`)).status).toBe(200); // single files are never queued
    } finally { held.forEach(f => f()); }
    expect((await request(app()).get(`${API}/zip?check=1`)).body).toEqual({ ok: true });
    expect(zipLarge._building()).toBe(0); // and every slot came back, including the one the refused request never took
  });
  test('a slot is given back when a ZIP finishes', async () => {
    await request(app()).get(`${API}/zip`); await request(app()).get(`${API}/zip`);
    await request(app()).get(`${API}/zip`); await request(app()).get(`${API}/zip`);
    expect(zipLarge._building()).toBe(0);
  });
});

describe('a ZIP that goes wrong takes nothing down with it', () => {
  const storage = require('../../lib/storage');
  const { Readable } = require('stream');
  // Plain http: a download cut off half way is the honest outcome here, and supertest treats it as a bug.
  const cutOff = (path) => new Promise((resolve) => {
    const srv = app().listen(0, '127.0.0.1', () => {
      const done = () => srv.close(() => resolve());
      require('http').get({ host: '127.0.0.1', port: srv.address().port, path }, (res) => { res.on('data', () => {}); res.on('end', done); res.on('error', done); res.on('aborted', done); }).on('error', done);
    });
  });
  let quiet; beforeEach(() => { quiet = jest.spyOn(console, 'error').mockImplementation(() => {}); }); afterEach(() => quiet.mockRestore());
  test('a blob that is missing ends the download; the server answers the next request, and the slot is back', async () => {
    storage.downloadStream.mockImplementationOnce(async () => { throw new Error('NoSuchKey'); });
    await cutOff(`${API}/zip`);
    expect(zipLarge._building()).toBe(0);
    expect((await request(app()).get(`${API}/zip?check=1`)).body).toEqual({ ok: true });
  });
  test('a read that dies half way does the same', async () => {
    storage.downloadStream.mockImplementationOnce(async () => ({ stream: new Readable({ read() { this.destroy(new Error('EIO')); } }), length: 3 }));
    await cutOff(`${API}/zip`);
    expect(zipLarge._building()).toBe(0);
    expect((await request(app()).get(`${API}/info`)).status).toBe(200);
  });
  test("a visitor's ZIP is public, and keyed to the link and the address it came from", async () => {
    const spy = jest.spyOn(zipLarge, 'takeSlot');
    try {
      await request(app()).get(`${API}/zip`);
      expect(spy).toHaveBeenCalledWith({ isPublic: true, keys: [`link:${LINK}`, expect.stringMatching(/^ip:/)] });
    } finally { spy.mockRestore(); }
  });
  test('one link builds one ZIP at a time; its files still download', async () => {
    const free = zipLarge.takeSlot({ isPublic: true, keys: [`link:${LINK}`] });
    try {
      const res = await request(app()).get(`${API}/zip`);
      expect(res.status).toBe(503); expect(res.body.error).toMatch(/already downloading/);
      expect((await request(app()).get(`${API}/file/${ID(1)}`)).status).toBe(200);
    } finally { free(); }
  });
});

describe('files coming back through a folder link', () => {
  const LINK_PW = crypto.randomBytes(9).toString('base64url'); // made up per run: nothing here is a real credential, and no scanner need wonder
  const storage = require('../../lib/storage');
  const libraries = require('../../lib/libraries');
  const receiving = (over = {}) => link({ live: true, recipient_email: 'ap@supplier.com', allow_upload: true, upload_count: 0, upload_bytes: 0, ...over });
  const send = (name = 'invoice.pdf', fields = {}) => { let r = request(app()).post(`${API}/upload`); for (const [k, v] of Object.entries(fields)) r = r.field(k, v); return r.attach('file', Buffer.from('hello'), name); };
  beforeEach(() => { storage.upload = jest.fn(async () => {}); storage.del = jest.fn(async () => {}); mockState.link = receiving(); });

  test('lands in the linked folder, in its library, owned by the link\'s maker -- who is told', async () => {
    const res = await send();
    expect(res.status).toBe(200);
    expect(mockPlaced.calls[0]).toMatchObject({ displayName: 'Clients/Acme/invoice.pdf', libraryId: LIB, user: expect.objectContaining({ id: 'u1' }), sourceDetail: 'via folder link · from ap@supplier.com' });
    expect(notifications.create).toHaveBeenCalledWith(expect.objectContaining({ type: 'upload_received', userEmail: 'sharer@corp.com', title: 'ap@supplier.com added a file to "Acme"' }));
    expect(emailEvents.send).toHaveBeenCalledWith('upload_received', expect.objectContaining({ to: 'sharer@corp.com' }));
  });
  test('into the subfolder being looked at, keeping a dragged folder\'s shape; never out of the link', async () => {
    await send('a.pdf', { path: 'Invoices', relativePath: '2026/March/a.pdf' });
    expect(mockPlaced.calls[0].displayName).toBe('Clients/Acme/Invoices/2026/March/a.pdf');
    expect((await send('a.pdf', { path: '../Secret' })).status).toBe(400);
    await send('b.pdf', { relativePath: '../../etc/b.pdf' });
    expect(mockPlaced.calls[1].displayName.startsWith('Clients/Acme/')).toBe(true);
    expect(mockPlaced.calls[1].displayName).not.toContain('..');
  });
  test.each([
    ['a link made without it', { allow_upload: false }],
    ['an anonymous (snapshot) link, even if the flag were set', { live: false, recipient_email: null }],
    ['a link with no library', { library_id: null }],
  ])('%s is download-only, and nothing is stored', async (_n, over) => {
    mockState.link = receiving(over);
    expect((await send()).status).toBe(403);
    expect(storage.upload).not.toHaveBeenCalled();
    expect((await request(app()).get(`${API}/info`)).body.allowUpload).toBe(false);
  });
  test('the page is told it may upload, and how big', async () => {
    expect((await request(app()).get(`${API}/info`)).body).toMatchObject({ allowUpload: true, maxUploadMb: 10240 });
  });
  test('a revoked or expired link takes nothing', async () => {
    mockState.link = receiving({ revoked_at: new Date().toISOString() }); expect((await send()).status).toBe(404);
    mockState.link = receiving({ expires_at: '2020-01-01T00:00:00Z' }); expect((await send()).status).toBe(410);
    expect(storage.upload).not.toHaveBeenCalled();
  });
  test('a password link needs a TICKET here; the password itself is never accepted on this route', async () => {
    const { salt, hash } = passwordParts(LINK_PW);
    mockState.link = receiving({ password_salt: salt, password_hash: hash });
    expect((await send()).status).toBe(401);
    expect((await request(app()).post(`${API}/upload`).set('x-share-password', LINK_PW).attach('file', Buffer.from('x'), 'a.pdf')).status).toBe(401);
    expect((await request(app()).post(`${API}/upload`).set('x-share-ticket', issueShareTicket(LINK)).attach('file', Buffer.from('x'), 'a.pdf')).status).toBe(200);
  });
  test("a colleague's sign-in link uploads with their ticket, and not without", async () => {
    mockState.link = receiving({ require_signin: true });
    expect((await send()).status).toBe(404);
    expect((await request(app()).post(`${API}/upload`).set('x-share-ticket', issueShareTicket(LINK)).attach('file', Buffer.from('x'), 'a.pdf')).status).toBe(200);
  });
  test('a maker who is gone, or may no longer add files there, stops the link receiving', async () => {
    mockState.right = { status: 403, error: 'no' };
    expect((await send()).status).toBe(403);
    mockState.right = null; mockState.creator = null;
    expect((await send()).status).toBe(404);
    expect(storage.upload).not.toHaveBeenCalled();
    expect(libraries.writeRight).toHaveBeenCalledWith(SHARER, LIB, 'Clients/Acme');
  });
  test('blocked file types and the per-link ceiling are enforced', async () => {
    expect((await send('payload.exe')).status).toBe(400);
    expect((await send('invoice.pdf.exe')).status).toBe(400);
    mockState.link = receiving({ upload_count: 5000 }); expect((await send()).status).toBe(429);
    mockState.link = receiving(); mockState.full = true; expect((await send()).status).toBe(429); // the atomic check, when two race
    expect(storage.upload).not.toHaveBeenCalled();
  });
  test('the folder was renamed while this uploaded: it lands where the folder is NOW', async () => {
    mockPlaced.linkNow = { folder_path: 'Clients/Acme Ltd', library_id: LIB };
    await send();
    expect(mockPlaced.calls[0].displayName).toBe('Clients/Acme Ltd/invoice.pdf');
    expect(libraries.writeRight).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'u1' }), LIB, 'Clients/Acme Ltd', expect.anything());
  });
  test('the link was ended, or the folder moved library, while this uploaded: refused', async () => {
    mockPlaced.linkNow = null; expect((await send()).status).toBe(403);
    mockPlaced.linkNow = { folder_path: 'Clients/Acme', library_id: 'another' }; expect((await send()).status).toBe(403);
  });
  describe('a big file, in pieces', () => {
    const pieceReq = (id, offset, total, body, extra = {}) => { let r = request(app()).post(`${API}/upload`).set('Content-Type', 'application/octet-stream').set('X-Upload-Id', id).set('X-Upload-Offset', String(offset)).set('X-Upload-Total', String(total)).set('X-Upload-Name', encodeURIComponent(extra.name || 'site survey.mp4')).set('X-Upload-Path', encodeURIComponent(extra.at || '')).set('X-Upload-Rel', encodeURIComponent(extra.rel || '')); if (extra.ticket) r = r.set('X-Share-Ticket', extra.ticket); return r.send(body); };
    const uid = () => crypto.randomBytes(12).toString('hex');
    beforeEach(() => { storage.uploadStream = jest.fn(async (_p, readable) => { const b = []; for await (const c of readable) b.push(c); storage._got = Buffer.concat(b); }); storage.isLocalProvider = jest.fn(async () => false); });

    test('is assembled byte for byte, streamed to storage, and lands like any other upload', async () => {
      const data = crypto.randomBytes(90000), id = uid();
      const a = await pieceReq(id, 0, data.length, data.subarray(0, 40000), { at: 'Invoices', rel: 'Videos/site survey.mp4' });
      expect(a.body).toEqual({ ok: true, received: 40000 });
      expect(storage.uploadStream).not.toHaveBeenCalled();                     // nothing is stored until it is whole
      const b = await pieceReq(id, 40000, data.length, data.subarray(40000), { at: 'Invoices', rel: 'Videos/site survey.mp4' });
      expect(b.body).toMatchObject({ ok: true, done: true, name: 'site survey.mp4' });
      expect(storage._got.equals(data)).toBe(true);
      expect(mockPlaced.calls[0]).toMatchObject({ displayName: 'Clients/Acme/Invoices/Videos/site survey.mp4', storedSize: 90000, mimetype: 'video/mp4' });
      expect(storage.upload).not.toHaveBeenCalled();                           // never held whole in memory
    });
    test('a file far past the old 100 MB ceiling is accepted; past the administrator\'s limit it is not', async () => {
      expect((await pieceReq(uid(), 0, 6 * 1024 ** 3, Buffer.alloc(1000))).body).toEqual({ ok: true, received: 1000 }); // 6 GB
      mockLimits.value = { maxFileMb: 50, maxFileBytes: 50 * 1048576, maxFiles: 5000, maxTotalBytes: 1e12 };
      const res = await pieceReq(uid(), 0, 51 * 1048576, Buffer.alloc(1000));
      expect(res.status).toBe(413); expect(res.body.error).toMatch(/50 MB limit/);
    });
    test('a blocked type, a climbing folder, or a file that would pass the link\'s total is refused at the FIRST piece', async () => {
      expect((await pieceReq(uid(), 0, 5000, Buffer.alloc(1000), { name: 'setup.exe' })).status).toBe(400);
      expect((await pieceReq(uid(), 0, 5000, Buffer.alloc(1000), { at: '../Secret' })).status).toBe(400);
      mockLimits.value = { maxFileMb: 10240, maxFileBytes: 1e10, maxFiles: 5000, maxTotalBytes: 4000 };
      expect((await pieceReq(uid(), 0, 5000, Buffer.alloc(1000))).status).toBe(429);
      expect(storage.uploadStream).not.toHaveBeenCalled();
    });
    test('pieces answer to the same door as everything else: no flag, no upload; password link, ticket only', async () => {
      mockState.link = receiving({ allow_upload: false });
      expect((await pieceReq(uid(), 0, 10, Buffer.alloc(10))).status).toBe(403);
      const { salt, hash } = passwordParts(LINK_PW); mockState.link = receiving({ password_salt: salt, password_hash: hash });
      expect((await pieceReq(uid(), 0, 10, Buffer.alloc(10))).status).toBe(401);
      const ok = await pieceReq(uid(), 0, 20, Buffer.alloc(10), { ticket: issueShareTicket(LINK) });
      expect(ok.status).toBe(200);
      expect(ok.body.ticket).toEqual(expect.any(String));                      // renewed, so a long upload does not die at 30 minutes
    });
    test('nobody without a ticket is handed one', async () => {
      expect((await pieceReq(uid(), 0, 20, Buffer.alloc(10))).body.ticket).toBeUndefined();
    });
    test('a lost answer: the repeated piece is told where the server is', async () => {
      const id = uid(); await pieceReq(id, 0, 3000, Buffer.alloc(1000));
      const again = await pieceReq(id, 0, 3000, Buffer.alloc(1000));
      expect(again.status).toBe(409); expect(again.body.received).toBe(1000);
    });
  });

  test('sending a folder turns it on only when asked', async () => {
    mockState.known = [];
    await request(app()).post('/api/files/folder/send').set('x-library-id', LIB).send({ path: 'Clients/Acme', recipients: ['ap@supplier.com'] });
    await request(app()).post('/api/files/folder/send').set('x-library-id', LIB).send({ path: 'Clients/Acme', recipients: ['ap@supplier.com'], allowUpload: true });
    const ins = mockQueries.filter(x => /INSERT INTO folder_share_links/.test(x.sql) && /allow_upload/.test(x.sql));
    expect(ins.map(x => x.params[11])).toEqual([false, true]);
    expect(email.sendMail.mock.calls[1][0].text).toMatch(/add your own files/);
    expect(email.sendMail.mock.calls[0][0].text).not.toMatch(/add your own files/);
  });
});

describe('who can see a link, and end it', () => {
  const row = (over = {}) => ({ id: LINK, folder_path: 'Clients/Acme', document_ids: [], expires_at: null, revoked_at: null, created_at: null, created_by_email: 'amy@corp.com',
    last_accessed_at: null, access_count: 0, password_hash: null, recipient_email: 'ap@supplier.com', live: true, require_signin: false, opened_at: '2026-09-18T10:00:00Z', ...over });
  const listQ = () => mockQueries.find(x => /^SELECT l\.id, l\.folder_path/.test(x.sql));
  test('the list says who each link went to, that it is live, and when it was first opened', async () => {
    mockState.listed = [row()];
    const res = await request(app()).get('/api/files/folder/links').query({ path: 'Clients/Acme' }).set('x-library-id', LIB);
    expect(res.body.shares[0]).toMatchObject({ recipient_email: 'ap@supplier.com', live: true, require_signin: false, opened_at: '2026-09-18T10:00:00Z', created_by_email: 'amy@corp.com' });
    expect(JSON.stringify(res.body)).not.toMatch(/token|password_hash/);
  });
  test('a member sees their own links; whoever manages the library sees every link sent from it', async () => {
    await request(app()).get('/api/files/folder/links').query({ path: 'Clients/Acme' }).set('x-library-id', LIB);
    expect(listQ().sql).toMatch(/\$6::boolean OR l\.created_by = \$2::uuid OR \(\$5::boolean AND l\.library_id = \$3::uuid\)/);
    expect(listQ().params.slice(4)).toEqual([false, false]);           // not a manager, not an admin: their own links only
    mockQueries.length = 0; mockState.manages = true;
    await request(app()).get('/api/files/folder/links').query({ path: 'Clients/Acme' }).set('x-library-id', LIB);
    expect(listQ().params.slice(2)).toEqual([LIB, 'Clients/Acme', true, false]);
    // every parameter is in the SQL, typed: Postgres refuses one it cannot type (an admin's unused $2 was a 500)
    for (let i = 1; i <= listQ().params.length; i++) expect(listQ().sql).toContain('$' + i);
  });
  test('a link from ANOTHER library that happens to share the folder name is not listed here', async () => {
    await request(app()).get('/api/files/folder/links').query({ path: 'Clients/Acme' }).set('x-library-id', LIB);
    expect(listQ().sql).toMatch(/l\.library_id IS NULL OR \$3::uuid IS NULL OR l\.library_id = \$3::uuid/);
  });
  test("the library's owner can end a link a member sent -- by owning the library, not by the files it lists", async () => {
    mockState.revoked = { id: LINK, folder_path: 'Clients/Acme' };
    const res = await request(app()).delete(`/api/files/folder/links/${LINK}`);
    expect(res.status).toBe(200);
    const q = mockQueries.find(x => /^UPDATE folder_share_links f\s+SET revoked_at/.test(x.sql));
    expect(q.sql).toMatch(/EXISTS \(SELECT 1 FROM libraries lb WHERE lb\.id = f\.library_id AND lb\.owner_id = \$1\)/);
    expect(q.params[0]).toBe('u1');
  });
  test('anyone else is told there is no such link', async () => {
    mockState.revoked = null;
    expect((await request(app()).delete(`/api/files/folder/links/${LINK}`)).status).toBe(404);
  });
});

describe('sending a folder to people', () => {
  const send = (body) => request(app()).post('/api/files/folder/send').set('x-library-id', LIB).send({ path: 'Clients/Acme', ...body });
  const inserted = () => mockQueries.filter(q => /INSERT INTO folder_share_links/.test(q.sql));
  test('one LIVE link each; a colleague with an account gets one only they can open, signed in', async () => {
    mockState.known = ['amy@corp.com'];
    const res = await send({ recipients: ['amy@corp.com', 'ap@supplier.com'], password: 'hunter2' });
    expect(res.body.results.map(r => [r.to, r.kind, r.sent])).toEqual([['amy@corp.com', 'signin_link', true], ['ap@supplier.com', 'link', true]]);
    const [amy, ap] = inserted();
    expect(amy.sql).toMatch(/live, require_signin, allow_upload\)\s*VALUES \(\$1, \$2::uuid\[\], \$3, \$4, \$5, \$6, \$7, \$8, \$9, \$10, true, \$11, \$12\)/);
    expect(amy.params.slice(8)).toEqual([LIB, 'amy@corp.com', true, false]); expect(amy.params[4]).toBeNull();  // the sign-in is its lock: no password
    expect(ap.params.slice(8)).toEqual([LIB, 'ap@supplier.com', false, false]); expect(ap.params[4]).toEqual(expect.any(String)); // the outsider's link keeps the password
    const [toAmy, toAp] = email.sendMail.mock.calls.map(c => c[0]);
    expect(toAmy.text).toMatch(/https:\/\/depot\.example\/#\/open\/flink\/[\w-]{20,}/); expect(toAmy.text).not.toContain('/f/');
    expect(toAp.text).toMatch(/https:\/\/depot\.example\/f\/[\w-]{20,}/); expect(toAp.text).toContain('password'); expect(toAp.text).not.toContain('hunter2');
    expect(res.body.hasPassword).toBe(true);
  });
  test('"has an account" means one that could open it: verified at that address, and not switched off', async () => {
    await send({ recipients: ['amy@corp.com'] });
    const q = mockQueries.find(x => /FROM user_roles/.test(x.sql) && /^SELECT lower\(verified_email\)/.test(x.sql));
    expect(q.sql).toMatch(/lower\(verified_email\) = ANY\(\$1::text\[\]\) AND disabled_at IS NULL/);
  });
  test('a same-domain colleague with no account gets a link they can actually open', async () => {
    const res = await send({ recipients: ['newhire@corp.com'] });
    expect(res.body.results[0].kind).toBe('link');
    expect(inserted()[0].params[10]).toBe(false);
  });
  test('takes the right to add files to the folder, and nothing less', async () => {
    mockState.right = { status: 403, error: "You can't add files here." };
    expect((await send({ recipients: ['ap@supplier.com'] })).status).toBe(403);
    expect(inserted()).toHaveLength(0); expect(email.sendMail).not.toHaveBeenCalled();
  });
  test('if the email fails the link comes back to the sender: it exists nowhere else', async () => {
    email.sendMail.mockResolvedValueOnce({ sent: false, reason: 'mailbox_full' });
    const r = (await send({ recipients: ['ap@supplier.com'] })).body.results[0];
    expect(r).toMatchObject({ sent: false, reason: 'mailbox_full' }); expect(r.url).toMatch(/\/f\/[\w-]{20,}$/);
  });
  test.each([[{ recipients: [] }, /At least one/], [{ recipients: Array.from({ length: 26 }, (_, i) => `p${i}@x.com`) }, /at most 25/], [{ recipients: ['not-an-address'] }, /Not a valid email/]])('refuses %j', async (body, msg) => {
    const res = await send(body); expect(res.status).toBe(400); expect(res.body.error).toMatch(msg);
  });
});

describe('making an anonymous link', () => {
  test('is no longer refused for a big folder, and points at the PAGE', async () => {
    mockState.docs = [doc(1, 'Clients/Acme/huge.bin', 20 * 1024 ** 3)];
    const db = require('../../lib/db');
    db.queryOne.mockImplementation(async (sql) => (/INSERT INTO folder_share_links/.test(sql) ? { id: LINK, folder_path: 'Clients/Acme', document_ids: [ID(1)] } : { '?column?': 1 }));
    const res = await request(app()).post('/api/files/folder/links').set('x-library-id', LIB).send({ path: 'Clients/Acme' });
    expect(res.status).toBe(200);
    expect(res.body.share.url).toMatch(/^https:\/\/depot\.example\/f\/[\w-]{20,}$/);
  });
});

describe('a signed-in folder ZIP streams to disk instead of being held in the page', () => {
  const ticket = (body = {}) => request(app()).post('/api/files/folder/zip-ticket').set('x-library-id', LIB).send({ path: 'Clients/Acme', ...body });
  beforeEach(() => { require('../../lib/db').query.mockImplementation(async (sql, params) => { mockQueries.push({ sql, params }); return /FROM documents d/.test(sql) ? mockState.docs.filter(d => d.name.startsWith(params[0] + '/')) : []; }); });
  test('the signed-in request buys a short-lived address; the browser downloads from it with no header at all', async () => {
    const res = await ticket();
    expect(res.body).toMatchObject({ files: 4, bytes: 100 });
    expect(res.body.url).toMatch(/^\/api\/files\/folder\/zip-download\?u=u1&lib=/);
    const dl = await request(app()).get(res.body.url);                       // no Authorization
    expect(dl.status).toBe(200); expect(dl.headers['content-type']).toBe('application/zip');
  });
  test('too large and too busy are said in words, before anything is downloaded', async () => {
    mockSettings.folder_zip_max_mb = '1'; mockState.docs = [doc(1, 'Clients/Acme/big.bin', 3 * 1024 * 1024)];
    let res = await ticket(); expect(res.status).toBe(413); expect(res.body.error).toMatch(/larger than the 1\.0 MB/);
    mockSettings.folder_zip_max_mb = null;
    const held = [zipLarge.takeSlot(), zipLarge.takeSlot(), zipLarge.takeSlot()];
    try { res = await ticket(); expect(res.status).toBe(503); } finally { held.forEach(f => f()); }
  });
  test.each([
    ['another folder', (u) => u.replace('path=Clients%2FAcme', 'path=Clients%2FAcmeSecret')],
    ['another person', (u) => u.replace('u=u1', 'u=u2')],
    ['another library', (u) => u.replace(/lib=[^&]+/, 'lib=bbbbbbbb-0000-4000-8000-000000000002')],
    ['a forged ticket', (u) => u.replace(/t=.+$/, 't=9999999999999.forged')],
  ])('the address is good for exactly what was asked: not %s', async (_l, tamper) => {
    const { url } = (await ticket()).body;
    expect((await request(app()).get(tamper(url))).status).toBe(404);
  });
  test('somebody switched off since the ticket was issued gets nothing', async () => {
    const { url } = (await ticket()).body;
    mockActor.value = null;
    expect((await request(app()).get(url)).status).toBe(404);
  });
});

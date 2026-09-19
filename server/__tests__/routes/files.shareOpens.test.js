'use strict';
// Sharing a file: every email carries a link to the file, a colleague sent a file by
// someone who cannot hand out access gets a link only THEY can open, and the sharer is
// told the first time a recipient opens what was shared -- once, and only once.
const request = require('supertest');
const express = require('express');
const crypto = require('crypto');

const mockQueries = [];
const mockState = { link: null, claimed: new Set(), aclOpened: [], placeOpened: [], knownUsers: [] };
const mockHash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
jest.mock('../../lib/db', () => ({
  query: jest.fn(async (sql, params) => {
    mockQueries.push({ sql, params });
    // the first-open claim: true once per row, whoever asks
    const claim = sql.match(/^UPDATE (document_share_links|folder_share_links) SET opened_at = NOW\(\) WHERE id = \$1 AND opened_at IS NULL/);
    if (claim) { const k = claim[1] + ':' + params[0]; if (mockState.claimed.has(k)) return []; mockState.claimed.add(k); return [{ id: params[0] }]; }
    if (/^\s*UPDATE document_acl SET opened_at/.test(sql)) return mockState.aclOpened.splice(0);
    if (/^\s*UPDATE library_grants SET opened_at/.test(sql)) return mockState.placeOpened.splice(0);
    if (/FROM user_roles/.test(sql)) return mockState.knownUsers.map(e => ({ email: e, verified_email: e }));
    return [];
  }),
  queryOne: jest.fn(async (sql, params) => {
    mockQueries.push({ sql, params });
    if (/FROM document_share_links s\s+JOIN documents d/.test(sql)) return mockState.link && params[0] === mockState.link.token_hash ? { ...mockState.link } : null;
    return null;
  }),
  withTransaction: jest.fn(),
}));
jest.mock('../../lib/auditLog', () => ({ append: jest.fn().mockResolvedValue({}) }));
jest.mock('../../lib/settings', () => ({ getOrEnv: jest.fn(async (k) => (k === 'app_url' ? 'https://depot.example' : null)) }));
jest.mock('../../lib/storage', () => ({ downloadStream: jest.fn(async () => ({ stream: require('stream').Readable.from(['abc']), length: 3 })) }));
jest.mock('../../lib/notifications', () => ({ create: jest.fn().mockResolvedValue({}) }));
jest.mock('../../lib/emailEvents', () => ({ send: jest.fn().mockResolvedValue({ sent: true }) }));
jest.mock('../../lib/docFollows', () => ({ followersOf: jest.fn(async () => []) }));
jest.mock('../../lib/linkAccess', () => ({ creatorCanPublish: jest.fn(async (id) => ({ id, role: 'contributor', email: 'sharer@corp.com' })) }));
jest.mock('../../lib/email', () => ({ sendMail: jest.fn(async () => ({ sent: true })), actingAs: jest.requireActual('../../lib/email').actingAs }));
const mockCan = { admin: false };
jest.mock('../../lib/documentAccess', () => ({
  ...jest.requireActual('../../lib/documentAccess'),
  getAccessibleDocument: jest.fn(async ({ required }) => (required === 'admin' && !mockCan.admin ? null : { id: 'doc-1', name: 'Plans/Q3 Deck.pptx', library_id: 'lib-1', uploaded_by: 'u1' })),
  grantUserAccess: jest.fn(async (_id, { email, permission }) => ({ subject_email: email, permission })),
  listGrants: jest.fn(async () => [{ subject_email: 'amy@corp.com', permission: 'read' }]),
}));
const mockUser = { value: null };
jest.mock('../../middleware/auth', () => (req, _res, next) => { req.user = mockUser.value; next(); });

const email = require('../../lib/email');
const notifications = require('../../lib/notifications');
const emailEvents = require('../../lib/emailEvents');
const app = () => { const a = express(); a.use(express.json()); a.use('/api/files', require('../../routes/files')); return a; };
const SHARER = { id: 'u1', email: 'sharer@corp.com', verifiedEmail: 'sharer@corp.com', role: 'contributor' };
const AMY = { id: 'u2', email: 'amy@corp.com', verifiedEmail: 'amy@corp.com', role: 'contributor' };
const link = (over = {}) => ({ id: 'link-1', document_id: 'doc-1', token_hash: mockHash('tok'), name: 'Plans/Q3 Deck.pptx', doc_size: 3, storage_path: 'p', mime_type: 'x/y',
  created_by: 'u1', created_by_email: 'sharer@corp.com', recipient_email: null, require_signin: false, password_hash: null, password_salt: null, allow_upload: false, expires_at: null, ...over });
const opened = () => notifications.create.mock.calls.map(c => c[0]).filter(n => n.type === 'share_opened');
const mailed = (type) => emailEvents.send.mock.calls.filter(c => c[0] === type);

beforeEach(() => {
  mockQueries.length = 0; Object.assign(mockState, { link: null, aclOpened: [], placeOpened: [], knownUsers: [] }); mockState.claimed.clear();
  mockCan.admin = false; mockUser.value = SHARER; jest.clearAllMocks();
});

describe('what a share email contains', () => {
  test('giving someone access emails a link to THAT FILE, not an instruction to go and find it', async () => {
    mockCan.admin = true;
    await request(app()).put('/api/files/doc-1/access').send({ email: 'amy@corp.com', permission: 'read' });
    const mail = emailEvents.send.mock.calls.find(c => c[0] === 'share_granted')[1];
    expect(mail.text).toContain('https://depot.example/#/open/file/doc-1');
    expect(mail.text).not.toMatch(/Sign in to Depot to open it\./);
  });
  test('Send, from someone who manages the file: a colleague is given access and linked to the file', async () => {
    mockCan.admin = true;
    const res = await request(app()).post('/api/files/doc-1/send').send({ recipients: ['amy@corp.com'] });
    expect(res.body.results[0]).toMatchObject({ kind: 'granted', sent: true });
    expect(email.sendMail.mock.calls[0][0].text).toContain('https://depot.example/#/open/file/doc-1');
  });
  test('the email can be sent again, with its link', async () => {
    mockCan.admin = true;
    const res = await request(app()).post('/api/files/doc-1/access/resend').send({ email: 'amy@corp.com' });
    expect(res.body).toEqual({ sent: true });
    expect(email.sendMail.mock.calls[0][0]).toMatchObject({ to: 'amy@corp.com' });
    expect(email.sendMail.mock.calls[0][0].text).toContain('/#/open/file/doc-1');
  });
  test('...but only to somebody who has access, and only by whoever manages it', async () => {
    mockCan.admin = true;
    expect((await request(app()).post('/api/files/doc-1/access/resend').send({ email: 'stranger@corp.com' })).status).toBe(404);
    mockCan.admin = false;
    expect((await request(app()).post('/api/files/doc-1/access/resend').send({ email: 'amy@corp.com' })).status).toBe(404);
    expect(email.sendMail).not.toHaveBeenCalled();
  });
});

describe('Send, from someone who may share the file but not hand out access to it', () => {
  test('a colleague gets a link that needs THEIR sign-in: no grant, no public page', async () => {
    const res = await request(app()).post('/api/files/doc-1/send').send({ recipients: ['amy@corp.com'], password: 'hunter2' });
    expect(res.body.results[0]).toMatchObject({ to: 'amy@corp.com', kind: 'signin_link', sent: true });
    expect(res.body.results[0].url).toBeUndefined();
    expect(require('../../lib/documentAccess').grantUserAccess).not.toHaveBeenCalled();
    const ins = mockQueries.find(q => /INSERT INTO document_share_links/.test(q.sql));
    expect(ins.sql).toMatch(/require_signin\)\s*VALUES \(\$1,\$2,\$3,\$4,\$5,\$6,false,true\)/);
    expect(ins.params).toEqual(expect.arrayContaining(['amy@corp.com']));
    const mail = email.sendMail.mock.calls[0][0];
    expect(mail.text).toMatch(/https:\/\/depot\.example\/#\/open\/link\/[\w-]{20,}/);
    expect(mail.text).not.toContain('/s/');
  });
  test('somebody outside still gets their own public link', async () => {
    const res = await request(app()).post('/api/files/doc-1/send').send({ recipients: ['ap@supplier.com'] });
    expect(res.body.results[0]).toMatchObject({ kind: 'link', sent: true });
    expect(email.sendMail.mock.calls[0][0].text).toMatch(/https:\/\/depot\.example\/s\//);
    expect(mockQueries.find(q => /INSERT INTO document_share_links/.test(q.sql)).sql).not.toMatch(/require_signin/);
  });
});

describe('a sign-in link', () => {
  beforeEach(() => { mockState.link = link({ require_signin: true, recipient_email: 'amy@corp.com' }); });
  test('does not exist as far as the public page is concerned', async () => {
    expect((await request(app()).get('/api/files/share/tok/info')).status).toBe(404);
    expect((await request(app()).post('/api/files/share/tok/ticket')).status).toBe(404);
    expect((await request(app()).get('/api/files/share/tok')).status).toBe(404);
    expect(opened()).toHaveLength(0);
  });
  test('opens for the person it was sent to, and hands them a ticketed download', async () => {
    mockUser.value = AMY;
    const res = await request(app()).get('/api/files/signin-link/tok');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: 'Plans/Q3 Deck.pptx', sentBy: 'sharer@corp.com' });
    expect((await request(app()).get(res.body.downloadUrl)).status).toBe(200); // the ticket it minted is what unlocks the bytes
  });
  test('is refused to anyone else who is signed in, by name', async () => {
    mockUser.value = { ...AMY, id: 'u3', email: 'bob@corp.com', verifiedEmail: 'bob@corp.com' };
    const res = await request(app()).get('/api/files/signin-link/tok');
    expect(res.status).toBe(403);
    expect(res.body.error).toContain('amy@corp.com');
    expect(opened()).toHaveLength(0);
  });
  test('an ordinary public link is not a sign-in link', async () => {
    mockState.link = link(); mockUser.value = AMY;
    expect((await request(app()).get('/api/files/signin-link/tok')).status).toBe(404);
  });
});

describe('the sharer is told the first time, and only the first time', () => {
  test('looking at a link\'s page is opening it: one notice, one email, naming who', async () => {
    mockState.link = link({ recipient_email: 'ap@supplier.com' });
    await request(app()).get('/api/files/share/tok/info');
    await request(app()).get('/api/files/share/tok/info');
    expect(opened()).toHaveLength(1);
    expect(opened()[0]).toMatchObject({ userEmail: 'sharer@corp.com', title: 'ap@supplier.com opened your file', refType: 'document', refId: 'doc-1' });
    expect(mailed('share_opened')).toHaveLength(1);
  });
  test('a password page nobody unlocked has told nobody anything', async () => {
    const { passwordParts } = require('../../lib/shareLinks');
    const { salt, hash } = passwordParts('hunter2');
    mockState.link = link({ password_salt: salt, password_hash: hash });
    await request(app()).get('/api/files/share/tok/info');
    expect(opened()).toHaveLength(0);
    await request(app()).get('/api/files/share/tok/info').set('x-share-password', 'hunter2');
    expect(opened()).toHaveLength(1);
  });
  test('a download after the page was seen is a note in the app, never a second email', async () => {
    mockState.link = link();
    await request(app()).get('/api/files/share/tok/info');
    await request(app()).get('/api/files/share/tok');
    expect(mailed('share_opened')).toHaveLength(1);
    expect(mailed('share_downloaded')).toHaveLength(0);
    expect(notifications.create.mock.calls.map(c => c[0].type)).toEqual(['share_opened', 'share_downloaded']);
  });
  test('a download with no page view first IS the open', async () => {
    mockState.link = link();
    await request(app()).get('/api/files/share/tok');
    expect(notifications.create.mock.calls.map(c => c[0].type)).toEqual(['share_opened']);
  });
  test('a colleague opening their sign-in link tells the sender who', async () => {
    mockState.link = link({ require_signin: true, recipient_email: 'amy@corp.com' }); mockUser.value = AMY;
    await request(app()).get('/api/files/signin-link/tok');
    await request(app()).get('/api/files/signin-link/tok');
    expect(opened()).toHaveLength(1);
    expect(opened()[0].title).toBe('amy@corp.com opened your file');
  });
  test('a colleague opening a file they were GIVEN tells whoever gave it to them', async () => {
    mockUser.value = AMY; mockCan.admin = true;
    mockState.aclOpened = [{ granted_by: 'u1', granted_by_email: 'sharer@corp.com' }];
    await request(app()).post('/api/files/doc-1/open');
    await new Promise(r => setImmediate(r));
    expect(opened()).toHaveLength(1);
    expect(opened()[0]).toMatchObject({ userEmail: 'sharer@corp.com', title: 'amy@corp.com opened your file', refId: 'doc-1' });
    const upd = mockQueries.find(q => /UPDATE document_acl SET opened_at/.test(q.sql));
    expect(upd.sql).toMatch(/opened_at IS NULL/);                       // once
    expect(upd.sql).toMatch(/lower\(granted_by_email\) <> \$2/);        // never about yourself
    expect(upd.params).toEqual(['doc-1', 'amy@corp.com']);
  });
  test('...or the library or folder it sits in, and the notice opens at that folder', async () => {
    mockUser.value = AMY; mockCan.admin = true;
    mockState.placeOpened = [{ granted_by: 'u1', granted_by_email: 'sharer@corp.com', folder_path: 'Plans' }];
    await request(app()).post('/api/files/doc-1/open');
    await new Promise(r => setImmediate(r));
    expect(opened()[0]).toMatchObject({ title: 'amy@corp.com opened your shared folder', refType: 'library', refId: 'lib-1', refPath: 'Plans' });
    const upd = mockQueries.find(q => /UPDATE library_grants SET opened_at/.test(q.sql));
    expect(upd.sql).toMatch(/subject_type = 'user'/);                   // a group has no one recipient
    expect(upd.params).toEqual(['lib-1', 'amy@corp.com', 'Plans/Q3 Deck.pptx']);
  });
  test('opening a file nobody shared with you tells nobody', async () => {
    mockUser.value = AMY; mockCan.admin = true;
    await request(app()).post('/api/files/doc-1/open');
    await new Promise(r => setImmediate(r));
    expect(opened()).toHaveLength(0);
    expect(emailEvents.send).not.toHaveBeenCalled();
  });
  test('you are never told about your own open', async () => {
    const { linkOpened } = require('../../lib/shareOpens');
    expect(await linkOpened(link(), 'SHARER@corp.com')).toBe(false);
    expect(mockQueries.some(q => /SET opened_at/.test(q.sql))).toBe(false);
  });
});

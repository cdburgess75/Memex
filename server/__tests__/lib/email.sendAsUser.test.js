'use strict';
// Sending as the member who caused the notification.
//
// Under Graph app-only auth the mailbox in the request URL *is* the From
// address — there is no header to set — so "send as Owen" means POSTing to
// Owen's mailbox. Not every Depot member has one (local and AD accounts often
// do not, and a tenant may keep the app scoped to a single mailbox), so an
// ineligible sender must fall back to the workspace address rather than drop
// the mail. These tests pin that contract, and pin that a bad actor address can
// never reach the request.

jest.mock('../../lib/settings', () => ({
  getOrEnv: jest.fn(),
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn(),
}));
const settings = require('../../lib/settings');
const email = require('../../lib/email');

const WORKSPACE = 'depot@ptechllc.com';
const CONF = {
  email_provider: 'graph',
  graph_tenant_id: 'tenant-1',
  graph_client_id: 'client-1',
  graph_client_secret: 'shh',
  email_from: WORKSPACE,
};

function config(overrides = {}) {
  const all = { ...CONF, ...overrides };
  settings.getOrEnv.mockImplementation(async (k) => (k in all ? all[k] : null));
}

const TOKEN_OK = { ok: true, status: 200, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
const accepted = () => ({ ok: true, status: 202, json: async () => ({}) });
const refused = (status, message) => ({ ok: false, status, json: async () => ({ error: { message } }) });

// First fetch is always the token; the rest are sendMail attempts.
function graphResponses(...sends) {
  let i = -1;
  global.fetch = jest.fn(async () => { i += 1; return i === 0 ? TOKEN_OK : sends[Math.min(i - 1, sends.length - 1)]; });
}
const sendCalls = () => global.fetch.mock.calls.filter(c => String(c[0]).includes('/sendMail'));
const mailboxOf = (call) => decodeURIComponent(String(call[0]).match(/users\/([^/]+)\/sendMail/)[1]);

beforeEach(() => {
  jest.clearAllMocks();
  email._resetForTests();
  config();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { jest.restoreAllMocks(); });

describe('graph: sending as the acting member', () => {
  test('posts to the member mailbox and keeps a copy in their Sent Items', async () => {
    graphResponses(accepted());
    const r = await email.sendMail({ to: 'x@y.com', subject: 's', text: 't', actorEmail: 'owen@ptechllc.com' });
    expect(r).toMatchObject({ sent: true, via: 'graph', from: 'owen@ptechllc.com' });
    expect(sendCalls()).toHaveLength(1);
    expect(mailboxOf(sendCalls()[0])).toBe('owen@ptechllc.com');
    expect(JSON.parse(sendCalls()[0][1].body).saveToSentItems).toBe(true);
  });

  test('without an actor it still sends from the workspace mailbox', async () => {
    graphResponses(accepted());
    const r = await email.sendMail({ to: 'x@y.com', subject: 's', text: 't' });
    expect(r).toMatchObject({ sent: true, from: WORKSPACE });
    expect(mailboxOf(sendCalls()[0])).toBe(WORKSPACE);
    expect(JSON.parse(sendCalls()[0][1].body).saveToSentItems).toBe(false);
  });

  test('an actor who IS the workspace mailbox is not treated as a per-user send', async () => {
    graphResponses(accepted());
    await email.sendMail({ to: 'x@y.com', subject: 's', text: 't', actorEmail: WORKSPACE.toUpperCase() });
    expect(sendCalls()).toHaveLength(1);
    expect(JSON.parse(sendCalls()[0][1].body).saveToSentItems).toBe(false);
  });

  test('email_send_as_user=false pins every send to the workspace mailbox', async () => {
    config({ email_send_as_user: 'false' });
    graphResponses(accepted());
    const r = await email.sendMail({ to: 'x@y.com', subject: 's', text: 't', actorEmail: 'owen@ptechllc.com' });
    expect(r).toMatchObject({ sent: true, from: WORKSPACE });
    expect(sendCalls()).toHaveLength(1);
    expect(mailboxOf(sendCalls()[0])).toBe(WORKSPACE);
  });
});

describe('graph: fallback when the member has no usable mailbox', () => {
  // Each of these is a real tenant condition rather than a transient fault.
  const cases = [
    ['no such user in the tenant', refused(404, "Resource 'owen@ptechllc.com' does not exist")],
    ['mailbox not REST-enabled (on-prem)', refused(404, 'MailboxNotEnabledForRESTAPI')],
    ['app not authorised for that mailbox', refused(403, 'Access to OData is disabled.')],
    ['tenant app-only policy block', refused(403, '[RAOP] : Blocked by tenant configured AppOnly AccessPolicy settings.')],
    ['unlicensed mailbox reported as 401', refused(401, 'The mailbox is either inactive or not found')],
  ];
  test.each(cases)('falls back to the workspace mailbox: %s', async (_label, response) => {
    graphResponses(response, accepted());
    const r = await email.sendMail({ to: 'x@y.com', subject: 's', text: 't', actorEmail: 'owen@ptechllc.com' });
    expect(r).toMatchObject({ sent: true, via: 'graph', from: WORKSPACE, fellBack: true });
    const calls = sendCalls();
    expect(calls).toHaveLength(2);
    expect(mailboxOf(calls[0])).toBe('owen@ptechllc.com');
    expect(mailboxOf(calls[1])).toBe(WORKSPACE);
  });

  test('a genuine fault does NOT silently retry as the workspace — it reports', async () => {
    graphResponses(refused(500, 'Internal server error'));
    const r = await email.sendMail({ to: 'x@y.com', subject: 's', text: 't', actorEmail: 'owen@ptechllc.com' });
    expect(r.sent).toBe(false);
    expect(r.reason).toMatch(/500/);
    expect(sendCalls()).toHaveLength(1);
  });

  test('if the fallback also fails the failure is reported, not swallowed', async () => {
    graphResponses(refused(404, 'no mailbox'), refused(403, 'Access to OData is disabled.'));
    const r = await email.sendMail({ to: 'x@y.com', subject: 's', text: 't', actorEmail: 'owen@ptechllc.com' });
    expect(r.sent).toBe(false);
    expect(sendCalls()).toHaveLength(2);
  });
});

describe('sender validation — the actor address reaches a URL and a header', () => {
  test.each([
    ['header injection via newline', 'owen@ptechllc.com\nBcc: evil@attacker.com'],
    ['a second address', 'owen@ptechllc.com,evil@attacker.com'],
    ['angle brackets', '<owen@ptechllc.com>'],
    ['not an address at all', 'owen'],
    ['empty', '   '],
  ])('%s is ignored and the workspace mailbox is used', async (_label, actorEmail) => {
    graphResponses(accepted());
    await email.sendMail({ to: 'x@y.com', subject: 's', text: 't', actorEmail });
    expect(sendCalls()).toHaveLength(1);
    expect(mailboxOf(sendCalls()[0])).toBe(WORKSPACE);
  });
});

describe('smtp: the relay authenticates as the account, so the envelope stays put', () => {
  const sent = [];
  beforeEach(() => {
    sent.length = 0;
    jest.doMock('nodemailer', () => ({
      createTransport: () => ({ sendMail: async (m) => { sent.push(m); return { messageId: '1' }; } }),
    }), { virtual: true });
    config({ email_provider: 'smtp', smtp_host: 'smtp.example.com', smtp_user: 'depot@ptechllc.com', email_from: WORKSPACE });
  });

  test('From is the member, envelope + reply-to keep the mail deliverable', async () => {
    const r = await email.sendMail({ to: 'x@y.com', subject: 's', text: 't', actorEmail: 'owen@ptechllc.com' });
    expect(r).toMatchObject({ sent: true, via: 'smtp' });
    expect(sent[0].from).toBe('owen@ptechllc.com');
    // SPF/DMARC align on the envelope, which must stay on the authenticated account.
    expect(sent[0].envelope).toEqual({ from: WORKSPACE, to: 'x@y.com' });
    expect(sent[0].replyTo).toBe('owen@ptechllc.com');
  });

  test('without an actor nothing is overridden', async () => {
    await email.sendMail({ to: 'x@y.com', subject: 's', text: 't' });
    expect(sent[0].from).toBe(WORKSPACE);
    expect(sent[0].envelope).toBeUndefined();
    expect(sent[0].replyTo).toBeUndefined();
  });
});

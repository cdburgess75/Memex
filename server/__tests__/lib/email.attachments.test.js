'use strict';
// Covers the new email plumbing: SMTP relay TLS controls (require STARTTLS, accept
// a self-signed relay cert), calendar invites over SMTP, and .ics/attachments
// carried as Graph fileAttachments.
jest.mock('../../lib/settings', () => ({ getOrEnv: jest.fn() }));
// nodemailer is a real dependency (present in the built container) but is lazily
// required by email.js; mock it virtually so this suite runs even where the local
// node_modules hasn't materialized it.
jest.mock('nodemailer', () => {
  const sent = [];
  const createTransport = jest.fn(() => ({ sendMail: jest.fn(async (m) => { sent.push(m); return {}; }) }));
  return { createTransport, __sent: sent };
}, { virtual: true });
const settings = require('../../lib/settings');
const nodemailer = require('nodemailer');
const email = require('../../lib/email');

function cfg(map) { settings.getOrEnv.mockImplementation(async (k) => (k in map ? map[k] : null)); }

const realFetch = global.fetch;
beforeEach(() => {
  email._resetForTests();
  settings.getOrEnv.mockReset();
  nodemailer.createTransport.mockClear();
  nodemailer.__sent.length = 0;
});
afterEach(() => { global.fetch = realFetch; });

const ICS = 'BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nEND:VCALENDAR\r\n';

describe('SMTP relay TLS controls', () => {
  test('require STARTTLS + accept self-signed pass through to the transport', async () => {
    cfg({ smtp_host: 'relay.corp', smtp_port: '25', email_from: 'memex@corp', smtp_require_tls: 'true', smtp_reject_unauthorized: 'false' });
    await email.sendMail({ to: 'a@corp', subject: 's', text: 't' });
    const opts = nodemailer.createTransport.mock.calls.at(-1)[0];
    expect(opts.requireTLS).toBe(true);
    expect(opts.tls).toEqual({ rejectUnauthorized: false });
  });

  test('secure by default: no TLS relaxation unless opted in', async () => {
    cfg({ smtp_host: 'relay.corp', smtp_port: '587', email_from: 'memex@corp' });
    await email.sendMail({ to: 'a@corp', subject: 's', text: 't' });
    const opts = nodemailer.createTransport.mock.calls.at(-1)[0];
    expect(opts.requireTLS).toBeUndefined();
    expect(opts.tls).toBeUndefined();
  });
});

describe('calendar invite over SMTP', () => {
  test('icalEvent is handed to nodemailer as a REQUEST invite', async () => {
    cfg({ smtp_host: 'relay.corp', smtp_port: '587', email_from: 'memex@corp' });
    const r = await email.sendMail({ to: 'a@corp', subject: 'Invite', text: 'body', icalEvent: { method: 'REQUEST', content: ICS } });
    expect(r).toEqual({ sent: true, via: 'smtp' });
    const mail = nodemailer.__sent.at(-1);
    expect(mail.icalEvent).toMatchObject({ method: 'REQUEST', filename: 'invite.ics', content: ICS });
  });
});

describe('Graph attachments', () => {
  function mockGraphOk() {
    global.fetch = jest.fn(async (url) => String(url).includes('/token')
      ? { ok: true, status: 200, json: async () => ({ access_token: 't', expires_in: 3600 }) }
      : { ok: true, status: 202, json: async () => ({}) });
  }

  test('an .ics invite is sent as a text/calendar fileAttachment', async () => {
    cfg({ graph_tenant_id: 't', graph_client_id: 'c', email_from: 'memex@x.com', graph_client_secret: 's' });
    mockGraphOk();
    await email.sendMail({ to: 'a@x.com', subject: 'Invite', text: 'b', icalEvent: { method: 'REQUEST', filename: 'invite.ics', content: ICS } });
    const send = global.fetch.mock.calls.find(c => String(c[0]).includes('/sendMail'));
    const atts = JSON.parse(send[1].body).message.attachments;
    expect(atts).toHaveLength(1);
    expect(atts[0]['@odata.type']).toBe('#microsoft.graph.fileAttachment');
    expect(atts[0].name).toBe('invite.ics');
    expect(atts[0].contentType).toMatch(/^text\/calendar; method=REQUEST/);
    expect(Buffer.from(atts[0].contentBytes, 'base64').toString('utf8')).toBe(ICS);
  });

  test('a plain send carries no attachments field', async () => {
    cfg({ graph_tenant_id: 't', graph_client_id: 'c', email_from: 'memex@x.com', graph_client_secret: 's' });
    mockGraphOk();
    await email.sendMail({ to: 'a@x.com', subject: 's', text: 'b' });
    const send = global.fetch.mock.calls.find(c => String(c[0]).includes('/sendMail'));
    expect(JSON.parse(send[1].body).message.attachments).toBeUndefined();
  });
});

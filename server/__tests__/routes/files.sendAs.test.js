'use strict';
// Mail sent on a member's behalf comes from their own mailbox, and names them, only
// when the identity provider has verified their address. An account that merely
// claims someone's address (a local Keycloak user can change their own, unverified)
// must not send from that person's real mailbox, nor be introduced as them.
const request = require('supertest');
const express = require('express');

jest.mock('../../lib/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), withTransaction: jest.fn() }));
jest.mock('../../lib/auditLog', () => ({ append: jest.fn().mockResolvedValue({}) }));
jest.mock('../../lib/settings', () => ({ getOrEnv: jest.fn(async (k) => (k === 'app_url' ? 'https://depot.example' : null)) }));
jest.mock('../../lib/storage', () => ({}));
jest.mock('../../lib/notifications', () => ({ create: jest.fn().mockResolvedValue({}) }));
jest.mock('../../lib/email', () => ({ sendMail: jest.fn(async () => ({ sent: true, via: 'graph' })), actingAs: jest.requireActual('../../lib/email').actingAs }));
jest.mock('../../lib/documentAccess', () => ({
  ...jest.requireActual('../../lib/documentAccess'),
  getAccessibleDocument: jest.fn(async ({ required }) => (required === 'write' ? { id: 'doc-1', name: 'Invoice.pdf', uploaded_by: 'u1' } : null)),
}));
const mockUser = { value: null };
jest.mock('../../middleware/auth', () => (req, _res, next) => { req.user = mockUser.value; next(); });

const email = require('../../lib/email');
const app = () => { const a = express(); a.use(express.json()); a.use('/api/files', require('../../routes/files')); return a; };
const send = () => request(app()).post('/api/files/doc-1/send').send({ recipients: ['ap@supplier.com'], message: 'Please pay today' });

beforeEach(() => email.sendMail.mockClear());

test('a verified member sends from their own mailbox, under their own name', async () => {
  mockUser.value = { id: 'u1', email: 'me@corp.com', verifiedEmail: 'me@corp.com', role: 'contributor' };
  expect((await send()).status).toBe(200);
  const mail = email.sendMail.mock.calls[0][0];
  expect(mail.actorEmail).toBe('me@corp.com');
  expect(mail.subject).toBe('me@corp.com sent you a file: Invoice.pdf');
});

test("an unverified address never sends from that mailbox, and is labelled as unverified", async () => {
  mockUser.value = { id: 'u2', email: 'cfo@corp.com', verifiedEmail: null, emailVerified: false, role: 'contributor' };
  expect((await send()).status).toBe(200);
  const mail = email.sendMail.mock.calls[0][0];
  expect(mail.actorEmail).toBeNull(); // the workspace mailbox sends instead
  expect(mail.subject).toBe('cfo@corp.com (unverified address) sent you a file: Invoice.pdf');
  expect(mail.text).toMatch(/^cfo@corp\.com \(unverified address\) sent you a file/);
});

describe('actingAs', () => {
  const { actingAs } = jest.requireActual('../../lib/email');
  test.each([
    ['a request with a verified address', { email: 'A@x.com', verifiedEmail: 'a@x.com' }, { sendAs: 'a@x.com', label: 'a@x.com' }],
    ['a request whose token says nothing', { email: 'a@x.com', verifiedEmail: null, emailVerified: null }, { sendAs: null, label: 'a@x.com (unverified address)' }],
    ['a live account (resolveActor), verified', { email: 'a@x.com', emailVerified: true }, { sendAs: 'a@x.com', label: 'a@x.com' }],
    ['a live account (resolveActor), unverified', { email: 'a@x.com', emailVerified: false }, { sendAs: null, label: 'a@x.com (unverified address)' }],
    ['nobody', null, { sendAs: null, label: 'A colleague' }],
  ])('%s', (_label, user, want) => expect(actingAs(user)).toEqual(want));
});

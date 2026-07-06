'use strict';
jest.mock('../../lib/settings', () => ({ getOrEnv: jest.fn() }));
// nodemailer isn't needed at import time (lazy-required); virtual-mock it so the
// suite runs without the package installed.
const mockSend = jest.fn().mockResolvedValue({ messageId: 'x' });
jest.mock('nodemailer', () => ({ createTransport: jest.fn(() => ({ sendMail: mockSend })) }), { virtual: true });

const settings = require('../../lib/settings');
const nodemailer = require('nodemailer');
const email = require('../../lib/email');

function cfg(map) { settings.getOrEnv.mockImplementation(async (k) => (k in map ? map[k] : null)); }

beforeEach(() => {
  email._resetForTests();
  settings.getOrEnv.mockReset();
  mockSend.mockClear().mockResolvedValue({ messageId: 'x' });
  nodemailer.createTransport.mockClear();
});

describe('isConfigured', () => {
  test('false when no smtp_host', async () => { cfg({}); expect(await email.isConfigured()).toBe(false); });
  test('true when smtp_host is set', async () => { cfg({ smtp_host: 'smtp.x.com' }); expect(await email.isConfigured()).toBe(true); });
});

describe('sendMail', () => {
  test('not_configured when host is blank (no send attempted)', async () => {
    cfg({});
    expect(await email.sendMail({ to: 'a@b.com', subject: 's', text: 't' })).toEqual({ sent: false, reason: 'not_configured' });
    expect(mockSend).not.toHaveBeenCalled();
  });

  test('no_recipient when "to" is empty', async () => {
    cfg({ smtp_host: 'smtp.x.com' });
    expect(await email.sendMail({ to: '', subject: 's' })).toEqual({ sent: false, reason: 'no_recipient' });
  });

  test('sends via nodemailer with auth + from when configured', async () => {
    cfg({ smtp_host: 'smtp.x.com', smtp_port: '587', smtp_user: 'u@x.com', smtp_pass: 'p', email_from: 'from@x.com' });
    const r = await email.sendMail({ to: 'a@b.com', subject: 'Hi', text: 'body' });
    expect(r).toEqual({ sent: true });
    expect(nodemailer.createTransport).toHaveBeenCalledWith(expect.objectContaining({
      host: 'smtp.x.com', port: 587, secure: false, auth: { user: 'u@x.com', pass: 'p' },
    }));
    expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({ from: 'from@x.com', to: 'a@b.com', subject: 'Hi', text: 'body' }));
  });

  test('secure defaults to true on port 465', async () => {
    cfg({ smtp_host: 'smtp.x.com', smtp_port: '465' });
    await email.sendMail({ to: 'a@b.com', subject: 's' });
    expect(nodemailer.createTransport).toHaveBeenCalledWith(expect.objectContaining({ secure: true }));
  });

  test('falls back to smtp_user as from when email_from unset', async () => {
    cfg({ smtp_host: 'smtp.x.com', smtp_user: 'u@x.com' });
    await email.sendMail({ to: 'a@b.com', subject: 's' });
    expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({ from: 'u@x.com' }));
  });

  test('rebuilds the transport when the SMTP password changes (cache-key includes pass)', async () => {
    cfg({ smtp_host: 'smtp.x.com', smtp_user: 'u@x.com', smtp_pass: 'old-pass' });
    await email.sendMail({ to: 'a@b.com', subject: 's' });
    expect(nodemailer.createTransport).toHaveBeenCalledTimes(1);
    // same everything but a rotated password → must build a fresh transport
    cfg({ smtp_host: 'smtp.x.com', smtp_user: 'u@x.com', smtp_pass: 'new-pass' });
    await email.sendMail({ to: 'a@b.com', subject: 's' });
    expect(nodemailer.createTransport).toHaveBeenCalledTimes(2);
    expect(nodemailer.createTransport).toHaveBeenLastCalledWith(expect.objectContaining({
      auth: { user: 'u@x.com', pass: 'new-pass' },
    }));
  });

  test('reuses the pooled transport when config is unchanged', async () => {
    cfg({ smtp_host: 'smtp.x.com', smtp_user: 'u@x.com', smtp_pass: 'p' });
    await email.sendMail({ to: 'a@b.com', subject: 's' });
    await email.sendMail({ to: 'c@d.com', subject: 's2' });
    expect(nodemailer.createTransport).toHaveBeenCalledTimes(1);
  });

  test('reports sent:false with reason on transport error (never throws)', async () => {
    cfg({ smtp_host: 'smtp.x.com' });
    mockSend.mockRejectedValueOnce(new Error('connection refused'));
    const r = await email.sendMail({ to: 'a@b.com', subject: 's' });
    expect(r.sent).toBe(false);
    expect(r.reason).toMatch(/connection refused/);
  });
});

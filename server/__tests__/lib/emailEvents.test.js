'use strict';
// Covers per-event email gating: defaults when unset, explicit on/off, and that
// send() only calls email.sendMail when the event is enabled.
jest.mock('../../lib/settings', () => ({ getOrEnv: jest.fn() }));
jest.mock('../../lib/email', () => ({ sendMail: jest.fn().mockResolvedValue({ sent: true, via: 'graph' }) }));

const settings = require('../../lib/settings');
const email = require('../../lib/email');
const emailEvents = require('../../lib/emailEvents');

function cfg(map) { settings.getOrEnv.mockImplementation(async (k) => (k in map ? map[k] : null)); }

beforeEach(() => { settings.getOrEnv.mockReset(); email.sendMail.mockClear().mockResolvedValue({ sent: true, via: 'graph' }); });

describe('enabled — defaults when unset', () => {
  test('share_granted / share_downloaded / upload_received default on', async () => {
    cfg({});
    expect(await emailEvents.enabled('share_granted')).toBe(true);
    expect(await emailEvents.enabled('share_downloaded')).toBe(true);
    expect(await emailEvents.enabled('upload_received')).toBe(true);
  });
  test('document_edited defaults off (noisy)', async () => {
    cfg({});
    expect(await emailEvents.enabled('document_edited')).toBe(false);
  });
  test('unknown event defaults off', async () => {
    cfg({});
    expect(await emailEvents.enabled('nope')).toBe(false);
  });
});

describe('enabled — explicit setting overrides default', () => {
  test('explicit false turns a default-on event off', async () => {
    cfg({ email_ev_share_granted: 'false' });
    expect(await emailEvents.enabled('share_granted')).toBe(false);
  });
  test('explicit true turns a default-off event on', async () => {
    cfg({ email_ev_document_edited: 'true' });
    expect(await emailEvents.enabled('document_edited')).toBe(true);
  });
});

describe('send', () => {
  test('sends when enabled', async () => {
    cfg({ email_ev_share_granted: 'true' });
    const r = await emailEvents.send('share_granted', { to: 'a@b.com', subject: 's', text: 't' });
    expect(r).toEqual({ sent: true, via: 'graph' });
    expect(email.sendMail).toHaveBeenCalledWith({ to: 'a@b.com', subject: 's', text: 't' });
  });
  test('does NOT send when disabled', async () => {
    cfg({ email_ev_document_edited: 'false' });
    const r = await emailEvents.send('document_edited', { to: 'a@b.com', subject: 's', text: 't' });
    expect(r).toEqual({ sent: false, reason: 'event_disabled' });
    expect(email.sendMail).not.toHaveBeenCalled();
  });
  test('no recipient short-circuits before checking the toggle', async () => {
    cfg({ email_ev_share_granted: 'true' });
    const r = await emailEvents.send('share_granted', { to: '' });
    expect(r).toEqual({ sent: false, reason: 'no_recipient' });
    expect(email.sendMail).not.toHaveBeenCalled();
  });
  test('never throws — reports reason on email failure', async () => {
    cfg({ email_ev_share_granted: 'true' });
    email.sendMail.mockRejectedValueOnce(new Error('smtp down'));
    const r = await emailEvents.send('share_granted', { to: 'a@b.com', subject: 's' });
    expect(r).toEqual({ sent: false, reason: 'smtp down' });
  });
});

// Notifications chapter: the shared world, with every email notice switched on so the
// "Email notifications" list in Settings shows all four kinds a person can be emailed.
'use strict';
const base = require('./base');
const baseNotifications = base.routes['GET /api/notifications'];

exports.routes = {
  'GET /api/notifications': async (ctx) => {
    const out = await (typeof baseNotifications === 'function' ? baseNotifications(ctx) : baseNotifications);
    return { ...out, email: { configured: true, events: { share_granted: true, share_opened: true, share_downloaded: true, upload_received: true, document_edited: true } } };
  },
};
exports.presence = base.presence;

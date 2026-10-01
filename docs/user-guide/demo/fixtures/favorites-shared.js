// Chapter fixture for "Favorites and files shared with you" (id favorites-shared).
// Adds the one route base.js does not have: the box a colleague sees after signing in
// to a link sent with "Only people I invite" when the sender cannot add them to the
// library outright (server/routes/files.js openSigninShare). Everything else this
// chapter needs -- favorites, Quick access, Shared with me -- is already in base.js.
'use strict';

exports.routes = {
  // GET /api/files/signin-link/:token — normally looked up from a real share row;
  // for the guide we just return the box's content directly, as if Jordan's own
  // "Newsletter - October.docx" (which he added to Priya's Marketing library, so he
  // cannot grant access to it himself) had been sent to a colleague this way.
  'GET /api/files/signin-link/:token': () => ({
    name: 'Newsletter - October.docx',
    size: 72 * 1024,
    sentBy: 'Jordan Lee',
    expiresAt: new Date(Date.now() + 30 * 86400000).toISOString(),
    downloadUrl: '#',
  }),
};

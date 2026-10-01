// Chapter fixture for "SharePoint and Windows file shares" (id connections).
//
// base.js's Office file server (U(802)) is an app-wide SMB share with no unlock step
// (delegated: false), so it cannot show the "personal share" flow this chapter needs
// to document: the one-time Unlock dialog (Domain, Username, Password) and the Lock
// button that forgets it. This file re-answers GET /api/connectors with that same
// share marked delegated: true, and adds one extra behaviour to GET /.../browse: a
// magic sentinel path that always comes back 428 SMB_CREDENTIALS_REQUIRED, the same
// shape server/routes/connectors.js uses for a locked personal share, so a shot can
// force the Unlock dialog on demand without disturbing the normal listing (path '')
// that the "Lock button already showing" shot still needs to render normally.
'use strict';
const base = require('./base');
const { world } = base;
const { CONNECTORS } = world;

const SMB_ID = CONNECTORS.find((c) => c.kind === 'smb').id;
const SP_ID = CONNECTORS.find((c) => c.kind === 'sharepoint').id;
// A path no real folder uses, so a shot can ask for it to force the locked state.
const LOCK_SENTINEL = '__force_unlock_prompt';

const MY_CONNECTORS = CONNECTORS.map((c) => (c.id === SMB_ID ? { ...c, delegated: true } : c));
const baseBrowse = base.routes['GET /api/connectors/:id/browse'];

exports.routes = {
  'GET /api/connectors': { connectors: MY_CONNECTORS },
  'GET /api/connectors/:id/browse': (ctx) => {
    if (ctx.params.id === SMB_ID && ctx.query.path === LOCK_SENTINEL) {
      return { __status: 428, body: { code: 'SMB_CREDENTIALS_REQUIRED', error: 'Sign in with your network account to open this share.' } };
    }
    return baseBrowse(ctx);
  },
  // QA: the 'browse' shot is a full top-bar screenshot, and the masthead search
  // control shows the active AI model next to "Auto" (index.html ~7940,
  // aiModelShortLabel ~8036). Override GET /api/ai/models with a made-up id so that
  // label can never show a real third-party model name, the same defensive pattern
  // already used by demo/fixtures/share-file.js and demo/fixtures/getting-around.js.
  'GET /api/ai/models': { active: 'acme:assistant', models: [{ provider: 'acme', id: 'assistant', label: 'Assistant', group: 'Assistant' }] },
  'PUT /api/ai/active': { active: 'acme:assistant' },
};

exports.SMB_ID = SMB_ID;
exports.SP_ID = SP_ID;
exports.LOCK_SENTINEL = LOCK_SENTINEL;

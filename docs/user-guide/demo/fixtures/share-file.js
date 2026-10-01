// Chapter fixture for "Sharing a file" (id share-file).
//
// base.js hardcodes the AI model as the real 'anthropic:claude-sonnet-4-6', which the top
// search bar shows as "Auto · sonnet 4 6" whenever it is visible (QA: this leaked a real
// vendor/model name into a screenshot of the fictional Acme Co workspace). None of this
// chapter's shots currently show the top bar (they clip to the file Share dialog only), but
// this override keeps any future share-file shot safe without touching base.js, which every
// other chapter also uses.
'use strict';

exports.routes = {
  'GET /api/ai/models': { active: 'acme:assistant', models: [{ provider: 'acme', id: 'assistant', label: 'Assistant', group: 'Assistant' }] },
  'PUT /api/ai/active': { active: 'acme:assistant' },
};

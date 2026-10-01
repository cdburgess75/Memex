// Chapter fixture for "Finding your way around" (id getting-around).
//
// Overrides the AI-models fixture so the masthead search control never shows a real
// third-party model name. base.js answers GET /api/ai/models with
// `active: 'anthropic:claude-sonnet-4-6'`, which the app's aiModelShortLabel()
// (index.html ~8036) turns into "sonnet 4 6" and renders in the top bar as
// "Auto · sonnet 4 6" (index.html ~7940) -- a real Anthropic/Claude model id showing
// up in a guide picture. A made-up provider and id keep the same UI (the search
// control still shows a model name next to "Auto") without naming any real product.
//
// Also overrides the shares list behind Home's "Needs attention" bar (home-stats
// shot). base.js's only link expiring within the 7-day window the app uses (index.html
// ~9372) is the "Harbor Point Dental proposal.pdf" link, so that is the one name Home
// shows there -- a client name that reads like an unvetted outside business rather
// than one of the brief's approved names. Relabelling just that entry to the
// Northfield Clinic proposal (already the guide's approved outside-client example,
// used for the link in the "my-links" chapter) keeps the same expiring-soon link,
// same dates and counts, with only the display name swapped.
'use strict';

const { world } = require('./base');
const { LINKS, linkOut, FOLDER_LINKS, folderLinkOut, F } = world;

exports.routes = {
  'GET /api/ai/models': () => ({
    active: 'demo:assistant-1',
    models: [{ provider: 'demo', id: 'assistant-1', label: 'Assistant', group: 'Assistant' }],
  }),
  'PUT /api/ai/active': ({ body }) => ({ active: body.model || 'demo:assistant-1' }),
  'GET /api/files/shares': () => ({
    scope: 'mine',
    shares: LINKS.map((l) => {
      const out = linkOut(l);
      if (l.doc === F['Harbor Point Dental proposal']) out.document_name = F['Northfield Clinic proposal'].name;
      return out;
    }),
    folder_links: FOLDER_LINKS.map(folderLinkOut),
  }),
};

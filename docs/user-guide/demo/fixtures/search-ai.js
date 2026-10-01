// Chapter fixture for "Searching and asking questions" (id search-ai).
//
// Overrides the AI-models fixture so the masthead search control never shows a real
// third-party model name. base.js answers GET /api/ai/models with
// `active: 'anthropic:claude-sonnet-4-6'`, which the app's aiModelShortLabel()
// (index.html ~8036) turns into "sonnet 4 6" and renders in the top bar as
// "Auto · sonnet 4 6" (index.html ~7940) -- visible in this chapter's search-results
// and search-scope shots, which both clip to .masthead-search. The same list also
// feeds the search-control menu's "AI model" section (aiModelMenuInnerHtml(),
// index.html ~8047), which labels an 'anthropic' provider "Claude (Anthropic)". A
// made-up provider and id keep the same UI (the control still shows a model name next
// to "Auto") without naming any real product.
'use strict';

exports.routes = {
  'GET /api/ai/models': () => ({
    active: 'demo:assistant-1',
    models: [{ provider: 'demo', id: 'assistant-1', label: 'Assistant', group: 'Assistant' }],
  }),
  'PUT /api/ai/active': ({ body }) => ({ active: body.model || 'demo:assistant-1' }),
};

// Links into the app, for emails. Each opens the exact thing after sign-in (the SPA's
// #/open/... routes) -- "Sign in to Depot to open it" with no link was a dead end.
const seg = (p) => String(p || '').split('/').filter(Boolean).map(encodeURIComponent).join('/');
const fileUrl = (base, id) => `${base}/#/open/file/${encodeURIComponent(String(id))}`;
const placeUrl = (base, libraryId, folderPath = '') => `${base}/#/open/lib/${encodeURIComponent(String(libraryId))}${folderPath ? '/' + seg(folderPath) : ''}`;
const signinLinkUrl = (base, token) => `${base}/#/open/link/${encodeURIComponent(token)}`;
module.exports = { fileUrl, placeUrl, signinLinkUrl };

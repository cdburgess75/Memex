'use strict';
// Per-request context that follows the work a request does, however deep the call stack
// goes: today, which API token (if any) is acting. Audit and activity entries read it, so
// every write made through a token says so without each route having to remember.
const { AsyncLocalStorage } = require('async_hooks');
const als = new AsyncLocalStorage();

function run(context, fn) { return als.run(context, fn); }
function current() { return als.getStore() || null; }
// '' when the request is an ordinary sign-in; otherwise ` · via token "name"`.
function tokenSuffix() {
  const t = current()?.apiToken;
  return t && t.name ? ` · via token ${JSON.stringify(String(t.name))}` : '';
}
module.exports = { run, current, tokenSuffix };

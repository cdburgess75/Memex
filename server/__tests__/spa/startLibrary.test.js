'use strict';
// "Open X when you sign in" (index.html) applies to a sign-in only. A page refresh, or a
// new tab while the session lasts, keeps the library the person was in; a deep link to a
// particular place wins over both. (It used to fire on every page load that restored a
// saved token, so a refresh always jumped back to the chosen library.)
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '../../../index.html'), 'utf8');
const fnText = (name) => {
  const start = html.search(new RegExp(`^(async )?function ${name}\\(`, 'm'));
  if (start < 0) throw new Error(`${name} not found in index.html`);
  return html.slice(start, html.indexOf('\n}\n', start) + 3);
};

const libs = [{ id: 'c', name: 'Clients' }, { id: 'p', name: 'ParaTech IT' }];
function decide({ fresh, deep = false, start, current, libraries = libs }) {
  const ctx = { _freshSignIn: fresh, _signInDeepLink: deep, startLibraryId: start, currentLibraryId: current, librariesList: libraries };
  vm.runInNewContext(`${fnText('startLibraryToOpen')}\nthis.out = startLibraryToOpen();`, ctx);
  return ctx.out;
}

describe('which library opens after _afterLogin', () => {
  test('a sign-in opens the chosen library', () => {
    expect(decide({ fresh: true, start: 'c', current: 'p' })).toBe('c');
    expect(decide({ fresh: true, start: 'c', current: null })).toBe('c');
  });
  test('a refresh keeps the library the person was in', () => {
    expect(decide({ fresh: false, start: 'c', current: 'p' })).toBeNull();
    expect(decide({ fresh: false, start: 'c', current: null })).toBeNull();
  });
  test('a deep link wins over the choice, and nothing happens without a choice', () => {
    expect(decide({ fresh: true, deep: true, start: 'c', current: 'p' })).toBeNull();
    expect(decide({ fresh: true, start: null, current: 'p' })).toBeNull();
  });
  test('already there, or a library the person can no longer see: nothing to do', () => {
    expect(decide({ fresh: true, start: 'c', current: 'c' })).toBeNull();
    expect(decide({ fresh: true, start: 'gone', current: 'p' })).toBeNull();
    expect(decide({ fresh: true, start: 7, current: 'p', libraries: [{ id: 7, name: 'Seven' }] })).toBe('7');
  });
});

describe('the wiring', () => {
  test('a page load counts as a sign-in only when it came back from Keycloak with a code', () => {
    expect(html).toContain("let _freshSignIn = false;");
    expect(fnText('initApp')).toMatch(/if \(urlParams\.has\('code'\)\) \{\n\s*_freshSignIn = true;\n\s*await handleOAuthCallback\(/);
    expect(fnText('initApp')).not.toMatch(/_freshSignIn = true;[\s\S]*_hasValidToken\(\)\) \{\n\s*_freshSignIn/);
  });
  test('_afterLogin asks startLibraryToOpen instead of deciding on its own', () => {
    const after = fnText('_afterLogin');
    expect(after).toContain('const openAtSignIn = startLibraryToOpen();');
    expect(after).toContain('if (openAtSignIn) {');
    expect(after).not.toMatch(/if \(!_signInDeepLink && startLibraryId/);
  });
  test('the menu still names the choice as a sign-in choice', () => {
    expect(fnText('libraryMenuActionsHtml')).toContain('<span>Open at sign-in</span>');
    expect(html).toContain("'Sign-in will open the library you used last'");
  });
});

'use strict';
// The installer is documented as `curl -fsSL …/install.sh | bash`, which hands bash
// the SCRIPT ITSELF on stdin. Anything inside it that reads stdin therefore eats the
// rest of the script: bash reaches EOF and exits 0, having silently skipped every
// remaining line. It happened -- `docker compose exec -T` swallowed the seed-admin
// password reset and the entire closing banner, so a public install sat on the realm's
// well-known bootstrap password and never said so.
//
// Nothing in install.sh legitimately reads stdin (prompts come from /dev/tty), so the
// rule is simply: every exec redirects stdin from /dev/null.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '../../..');
const install = fs.readFileSync(path.join(root, 'install.sh'), 'utf8');

// From an `exec` to the end of the shell statement that contains it: either the `; then`
// that closes an `if`, or a line that isn't a continuation of the quoted command.
function statementAt(text, from) {
  const end = text.indexOf('; then', from);
  return text.slice(from, end === -1 ? Math.min(text.length, from + 2000) : end + 6);
}

describe('install.sh survives being piped to bash', () => {
  const execs = [...install.matchAll(/\$COMPOSE exec\b/g)].map(m => m.index);

  test('there are execs to check (the rule has something to protect)', () => {
    expect(execs.length).toBeGreaterThan(0);
  });

  test('every docker compose exec redirects stdin away from the script', () => {
    const leaky = execs
      .map(i => statementAt(install, i))
      .filter(stmt => !/<\s*\/dev\/null/.test(stmt));
    // Name the offenders rather than just counting them.
    expect(leaky.map(s => s.split('\n')[0].trim())).toEqual([]);
  });

  test('the closing banner the user depends on is still there to reach', () => {
    expect(install).toMatch(/First login/);
    expect(install).toMatch(/admin@memex\.local/);
  });
});

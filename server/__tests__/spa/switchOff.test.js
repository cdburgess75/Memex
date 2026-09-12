'use strict';
// What the app offers for somebody who is leaving, and for a library that outlives them.
//
// The endpoints for all of this existed before the app did anything with them, so these
// read index.html and check the call sites: that the Team list offers the switch and says
// who is already off, that switching somebody off shows what it would stop BEFORE asking,
// and that handing a library on is only ever offered as the deliberate thing it is.
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '../../../index.html'), 'utf8');

// The whole of `function name(...) { ... }`, skipping the parameter list first so a
// destructured parameter's brace is not mistaken for the body's.
const fn = (name) => {
  const start = html.search(new RegExp(`(async )?function ${name}\\(`));
  if (start < 0) throw new Error(`${name} not found in index.html`);
  let i = html.indexOf('(', start);
  for (let depth = 0; i < html.length; i++) {
    if (html[i] === '(') depth++;
    else if (html[i] === ')' && --depth === 0) { i++; break; }
  }
  let depth = 0;
  for (let j = html.indexOf('{', i); j < html.length; j++) {
    if (html[j] === '{') depth++;
    else if (html[j] === '}' && --depth === 0) return html.slice(start, j + 1);
  }
  throw new Error(`unbalanced ${name}`);
};

describe('switching somebody off', () => {
  const confirm = fn('confirmSwitchOff');

  test('what it would stop is fetched and shown BEFORE the question is asked', () => {
    const askAt = confirm.indexOf('askConfirm');
    const fetchAt = confirm.indexOf("/departure");
    expect(fetchAt).toBeGreaterThan(-1);
    expect(fetchAt).toBeLessThan(askAt);
    expect(confirm).toMatch(/detailLines: lines/);
  });

  test('it names what nobody else can pick up, and what stops at once', () => {
    expect(confirm).toMatch(/nobody else can manage/);
    expect(confirm).toMatch(/Hand (it|them)|hand /i);
    expect(confirm).toMatch(/stop working straight away/);
    expect(confirm).toMatch(/their own library/i);
    expect(confirm).toMatch(/switch them back on/i);
  });

  test('a report that cannot be fetched never blocks the decision', () => {
    expect(confirm).toMatch(/catch \{ \/\* the list is a courtesy \*\/ \}/);
    expect(confirm).toMatch(/if \(!lines\.length\)/);
  });

  test('the reason is optional and kept with the record', () => {
    expect(confirm).toMatch(/askPrompt\('Why\?/);
    expect(confirm).toMatch(/reason: reason \|\| undefined/);
  });

  test('the Team list says who is off, and offers the switch only to somebody else', () => {
    // the row builder is inside renderAdmin's template, so read the file around it
    expect(html).toMatch(/Switched off<\/span>/);
    expect(html).toMatch(/String\(u\.user_id\) === String\(currentUser\?\.id\)/);
    // the address and id reach the handler through data-* attributes, never spliced into
    // its JS string -- esc() protects an attribute, not a string literal inside one
    expect(html).toMatch(/onclick="confirmSwitchOff\(this\.dataset\.uid, this\.dataset\.email\)"/);
    expect(html).toMatch(/onclick="switchBackOn\(this\.dataset\.uid, this\.dataset\.email\)"/);
    // somebody switched off cannot have their role changed from the list either
    expect(html).toMatch(/\$\{off \? 'disabled ' : ''\}onchange="updateUserRole/);
  });

  test('switching back on says what does and does not come back', () => {
    const back = fn('switchBackOn');
    expect(back).toMatch(/comes back with them/);
    expect(back).toMatch(/stays where you put it/);
  });
});

describe('a library that outlives somebody', () => {
  test('an archived library says so wherever it is listed', () => {
    expect(fn('libraryMenuRow')).toMatch(/l\.archived_at/);
    expect(fn('libraryMenuRow')).toMatch(/Archived<\/span>/);
  });

  test('putting one away explains what it means, and is an admin\'s to do', () => {
    const set = fn('setLibraryArchived');
    expect(set).toMatch(/nothing can be added to it, by anybody/);
    expect(set).toMatch(/bring it back at any time/i);
    expect(html).toMatch(/onclick="closeLibraryMenu\(\);setLibraryArchived\(this\.dataset\.lib, !!this\.dataset\.away\)"/);
  });

  test('renaming exists at all now, and is offered to whoever manages it', () => {
    expect(fn('renameLibrary')).toMatch(/apiPatch\('\/libraries\//);
    expect(html).toMatch(/onclick="closeLibraryMenu\(\);renameLibrary\(this\.dataset\.lib\)"/);
  });

  test('handing one on is the deliberate thing, and says who has it now', () => {
    const re = fn('reassignLibrary');
    expect(re).toMatch(/\/reassign/);
    expect(re).toMatch(/now belongs to/);
    // the comment above it is the rule: only ever for somebody switched off
    expect(html).toMatch(/only ever offered for somebody who has been switched off/);
  });
});

// The rule this file exists to keep, stated once for the whole app rather than per button:
// esc()/escAttr() make a value safe as HTML text or as an attribute. They do NOT make it
// safe inside a JS string that is itself inside an attribute -- an address with a quote in
// it closes the string, and whatever follows runs. Dynamic handler arguments come from
// data-* instead (CLAUDE.md, Escaping).
//
// Eight handlers written before this rule was enforced still splice an escaped value:
// joinScheduledMeeting, attestControl (x2), connTest, connEdit, connDelete, connNew and
// switchAiModel. They are a known backlog, not a licence -- this test fails on a NINTH, so
// the class cannot grow while the old ones wait their turn.
const KNOWN_SPLICED = 8;

describe('no NEW inline handler carries a spliced-in argument', () => {
  const spliced = [...html.matchAll(/\son(?:click|change|input|submit)="([^"]*)"/g)]
    .map(m => m[1])
    .filter(h => /\w+\([^)]*\$\{/.test(h));

  test('the dangerous shape -- an escaped value inside a handler\'s JS string -- has not grown', () => {
    const escaped = spliced.filter(h => /\$\{esc\(|\$\{escAttr\(/.test(h));
    expect(escaped.length).toBeLessThanOrEqual(KNOWN_SPLICED);
  });

  test('nothing this work added splices at all', () => {
    for (const name of ['confirmSwitchOff', 'switchBackOn', 'renameLibrary', 'setLibraryArchived', 'reassignLibrary']) {
      expect(spliced.filter(h => h.includes(name))).toEqual([]);
    }
  });
});

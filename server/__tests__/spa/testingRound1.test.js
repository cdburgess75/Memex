'use strict';
// From the first round of hands-on testing: "tell me when people come online" must not cry
// wolf, the old System tab's sections must all still be reachable after it was split, and a
// shared screen must never be cropped like a face.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const html = fs.readFileSync(path.join(__dirname, '../../../index.html'), 'utf8');
const block = (name) => { const s = html.search(new RegExp(`\\n(?:async )?function ${name}\\(`)); let d = 0; const i = html.indexOf('{', s); for (let j = i; ; j++) { if (html[j] === '{') d++; else if (html[j] === '}' && --d === 0) return html.slice(s, j + 1); } };

describe('someone comes online', () => {
  const run = (steps, { on = true, inCall = false } = {}) => {
    const toasts = []; let t = 1e9;
    const ctx = { toast: (m) => toasts.push(m), localStorage: { getItem: () => (on ? null : '0') }, Date: { now: () => t }, Map, Set, String };
    vm.runInNewContext(`let presenceBaseline = false; const presenceLeftAt = new Map(); const PRESENCE_QUIET_MS = 180000; let callRoom = ${inCall ? "'r'" : 'null'};
      const notifyOnlineOn = () => { try { return localStorage.getItem('memex_notify_online') !== '0'; } catch { return true; } };
      ${block('announceArrivals')}; this.go = announceArrivals; this.reset = () => { presenceBaseline = false; };`, ctx);
    let before = [];
    for (const s of steps) { if (s.wait) { t += s.wait; continue; } if (s.reconnect) { ctx.reset(); continue; } ctx.go(before, s); before = s; }
    return toasts;
  };
  const amy = { userId: 'a', name: 'Amy Tran' }, sam = { userId: 's', name: 'Sam Ortiz' }, lee = { userId: 'l', name: 'Lee' };
  test('the people already here when you connect are not announced', () => expect(run([[amy, sam]])).toEqual([]));
  test('an arrival is', () => expect(run([[amy], [amy, sam]])).toEqual(['Sam Ortiz is online']));
  test('several at once are one message', () => expect(run([[], [amy, sam, lee]])).toEqual(['Amy Tran and 2 others are online']));
  test('a connection that blinks is not an arrival; a real return later is', () => {
    expect(run([[amy], [], { wait: 20000 }, [amy]])).toEqual([]);
    expect(run([[amy], [], { wait: 600000 }, [amy]])).toEqual(['Amy Tran is online']);
  });
  test('reconnecting yourself announces nobody', () => expect(run([[amy], { reconnect: true }, [amy, sam]])).toEqual([]));
  test('off means off, and never over a call', () => {
    expect(run([[], [amy]], { on: false })).toEqual([]);
    expect(run([[], [amy]], { inCall: true })).toEqual([]);
  });
  test('it is on unless turned off, and the switch is in Settings', () => {
    expect(html).toContain(`localStorage.getItem('memex_notify_online') !== '0'`);
    expect(block('notificationsSettingsHtml')).toContain('id="notify-online-toggle"');
  });
});

describe('Settings: the old System tab, split', () => {
  const sys = block('systemSettingsHtml');
  const titles = [...sys.matchAll(/<div class="settings-sub"[^>]*>([^<]+)</g)].map(m => m[1].trim());
  const sw = block('switchSettingsTab');
  const named = sw.split('\n').filter(l => l.includes('systemSections(')).flatMap(l => [...l.slice(l.indexOf('systemSections(')).matchAll(/'([^']+)'/g)].map(x => x[1]));
  test('every section it had is on exactly one of the new pages', () => expect([...named].sort()).toEqual([...titles].sort()));
  test('every page in the side menu has a branch that draws it', () => {
    const ids = [...block('settingsTabsList').matchAll(/id: '([a-z]+)'/g)].map(m => m[1]);
    for (const id of ids) expect(sw).toContain(`tab === '${id}'`);
    expect(ids).not.toContain('system');
  });
  test("anything still asking for 'system' lands somewhere", () => expect(sw).toMatch(/if \(tab === 'system'\) tab = 'workspace'/));
});

describe('calls', () => {
  test('a shared screen is shown whole, never cropped to fill', () => {
    expect(html).toMatch(/\.call-tile\.screen video \{ object-fit: contain/);
    expect(html).toMatch(/\.call-stage \.call-tile video \{ object-fit: contain/);
  });
  test('the sharer tells everyone, including someone who joins later', () => {
    expect(block('tellPeersScreen')).toContain(`t: 'screen'`);
    expect(block('setupDataChannel')).toMatch(/addEventListener\('open'[\s\S]*t: 'screen', on: true/);
  });
  test('nothing sets the grid columns inline any more (it defeated every layout)', () => expect(html).not.toContain('gridTemplateColumns'));
});

describe('the text editor', () => {
  test('a file too big to show whole cannot be saved over', () => {
    expect(html).toMatch(/canEdit: canEdit && !tooBig && !failed/);
    expect(block('saveFileText')).toContain('ta.readOnly');
  });
});

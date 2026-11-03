'use strict';
// The detectors in lib/sensitiveData.js, on their own: what counts as a card number, a
// Social Security number, a routing or account number, and what does not (phone numbers,
// dates, invoice and order numbers, placeholders). Every number here is made up at run
// time: a card number is a prefix with its Luhn check digit worked out, a routing number
// a prefix with its ABA check digit worked out. Nothing in this file is anyone's number.
jest.mock('../../lib/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null) }));
jest.mock('../../lib/settings', () => ({ getOrEnv: jest.fn(async () => null), get: jest.fn(async () => null), set: jest.fn(async () => {}) }));
const sd = require('../../lib/sensitiveData');

// A card number: the prefix, padded with 1s, plus the digit that makes Luhn hold.
function card(prefix, length) {
  const body = (prefix + '1'.repeat(length)).slice(0, length - 1);
  for (let d = 0; d <= 9; d++) if (sd.luhn(body + d)) return body + d;
  throw new Error('no check digit');
}
// A routing number: eight digits plus the digit that makes the ABA checksum hold.
function routing(eight) {
  for (let d = 0; d <= 9; d++) if (sd.abaValid(eight + d)) return eight + d;
  throw new Error('no check digit');
}
const group = (digits, sep = ' ') => digits.replace(/(\d{4})(?=\d)/g, `$1${sep}`);
const types = (text, opts) => sd.detect(text, opts).map(f => f.type);

describe('Luhn', () => {
  test('holds for a made number and fails when one digit is off', () => {
    const n = card('4', 16);
    expect(sd.luhn(n)).toBe(true);
    const bumped = n.slice(0, 7) + ((Number(n[7]) + 1) % 10) + n.slice(8);
    expect(sd.luhn(bumped)).toBe(false);
  });
});

describe('card numbers', () => {
  test('each brand, by issuer range and length', () => {
    expect(sd.cardBrand(card('4', 16))).toBe('Visa');
    expect(sd.cardBrand(card('4', 13))).toBe('Visa');
    expect(sd.cardBrand(card('5', 16).replace(/^5./, '52'))).toBeTruthy();
    expect(sd.cardBrand(card('2221', 16))).toBe('Mastercard');
    expect(sd.cardBrand(card('37', 15))).toBe('American Express');
    expect(sd.cardBrand(card('6011', 16))).toBe('Discover');
    expect(sd.cardBrand(card('36', 14))).toBe('Diners Club');
    expect(sd.cardBrand(card('3530', 16))).toBe('JCB');
  });
  test('a 16-digit number in a known range that passes Luhn is a card, with spaces, dashes or neither', () => {
    const n = card('4', 16);
    for (const text of [n, group(n), group(n, '-'), `Card: ${group(n)}\n`]) {
      const [f] = sd.detect(text);
      expect(f).toEqual({ type: 'card', count: 1, sample: `•••• ${n.slice(-4)}` });
    }
  });
  test('the sample is masked to the last four and the count is the number of hits', () => {
    const a = card('4', 16), b = card('5', 16);
    const [f] = sd.detect(`first ${a} then ${group(b)} and ${a} again`);
    expect(f.count).toBe(3);
    expect(f.sample).toBe(`•••• ${a.slice(-4)}`);
    expect(f.sample).not.toContain(a.slice(0, 6));
  });
  test('a 15-digit Amex and a 19-digit Visa count; a 12-digit number does not', () => {
    expect(types(card('34', 15))).toEqual(['card']);
    expect(types(card('4', 19))).toEqual(['card']);
    expect(types(card('4', 12))).toEqual([]);
  });
  test('a number that fails Luhn is not a card, however card-like', () => {
    const n = card('4', 16);
    const bad = n.slice(0, 15) + ((Number(n[15]) + 1) % 10);
    expect(types(group(bad))).toEqual([]);
  });
  test('a number outside every issuer range is not a card, even when Luhn holds', () => {
    expect(types(card('1', 16))).toEqual([]);   // no brand starts with 1
    expect(types(card('9', 16))).toEqual([]);
    expect(types(card('7', 16))).toEqual([]);
  });
  test('a card number inside a longer run of digits is not a card (a document id, a barcode)', () => {
    const n = card('4', 16);
    expect(types(`ref 12${n}98`)).toEqual([]);
    expect(types(`${n}0`)).toEqual([]);
  });
  test('placeholders and the everyday numbers of an office are not cards', () => {
    expect(types('0000 0000 0000 0000')).toEqual([]);
    expect(types('Call (985) 555-0142 or 985-555-0199.')).toEqual([]);
    expect(types('Dated 2026-11-03 and 11/03/2026, due 12-31-2026.')).toEqual([]);
    expect(types('Invoice INV-2026-000417, PO 4500123456, order 1234567890123.')).toEqual([]);
    expect(types('Fax 1-800-555-0100 ext 4411, tracking 1Z999AA10123456784.')).toEqual([]);
    expect(types('EIN 72-1234567, Louisiana license 1234567-001, zip 70433-1234.')).toEqual([]);
  });
});

describe('Social Security numbers', () => {
  test('with dashes or spaces, under the SSA rules', () => {
    expect(sd.detect('SSN 212-34-5678')).toEqual([{ type: 'ssn', count: 1, sample: '•••-••-5678' }]);
    expect(types('212 34 5678')).toEqual(['ssn']);
    expect(types('212-34-5678')).toEqual(['ssn']);
  });
  test('an area of 000, 666 or 900 and up, a group of 00, a serial of 0000: never issued', () => {
    for (const n of ['000-12-3456', '666-12-3456', '900-12-3456', '987-65-4320', '212-00-3456', '212-34-0000']) expect(types(n)).toEqual([]);
  });
  test('the two numbers the SSA retired are never anyone\'s', () => {
    expect(types('078-05-1120')).toEqual([]);
    expect(types('219-09-9999')).toEqual([]);
  });
  test('mixed separators do not make a number', () => {
    expect(types('212-34 5678')).toEqual([]);
  });
  test('bare nine digits count only when the words before say what they are', () => {
    expect(types('212345678')).toEqual([]);
    expect(types('Social Security number: 212345678')).toEqual(['ssn']);
    expect(types('SSN: 212345678')).toEqual(['ssn']);
    expect(types('SS# 212345678')).toEqual(['ssn']);
    expect(types('Taxpayer ID 212345678')).toEqual(['ssn']);
  });
  test('a phone number, a date and a nine-digit order number are not Social Security numbers', () => {
    expect(types('985-555-0142')).toEqual([]);   // an area of 985 is never issued
    expect(types('2026-11-03')).toEqual([]);
    expect(types('order 123456789 shipped')).toEqual([]);
    expect(types('part 212-34-56789')).toEqual([]);
  });
  test('the count is the number of distinct hits in the text', () => {
    const [f] = sd.detect('Client A 212-34-5678, spouse 213-45-6789, dependent 214 56 7890.');
    expect(f).toMatchObject({ type: 'ssn', count: 3 });
  });
});

describe('bank routing and account numbers', () => {
  const rt = routing('06510000'.slice(0, 8));
  test('ABA checksum holds for a made number and fails one digit off', () => {
    expect(sd.abaValid(rt)).toBe(true);
    expect(sd.abaValid(rt.slice(0, 8) + ((Number(rt[8]) + 1) % 10))).toBe(false);
  });
  test('a prefix the Federal Reserve never assigned is not a routing number', () => {
    for (const eight of ['13000000', '50000000', '99000000']) expect([...Array(10).keys()].some(d => sd.abaValid(eight + d))).toBe(false);
  });
  test('a routing number needs the word routing, ABA or transit nearby', () => {
    expect(sd.detect(`Routing number ${rt}`, { types: ['bank'] })).toEqual([{ type: 'bank', count: 1, sample: `•••• ${rt.slice(-4)}` }]);
    expect(types(`ABA: ${rt}`, { types: ['bank'] })).toEqual(['bank']);
    expect(types(`${rt} (routing)`, { types: ['bank'] })).toEqual(['bank']);
    expect(types(`reference ${rt}`, { types: ['bank'] })).toEqual([]);
  });
  test('an account number needs the words account number (or acct, account no., account #) right before it', () => {
    expect(types('Account number: 1234567890', { types: ['bank'] })).toEqual(['bank']);
    expect(types('Acct # 00123-456-789', { types: ['bank'] })).toEqual(['bank']);
    expect(types('account no. 98765432', { types: ['bank'] })).toEqual(['bank']);
    expect(types('Account 12345', { types: ['bank'] })).toEqual([]);        // too short
    expect(types('balance 1234567890', { types: ['bank'] })).toEqual([]);   // no context
    expect(types('Account number: 000000000', { types: ['bank'] })).toEqual([]);
  });
  test('a routing number is not a Social Security number, and is not found when only cards and SSNs are asked for', () => {
    const text = `Routing ${rt} account number 123456789012`;
    expect(types(text, { types: ['card', 'ssn'] })).toEqual([]);
    expect(types(text)).toEqual(['bank']);
  });
});

describe('detect', () => {
  test('searches only the types asked for', () => {
    const text = `${card('4', 16)} and 212-34-5678`;
    expect(types(text, { types: ['card'] })).toEqual(['card']);
    expect(types(text, { types: ['ssn'] })).toEqual(['ssn']);
    expect(types(text, { types: ['card', 'ssn'] })).toEqual(['card', 'ssn']);
  });
  test('reads at most maxChars of the text', () => {
    const n = card('4', 16);
    expect(types('x'.repeat(100) + n, { maxChars: 50 })).toEqual([]);
    expect(types('x'.repeat(100) + n, { maxChars: 200 })).toEqual(['card']);
  });
  test('empty, null and non-string text give nothing', () => {
    expect(sd.detect('')).toEqual([]);
    expect(sd.detect(null)).toEqual([]);
    expect(sd.detect(undefined)).toEqual([]);
  });
  test('never returns a whole number', () => {
    const n = card('4', 16);
    const out = JSON.stringify(sd.detect(`${n} 212-34-5678 Routing ${routing('02100000')}`));
    expect(out).not.toContain(n);
    expect(out).not.toContain('212-34');
    expect(out).not.toContain('212345678');
  });
});

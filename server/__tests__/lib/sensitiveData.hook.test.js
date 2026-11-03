// The fire-and-forget hook must stay quiet under Jest: no scan unless a suite opts in,
// and a schema without the findings table is not worth a console line.
jest.mock('../../lib/db', () => ({ query: jest.fn(), queryOne: jest.fn(), withTransaction: jest.fn() }));

const db = require('../../lib/db');
const sd = require('../../lib/sensitiveData');

describe('sensitiveData.check under test', () => {
  beforeEach(() => { sd._resetForTests(); jest.clearAllMocks(); });

  test('does nothing unless the suite opts in', async () => {
    sd.check('00000000-0000-0000-0000-000000000001', 'text');
    await sd.idle();
    expect(db.queryOne).not.toHaveBeenCalled();
    expect(db.query).not.toHaveBeenCalled();
  });

  test('runs once opted in, and a missing findings table is swallowed without logging', async () => {
    const err = Object.assign(new Error('relation "document_findings" does not exist'), { code: '42P01' });
    db.queryOne.mockRejectedValue(err);
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    sd.enableForTests();
    sd.check('00000000-0000-0000-0000-000000000001', 'text');
    await sd.idle();
    expect(db.queryOne).toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  test('other failures are still reported, once, and never thrown', async () => {
    db.queryOne.mockRejectedValue(new Error('connection refused'));
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    sd.enableForTests();
    sd.check('00000000-0000-0000-0000-000000000001', 'text');
    await sd.idle();
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});

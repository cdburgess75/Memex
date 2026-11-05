'use strict';
// The retention and legal-hold endpoints: who may set a library's policy, who may place
// and release a hold, and that the lists reach the app with the shapes it draws.
const request = require('supertest');
const express = require('express');

const LIB = 'aaaaaaaa-0000-4000-8000-000000000001';
const HOLD = 'cccccccc-0000-4000-8000-000000000003';
const ADMIN = { id: '11111111-1111-4111-8111-111111111111', email: 'admin@x.com', role: 'admin' };
const OWNER = { id: '22222222-2222-4222-8222-222222222222', email: 'owner@x.com', role: 'contributor' };
const VIEWER = { id: '33333333-3333-4333-8333-333333333333', email: 'viewer@x.com', role: 'viewer' };

const mockState = { user: ADMIN, visible: null };
jest.mock('../../lib/db', () => ({ query: jest.fn(async () => []), queryOne: jest.fn(async () => null), withTransaction: jest.fn() }));
jest.mock('../../lib/settings', () => ({ getOrEnv: jest.fn(async () => null), get: jest.fn(async () => null), set: jest.fn(), refresh: jest.fn() }));
jest.mock('../../lib/libraries', () => ({ ...jest.requireActual('../../lib/libraries'), visibleLibrary: jest.fn(async () => mockState.visible) }));
jest.mock('../../lib/retention', () => ({
  getPolicy: jest.fn(async () => ({ library_id: 'L', min_years: 3, dispose_years: null })),
  setPolicy: jest.fn(async (id, body) => ({ library_id: id, min_years: Number(body.min_years) || null, dispose_years: null })),
  activeHolds: jest.fn(async () => [{ id: 'h1', scope: 'folder', folder_path: 'Clients/Smith', reason: 'r' }]),
  holdHistory: jest.fn(async () => []),
  placeHold: jest.fn(async (body, user) => ({ id: 'h2', ...body, placed_by: user.email, active: true })),
  releaseHold: jest.fn(async (id, note, user) => ({ id, release_note: note, released_by: user.email, active: false })),
}));
jest.mock('../../lib/auditLog', () => ({ append: jest.fn(async () => ({})) }));
jest.mock('../../lib/notifications', () => ({ create: jest.fn(async () => ({})) }));
jest.mock('../../lib/emailEvents', () => ({ send: jest.fn(async () => ({})) }));
jest.mock('../../middleware/auth', () => (req, res, next) => { req.user = { ...mockState.user }; next(); });

const retention = require('../../lib/retention');
const app = () => {
  const a = express(); a.use(express.json());
  a.use('/api/libraries', require('../../routes/libraries'));
  a.use('/api/admin', require('../../routes/admin'));
  return a;
};

beforeEach(() => { jest.clearAllMocks(); mockState.user = ADMIN; mockState.visible = { id: LIB, name: 'Clients', can_manage: true, owner_id: OWNER.id }; });

describe('a library\'s retention policy', () => {
  test('anyone who can see the library may read it', async () => {
    mockState.user = VIEWER; mockState.visible = { id: LIB, name: 'Clients', can_manage: false };
    const r = await request(app()).get(`/api/libraries/${LIB}/retention`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ library_id: 'L', min_years: 3, dispose_years: null });
  });
  test('the owner or an admin sets it; a reader of the library is refused', async () => {
    mockState.user = OWNER;
    let r = await request(app()).put(`/api/libraries/${LIB}/retention`).send({ min_years: 3, dispose_years: '' });
    expect(r.status).toBe(200);
    expect(retention.setPolicy).toHaveBeenCalledWith(LIB, { min_years: 3, dispose_years: '' }, expect.objectContaining({ email: OWNER.email }));
    mockState.visible = { id: LIB, name: 'Clients', can_manage: false };
    r = await request(app()).put(`/api/libraries/${LIB}/retention`).send({ min_years: 3 });
    expect(r.status).toBe(403);
    expect(retention.setPolicy).toHaveBeenCalledTimes(1);
    mockState.user = VIEWER;
    expect((await request(app()).put(`/api/libraries/${LIB}/retention`).send({ min_years: 3 })).status).toBe(403);
  });
  test('a library the caller cannot see is 404; a bad value is 400 with the sentence', async () => {
    mockState.visible = null;
    expect((await request(app()).put(`/api/libraries/${LIB}/retention`).send({ min_years: 3 })).status).toBe(404);
    mockState.visible = { id: LIB, name: 'Clients', can_manage: true };
    retention.setPolicy.mockRejectedValueOnce(Object.assign(new Error('Keep at least must be a whole number of years from 1 to 100, or left blank'), { status: 400 }));
    const r = await request(app()).put(`/api/libraries/${LIB}/retention`).send({ min_years: 0 });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/whole number of years/);
  });
  test('the open holds in a library, for the lock marks', async () => {
    const r = await request(app()).get(`/api/libraries/${LIB}/holds`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual([{ id: 'h1', scope: 'folder', folder_path: 'Clients/Smith', reason: 'r' }]);
    expect(retention.activeHolds).toHaveBeenCalledWith({ libraryId: LIB });
  });
});

describe('legal holds are an administrator\'s', () => {
  test('list, place, release', async () => {
    let r = await request(app()).get('/api/admin/legal-holds');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ active: [{ id: 'h1', scope: 'folder', folder_path: 'Clients/Smith', reason: 'r' }], released: [] });
    r = await request(app()).post('/api/admin/legal-holds').send({ scope: 'library', library_id: LIB, reason: 'audit' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: 'h2', scope: 'library', placed_by: ADMIN.email, active: true });
    r = await request(app()).delete(`/api/admin/legal-holds/${HOLD}`).send({ note: 'closed' });
    expect(r.status).toBe(200);
    expect(retention.releaseHold).toHaveBeenCalledWith(HOLD, 'closed', expect.objectContaining({ email: ADMIN.email }));
  });
  test('a contributor, even the library\'s owner, is refused', async () => {
    mockState.user = OWNER;
    expect((await request(app()).get('/api/admin/legal-holds')).status).toBe(403);
    expect((await request(app()).post('/api/admin/legal-holds').send({ scope: 'library', library_id: LIB, reason: 'x' })).status).toBe(403);
    expect((await request(app()).delete(`/api/admin/legal-holds/${HOLD}`).send({ note: 'x' })).status).toBe(403);
    expect(retention.placeHold).not.toHaveBeenCalled();
  });
  test('the library\'s own refusals come through with their status', async () => {
    retention.placeHold.mockRejectedValueOnce(Object.assign(new Error('A hold needs a reason'), { status: 400 }));
    expect((await request(app()).post('/api/admin/legal-holds').send({ scope: 'library', library_id: LIB })).status).toBe(400);
    retention.releaseHold.mockRejectedValueOnce(Object.assign(new Error('Hold not found, or already released'), { status: 404 }));
    expect((await request(app()).delete(`/api/admin/legal-holds/${HOLD}`).send({ note: 'x' })).status).toBe(404);
  });
});

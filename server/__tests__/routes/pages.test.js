'use strict';
const request = require('supertest');
const express = require('express');

jest.mock('../../lib/db');
const db = require('../../lib/db');

let mockUser = { id: 'u1', email: 'admin@test.com', role: 'admin' };
jest.mock('../../middleware/auth', () => (req, _res, next) => {
  req.user = mockUser;
  next();
});

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/pages', require('../../routes/pages'));
  return app;
}

const PAGE = {
  id: 'test-page',
  title: 'Test Page',
  category: 'concept',
  content: '# Test Page\n\nSome content.',
  sources: 1,
  created_by: 'u1',
  updated_by: 'u1',
  updated_at: new Date().toISOString(),
};

describe('GET /api/pages', () => {
  test('returns array of pages', async () => {
    db.query.mockResolvedValue([PAGE]);
    const res = await request(makeApp()).get('/api/pages');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([PAGE]);
  });

  test('returns empty array when no pages exist', async () => {
    db.query.mockResolvedValue([]);
    const res = await request(makeApp()).get('/api/pages');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  test('returns 500 on DB error', async () => {
    db.query.mockRejectedValue(new Error('DB connection failed'));
    const res = await request(makeApp()).get('/api/pages');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('DB connection failed');
  });
});

describe('GET /api/pages/search', () => {
  test('returns empty array for blank query', async () => {
    const res = await request(makeApp()).get('/api/pages/search?q=');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
    expect(db.query).not.toHaveBeenCalled();
  });

  test('returns search results for non-blank query', async () => {
    db.query.mockResolvedValue([PAGE]);
    const res = await request(makeApp()).get('/api/pages/search?q=test');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([PAGE]);
    expect(db.query).toHaveBeenCalledWith('SELECT * FROM search_pages($1)', ['test']);
  });
});

describe('PUT /api/pages/:id', () => {
  const body = { title: 'Test Page', category: 'concept', content: '# Test', sources: 1 };

  test('creates a new page when id does not exist', async () => {
    db.queryOne
      .mockResolvedValueOnce(null)   // no existing page
      .mockResolvedValueOnce(PAGE);  // INSERT result
    const res = await request(makeApp()).put('/api/pages/test-page').send(body);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('test-page');
  });

  test('snapshots old version and updates existing page', async () => {
    db.queryOne
      .mockResolvedValueOnce(PAGE)     // existing page found
      .mockResolvedValueOnce(PAGE);    // UPDATE result
    db.query.mockResolvedValue([]);    // page_versions INSERT
    const res = await request(makeApp()).put('/api/pages/test-page').send(body);
    expect(res.status).toBe(200);
    // Version snapshot INSERT should have been called
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO page_versions'),
      expect.any(Array)
    );
  });

  test('returns 400 for invalid page ID format', async () => {
    const res = await request(makeApp()).put('/api/pages/INVALID_ID').send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid page ID/);
  });

  test('returns 403 when contributor tries to create page (contributor role check)', async () => {
    mockUser = { id: 'u2', email: 'viewer@test.com', role: 'viewer' };
    const res = await request(makeApp()).put('/api/pages/test-page').send(body);
    expect(res.status).toBe(403);
    mockUser = { id: 'u1', email: 'admin@test.com', role: 'admin' };
  });
});

describe('DELETE /api/pages/:id', () => {
  test('admin can delete a page', async () => {
    db.query.mockResolvedValue([]);
    const res = await request(makeApp()).delete('/api/pages/test-page');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(db.query).toHaveBeenCalledWith('DELETE FROM pages WHERE id = $1', ['test-page']);
  });

  test('non-admin gets 403', async () => {
    mockUser = { id: 'u2', email: 'user@test.com', role: 'contributor' };
    const res = await request(makeApp()).delete('/api/pages/test-page');
    expect(res.status).toBe(403);
    mockUser = { id: 'u1', email: 'admin@test.com', role: 'admin' };
  });
});

describe('GET /api/pages/:id/versions', () => {
  test('returns version history for a page', async () => {
    const versions = [{ id: 'v1', page_id: 'test-page', title: 'Test Page', saved_at: new Date().toISOString() }];
    db.query.mockResolvedValue(versions);
    const res = await request(makeApp()).get('/api/pages/test-page/versions');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(versions);
  });
});

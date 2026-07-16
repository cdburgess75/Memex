'use strict';
const request = require('supertest');
const express = require('express');
const { generateToken } = require('../../lib/wopiTokens');

jest.mock('../../lib/db', () => ({
  query: jest.fn().mockResolvedValue(undefined),
  queryOne: jest.fn(),
}));

jest.mock('../../lib/storage', () => ({
  download: jest.fn().mockResolvedValue(Buffer.from('file body')),
  upload: jest.fn().mockResolvedValue(undefined),
  copy: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../lib/textExtraction', () => ({
  extractText: jest.fn().mockResolvedValue('file body'),
}));

const db = require('../../lib/db');
const storage = require('../../lib/storage');

function makeApp() {
  const app = express();
  app.use('/wopi', require('../../routes/wopi'));
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  db.queryOne.mockImplementation(async (sql, params) => {
    if (sql.includes('SELECT * FROM documents')) {
      return {
        id: params[0],
        name: 'report.docx',
        size: 9,
        mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        storage_path: `documents/${params[0]}.docx`,
        uploaded_by: 'owner-1',
        created_at: '2026-06-15T00:00:00.000Z',
      };
    }
    if (sql.includes('COALESCE(MAX(version_number)')) return { next: 1 };
    return null;
  });
});

describe('WOPI routes', () => {
  test('serves file info when the token belongs to the requested file', async () => {
    const token = generateToken('doc-1', 'user-1', 'user@test.com');

    const res = await request(makeApp()).get(`/wopi/files/doc-1?access_token=${token}`);

    expect(res.status).toBe(200);
    expect(res.body.BaseFileName).toBe('report.docx');
    expect(db.queryOne).toHaveBeenCalledWith('SELECT * FROM documents WHERE id = $1', ['doc-1']);
  });

  test('rejects a token issued for a different file before touching storage', async () => {
    const token = generateToken('doc-1', 'user-1', 'user@test.com');

    const res = await request(makeApp()).get(`/wopi/files/doc-2/contents?access_token=${token}`);

    expect(res.status).toBe(401);
    expect(db.queryOne).not.toHaveBeenCalled();
    expect(storage.download).not.toHaveBeenCalled();
  });

  test('rejects lock operations when the token belongs to another file', async () => {
    const token = generateToken('doc-1', 'user-1', 'user@test.com');

    const res = await request(makeApp())
      .post(`/wopi/files/doc-2?access_token=${token}`)
      .set('X-WOPI-Override', 'LOCK')
      .set('X-WOPI-Lock', 'lock-1');

    expect(res.status).toBe(401);
  });

  test('CheckFileInfo reports UserCanWrite from the token, not hardcoded true', async () => {
    const readToken = generateToken('doc-1', 'user-1', 'viewer@test.com', false);
    const writeToken = generateToken('doc-1', 'user-1', 'editor@test.com', true);

    const readRes = await request(makeApp()).get(`/wopi/files/doc-1?access_token=${readToken}`);
    const writeRes = await request(makeApp()).get(`/wopi/files/doc-1?access_token=${writeToken}`);

    expect(readRes.body.UserCanWrite).toBe(false);
    expect(writeRes.body.UserCanWrite).toBe(true);
  });

  test('PutFile refuses to overwrite when the token has no write permission', async () => {
    const readToken = generateToken('doc-1', 'user-1', 'viewer@test.com', false);

    const res = await request(makeApp())
      .post(`/wopi/files/doc-1/contents?access_token=${readToken}`)
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('malicious overwrite'));

    expect(res.status).toBe(403);
    expect(storage.upload).not.toHaveBeenCalled();
  });
});

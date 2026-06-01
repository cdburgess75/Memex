'use strict';
const requireRole = require('../../middleware/requireRole');

function makeReqRes(role) {
  const req = { user: { role } };
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  const next = jest.fn();
  return { req, res, next };
}

test('passes when user has an allowed role', () => {
  const mw = requireRole('admin', 'contributor');
  const { req, res, next } = makeReqRes('admin');
  mw(req, res, next);
  expect(next).toHaveBeenCalledTimes(1);
  expect(res.status).not.toHaveBeenCalled();
});

test('passes for any role in the allowed list', () => {
  const mw = requireRole('admin', 'contributor');
  const { req, res, next } = makeReqRes('contributor');
  mw(req, res, next);
  expect(next).toHaveBeenCalledTimes(1);
});

test('returns 403 when role not in allowed list', () => {
  const mw = requireRole('admin');
  const { req, res, next } = makeReqRes('contributor');
  mw(req, res, next);
  expect(res.status).toHaveBeenCalledWith(403);
  expect(res.json).toHaveBeenCalledWith({ error: 'Insufficient permissions' });
  expect(next).not.toHaveBeenCalled();
});

test('returns 403 when req.user is absent', () => {
  const mw = requireRole('admin');
  const req = {};
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  const next = jest.fn();
  mw(req, res, next);
  expect(res.status).toHaveBeenCalledWith(403);
  expect(next).not.toHaveBeenCalled();
});

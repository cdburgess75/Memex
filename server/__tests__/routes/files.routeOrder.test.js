'use strict';
// Express matches routes in the order they are registered. The folder router is mounted at
// /folder INSIDE the file router, so any "/:id/<word>" registered before that mount reads
// "/folder/<word>" as a file whose id is "folder". That is how POST /folder/send shipped
// answering 500 while every test of it passed: those tests mounted the folder router alone.
const fs = require('fs');
const path = require('path');
const files = fs.readFileSync(path.join(__dirname, '../../routes/files.js'), 'utf8');
const folders = fs.readFileSync(path.join(__dirname, '../../routes/files/folders.js'), 'utf8');

test('the folder router is mounted before any route with a parameter', () => {
  const mount = files.indexOf("router.use('/folder'");
  const firstParam = files.search(/router\.(get|post|put|patch|delete)\('\/:/);
  expect(mount).toBeGreaterThan(-1);
  expect(mount).toBeLessThan(firstParam);
});
test('it is mounted exactly once', () => expect(files.match(/router\.use\('\/folder'/g)).toHaveLength(1));
test('and the collision that bit is real: both routers do have a "send"', () => {
  expect(files).toMatch(/router\.post\('\/:id\/send'/);
  expect(folders).toMatch(/router\.post\('\/send'/);
});

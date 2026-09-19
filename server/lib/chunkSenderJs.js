'use strict';
// Browser code, shared by the two public pages (a file link's and a folder link's): send one
// file as 16 MB pieces, in order. A piece that fails is tried again on its own; if the server
// says it is somewhere else (an answer got lost), carry on from where IT is. ES5, no
// dependencies, because these pages must open in whatever the recipient has.
//
//   sendInPieces(url, file, { at, rel }, getTicket, setTicket, onProgress) -> Promise<{ ok, status, j }>
module.exports = `
  var PIECE = 16 * 1024 * 1024;
  function uploadId() { var a = new Uint8Array(18); (window.crypto || window.msCrypto).getRandomValues(a); var s = ''; for (var i = 0; i < a.length; i++) s += ('0' + a[i].toString(16)).slice(-2); return s; }
  function sendInPieces(url, file, where, getTicket, setTicket, onProgress) {
    var id = uploadId(), offset = 0, tries = 0;
    return new Promise(function (resolve) {
      function step() {
        var end = Math.min(offset + PIECE, file.size);
        var h = { 'Content-Type': 'application/octet-stream', 'X-Upload-Id': id, 'X-Upload-Offset': String(offset), 'X-Upload-Total': String(file.size),
          'X-Upload-Name': encodeURIComponent(file.name), 'X-Upload-Path': encodeURIComponent(where.at || ''), 'X-Upload-Rel': encodeURIComponent(where.rel || '') };
        var t = getTicket(); if (t) h['X-Share-Ticket'] = t;
        fetch(url, { method: 'POST', headers: h, body: file.slice(offset, end) }).then(function (r) {
          return r.json().catch(function () { return {}; }).then(function (j) {
            if (j && j.ticket) setTicket(j.ticket);           // a long upload outlives one pass: the server renews it
            if (r.ok) { tries = 0; if (j.done) return resolve({ ok: true, status: r.status, j: j }); offset = typeof j.received === 'number' ? j.received : end; if (onProgress) onProgress(offset, file.size); return step(); }
            if (r.status === 409 && j && typeof j.received === 'number' && tries < 6) { tries++; if (j.restart) id = uploadId(); offset = j.received; return step(); }
            if ((r.status === 502 || r.status === 503 || r.status === 504) && tries < 5) return again();
            resolve({ ok: false, status: r.status, j: j });
          });
        }).catch(function () { if (tries < 5) return again(); resolve({ ok: false, status: 0, j: { error: 'Connection lost. Try again.' } }); });
      }
      function again() { tries++; setTimeout(step, Math.min(15000, 1000 * Math.pow(2, tries - 1))); }
      step();
    });
  }
`;

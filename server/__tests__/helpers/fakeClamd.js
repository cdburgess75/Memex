'use strict';
// A stand-in clamd on a loopback port, speaking just enough of its protocol for the
// tests: zPING, zVERSION and zINSTREAM. `mode` decides the verdict: 'detect' (the
// default) names the file when the EICAR test string passes through, 'found' names every
// file, 'error' answers as clamd does when a stream is over its StreamMaxLength, 'hang'
// never answers. What was received is kept for assertions.
const net = require('net');

// Assembled from pieces, so no file in the repo holds the string itself.
const EICAR = ['X5O!P%@AP[4\\PZX54(P^)7CC)7}$', 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE', '!$H+H*'].join('');
const VERSION_LINE = 'ClamAV 1.4.6/27500/Tue Nov  3 08:00:00 2026';

function start({ mode = 'detect' } = {}) {
  const state = { mode, scans: [], pings: 0, versions: 0, connections: 0 };
  const server = net.createServer((sock) => {
    state.connections += 1;
    let buf = Buffer.alloc(0);
    let phase = 'command';
    let body = [];
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (phase === 'command') {
          const nul = buf.indexOf(0);
          if (nul < 0) return;
          const cmd = buf.subarray(0, nul).toString();
          buf = buf.subarray(nul + 1);
          if (cmd === 'zPING') { state.pings += 1; sock.end('PONG\0'); return; }
          if (cmd === 'zVERSION') { state.versions += 1; sock.end(VERSION_LINE + '\0'); return; }
          if (cmd === 'zINSTREAM') { phase = 'stream'; continue; }
          sock.end('UNKNOWN COMMAND\0'); return;
        }
        if (buf.length < 4) return;
        const len = buf.readUInt32BE(0);
        if (len === 0) {
          const data = Buffer.concat(body);
          state.scans.push(data);
          if (state.mode === 'hang') return;
          if (state.mode === 'error') { sock.end('INSTREAM size limit exceeded. ERROR\0'); return; }
          const found = state.mode === 'found' || (state.mode === 'detect' && data.includes(EICAR));
          sock.end(found ? 'stream: Win.Test.EICAR_HDB-1 FOUND\0' : 'stream: OK\0');
          return;
        }
        if (buf.length < 4 + len) return;
        body.push(Buffer.from(buf.subarray(4, 4 + len)));
        buf = buf.subarray(4 + len);
      }
    });
    sock.on('error', () => {});
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    resolve({ port, host: `127.0.0.1:${port}`, state, close: () => new Promise((r) => server.close(() => r())) });
  }));
}

module.exports = { start, EICAR, VERSION_LINE };

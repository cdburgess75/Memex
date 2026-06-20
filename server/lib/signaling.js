'use strict';
// WebSocket signaling for native WebRTC: presence, direct-call ringing, room
// membership, and relaying SDP/ICE between peers. No media flows through here —
// it only brokers the connection setup (the media is peer-to-peer / mesh).
const { WebSocketServer } = require('ws');
const { verifyToken } = require('../middleware/auth');

function init(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });
  const clients = new Map();      // ws -> { userId, email, name, rooms:Set }
  const userSockets = new Map();  // userId -> Set<ws>
  const rooms = new Map();        // room -> Set<ws>

  const send = (ws, obj) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); };
  const peerOf = info => ({ userId: info.userId, name: info.name, email: info.email });

  function presenceList() {
    return [...userSockets.keys()].map(uid => {
      const info = clients.get([...userSockets.get(uid)][0]);
      return info ? peerOf(info) : null;
    }).filter(Boolean);
  }
  function broadcastPresence() {
    const users = presenceList();
    for (const ws of clients.keys()) send(ws, { type: 'presence', users });
  }
  function toUser(userId, obj) {
    for (const ws of (userSockets.get(userId) || [])) send(ws, obj);
  }
  function roomMembers(room) {
    return [...(rooms.get(room) || [])].map(w => clients.get(w)).filter(Boolean).map(peerOf);
  }
  function roomLeave(ws, info, room) {
    room = String(room || '');
    const set = rooms.get(room);
    if (!set || !set.has(ws)) return;
    set.delete(ws);
    info.rooms.delete(room);
    for (const w of set) send(w, { type: 'peer-left', room, peer: { userId: info.userId } });
    if (!set.size) rooms.delete(room);
  }

  wss.on('connection', async (ws, req) => {
    let info;
    try {
      const token = new URL(req.url, 'http://x').searchParams.get('token');
      const payload = await verifyToken(token);
      info = { userId: payload.sub, email: (payload.email || '').toLowerCase(), name: payload.name || payload.email || 'Member', rooms: new Set() };
    } catch { ws.close(4001, 'unauthorized'); return; }

    clients.set(ws, info);
    if (!userSockets.has(info.userId)) userSockets.set(info.userId, new Set());
    userSockets.get(info.userId).add(ws);
    send(ws, { type: 'welcome', self: peerOf(info) });
    broadcastPresence();

    ws.on('message', raw => {
      let msg; try { msg = JSON.parse(raw); } catch { return; }
      switch (msg.type) {
        case 'join': {
          const room = String(msg.room || '').slice(0, 120);
          if (!room) return;
          if (!rooms.has(room)) rooms.set(room, new Set());
          send(ws, { type: 'room-peers', room, peers: roomMembers(room) }); // existing peers (the joiner initiates offers to these)
          rooms.get(room).add(ws);
          info.rooms.add(room);
          for (const w of rooms.get(room)) if (w !== ws) send(w, { type: 'peer-joined', room, peer: peerOf(info) });
          break;
        }
        case 'leave':
          roomLeave(ws, info, msg.room);
          break;
        case 'signal': // relay an SDP offer/answer or ICE candidate to one peer
          if (msg.to) toUser(msg.to, { type: 'signal', room: msg.room, from: peerOf(info), data: msg.data });
          break;
        case 'call':        // ring a member directly
        case 'call-accept':
        case 'call-reject':
        case 'call-cancel':
          if (msg.to) toUser(msg.to, { type: msg.type, from: peerOf(info), room: msg.room });
          break;
      }
    });

    ws.on('close', () => {
      for (const room of [...info.rooms]) roomLeave(ws, info, room);
      clients.delete(ws);
      const set = userSockets.get(info.userId);
      if (set) { set.delete(ws); if (!set.size) userSockets.delete(info.userId); }
      broadcastPresence();
    });
  });

  return wss;
}

module.exports = { init };

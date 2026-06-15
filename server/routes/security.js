'use strict';
const express = require('express');
const fs = require('fs').promises;
const auth = require('../middleware/auth');

const router = express.Router();

function fallbackStatus() {
  const level = process.env.SECURITY_ALERT_LEVEL || 'info';
  const recentConnections = Number.parseInt(process.env.SECURITY_RECENT_CONNECTIONS || '0', 10);
  return {
    level: ['ok', 'info', 'warning', 'critical'].includes(level) ? level : 'info',
    configured: process.env.SECURITY_MONITOR_CONFIGURED === 'true',
    firewall: process.env.SECURITY_FIREWALL || 'UFW',
    recentConnections: Number.isFinite(recentConnections) ? recentConnections : 0,
    window: process.env.SECURITY_ALERT_WINDOW || '15 minutes',
    message: process.env.SECURITY_ALERT_MESSAGE || 'Host firewall monitoring is not connected yet.',
    updatedAt: new Date().toISOString(),
  };
}

async function readStatusFile() {
  const file = process.env.SECURITY_STATUS_FILE;
  if (!file) return null;
  const raw = await fs.readFile(file, 'utf8');
  const parsed = JSON.parse(raw);
  return {
    ...fallbackStatus(),
    ...parsed,
    firewall: parsed.firewall || 'UFW',
    updatedAt: parsed.updatedAt || parsed.updated_at || new Date().toISOString(),
  };
}

router.get('/status', auth, async (_req, res) => {
  try {
    const status = await readStatusFile();
    res.json(status || fallbackStatus());
  } catch (e) {
    res.json({
      ...fallbackStatus(),
      level: 'warning',
      configured: false,
      message: `Could not read host security status: ${e.message}`,
    });
  }
});

module.exports = router;

import express from 'express';
import axios from 'axios';
import { db } from '../../config/database';

const healthRouter = express.Router();

function opsToken(): string {
  return String(process.env.DAYFI_OPS_TOKEN || '').trim();
}

function assertOpsAccess(req: express.Request): boolean {
  const expected = opsToken();
  if (!expected) return true;
  const header = String(req.headers['x-dayfi-ops-token'] || '').trim();
  const query = String(req.query.token || '').trim();
  return header === expected || query === expected;
}

/** Liveness — no auth. Use behind load balancer / uptime checks. */
healthRouter.get('/', async (_req, res) => {
  res.json({ ok: true, service: 'dayfi-api' });
});

/** Readiness — verifies Postgres connectivity. */
healthRouter.get('/ready', async (_req, res) => {
  try {
    await db.one('SELECT 1 AS ok');
    res.json({ ok: true, database: 'up' });
  } catch (err) {
    res.status(503).json({
      ok: false,
      database: 'down',
      message: err instanceof Error ? err.message : 'database unavailable',
    });
  }
});

/**
 * Public IPv4 seen by the internet (for Flutterwave / Yellow Card whitelisting).
 * Set DAYFI_OPS_TOKEN in production and pass X-Dayfi-Ops-Token or ?token=.
 */
healthRouter.get('/egress-ip', async (req, res) => {
  if (!assertOpsAccess(req)) {
    res.status(401).json({ ok: false, message: 'Unauthorized' });
    return;
  }
  try {
    const { data } = await axios.get<{ ip?: string }>(
      'https://api.ipify.org?format=json',
      { timeout: 8000 }
    );
    const ipv4 = String(data?.ip || '').trim();
    if (!ipv4) {
      res.status(502).json({ ok: false, message: 'Could not resolve egress IP' });
      return;
    }
    res.json({
      ok: true,
      ipv4,
      hint: 'Whitelist this IPv4 in Flutterwave and Yellow Card dashboards.',
    });
  } catch (err) {
    res.status(502).json({
      ok: false,
      message: err instanceof Error ? err.message : 'egress IP lookup failed',
    });
  }
});

export { healthRouter };

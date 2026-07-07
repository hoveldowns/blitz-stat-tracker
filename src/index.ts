import express from 'express';
import { Mppx, tempo } from 'mppx/server';
import { getPlayerStats, getPlayerHistory, getLeaderboard } from './torii.ts';
import { migrate } from './db.ts';
import {
  startSync,
  getAgentReputation,
  getRequesterReliability,
  getPlatformStats,
} from './taskmarket.ts';

const PORT = Number(process.env.PORT) || 3000;

// Tempo recipient wallet and pathUSD currency address
const RECIPIENT = '0x21b219835c2fe00616a4b20f28f418b8ac5821be' as const;
const PATH_USD = '0x20c0000000000000000000000000000000000000' as const;

if (!process.env.MPPX_SECRET_KEY) {
  throw new Error('MPPX_SECRET_KEY is required');
}

const mppx = Mppx.create({
  secretKey: process.env.MPPX_SECRET_KEY,
  methods: [
    tempo({
      currency: PATH_USD,
      recipient: RECIPIENT,
      feePayer: true,       // Tempo sponsors gas on pathchain
      waitForConfirmation: false, // optimistic: trust HMAC receipt, no on-chain wait
    }),
  ],
});

// ---------------------------------------------------------------------------
// Helper: adapt a fetch-style paid handler for Express via Mppx.toNodeListener
// ---------------------------------------------------------------------------

type FetchHandler = (request: Request) => Promise<Response>;

function paid(handler: FetchHandler): express.RequestHandler {
  // Mppx.toNodeListener converts a Fetch API handler to a Node.js
  // (IncomingMessage, ServerResponse) listener — compatible with Express since
  // Express req/res extend those Node.js types.
  const nodeListener = Mppx.toNodeListener(handler as Parameters<typeof Mppx.toNodeListener>[0]);
  return (req, res) => {
    void nodeListener(req, res);
  };
}

// ---------------------------------------------------------------------------
// Paid route handlers — Blitz
// ---------------------------------------------------------------------------

const statsHandler = paid(async (request) => {
  const result = await mppx.charge({
    amount: '0.01',
    description: 'Blitz player career stats',
  })(request);

  if (result.status === 402) return result.challenge;

  try {
    // Express has already matched /api/player/:address/stats; extract from URL.
    const parts = new URL(request.url).pathname.split('/');
    const address = parts[3] ?? '';
    const data = await getPlayerStats(address);
    return result.withReceipt(Response.json(data));
  } catch (err) {
    console.error('[stats]', err);
    return result.withReceipt(
      Response.json({ error: 'failed to fetch stats' }, { status: 500 }),
    );
  }
});

const historyHandler = paid(async (request) => {
  const result = await mppx.charge({
    amount: '0.01',
    description: 'Blitz player MMR history',
  })(request);

  if (result.status === 402) return result.challenge;

  try {
    const parts = new URL(request.url).pathname.split('/');
    const address = parts[3] ?? '';
    const data = await getPlayerHistory(address);
    return result.withReceipt(Response.json(data));
  } catch (err) {
    console.error('[history]', err);
    return result.withReceipt(
      Response.json({ error: 'failed to fetch history' }, { status: 500 }),
    );
  }
});

const leaderboardHandler = paid(async (request) => {
  const result = await mppx.charge({
    amount: '0.01',
    description: 'Blitz leaderboard',
  })(request);

  if (result.status === 402) return result.challenge;

  try {
    const data = await getLeaderboard(50);
    return result.withReceipt(Response.json(data));
  } catch (err) {
    console.error('[leaderboard]', err);
    return result.withReceipt(
      Response.json({ error: 'failed to fetch leaderboard' }, { status: 500 }),
    );
  }
});

// ---------------------------------------------------------------------------
// Paid route handlers — TaskMarket
// ---------------------------------------------------------------------------

const agentReputationHandler = paid(async (request) => {
  const result = await mppx.charge({
    amount: '0.01',
    description: 'TaskMarket agent reputation',
  })(request);
  if (result.status === 402) return result.challenge;
  try {
    const parts = new URL(request.url).pathname.split('/');
    const agentId = parts[3] ?? '';
    const data = await getAgentReputation(agentId);
    return result.withReceipt(Response.json(data));
  } catch (err) {
    console.error('[agent-reputation]', err);
    return result.withReceipt(
      Response.json({ error: 'failed to fetch agent reputation' }, { status: 500 }),
    );
  }
});

const requesterReliabilityHandler = paid(async (request) => {
  const result = await mppx.charge({
    amount: '0.01',
    description: 'TaskMarket requester reliability',
  })(request);
  if (result.status === 402) return result.challenge;
  try {
    const parts = new URL(request.url).pathname.split('/');
    const requesterId = parts[3] ?? '';
    const data = await getRequesterReliability(requesterId);
    return result.withReceipt(Response.json(data));
  } catch (err) {
    console.error('[requester-reliability]', err);
    return result.withReceipt(
      Response.json({ error: 'failed to fetch requester reliability' }, { status: 500 }),
    );
  }
});

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json());

// Free
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', ts: Date.now() });
});

app.get('/api/stats', async (_req, res) => {
  try {
    const data = await getPlatformStats();
    res.json(data);
  } catch (err) {
    console.error('[stats]', err);
    res.status(500).json({ error: 'failed to fetch platform stats' });
  }
});

// Paid — 0.01 pathUSD each, gated via Tempo / MPP
app.get('/api/player/:address/stats', statsHandler);
app.get('/api/player/:address/history', historyHandler);
app.get('/api/leaderboard', leaderboardHandler);
app.get('/api/agent/:id/reputation', agentReputationHandler);
app.get('/api/requester/:id/reliability', requesterReliabilityHandler);

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

await migrate();
startSync();

app.listen(PORT, () => {
  console.log(`blitz-stat-api listening on :${PORT}`);
});

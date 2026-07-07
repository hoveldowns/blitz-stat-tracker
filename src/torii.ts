const TORII_BASE = 'https://api.cartridge.gg/x';

// Completed S0 slots + active live slot.
// TODO: add Series 1 shard slots here when they launch — no other code changes needed.
export const SLOTS = [
  's0-game-1',
  's0-game-2',
  's0-game-3',
  's0-game-4',
  's0-game-5',
  's0-game-6',
  's0-game-7',
  's0-game-8',
  's0-game-9',
  's0-game-10',
  's0-game-11',
  's0-game-12',
  'eternum-38',
] as const;

export const LIVE_SLOT = 'eternum-38';

// TTLs per architecture doc
const TTL_MS = {
  stats: 60 * 60 * 1_000,       // 1 hour
  history: 60 * 60 * 1_000,     // 1 hour
  leaderboard: 30 * 60 * 1_000, // 30 min
} as const;

type CacheEntry = { data: unknown; expires: number };
const cache = new Map<string, CacheEntry>();

function getCached<T>(key: string): T | null {
  const entry = cache.get(key);
  if (entry && entry.expires > Date.now()) return entry.data as T;
  return null;
}

function setCached(key: string, data: unknown, ttlMs: number): void {
  cache.set(key, { data, expires: Date.now() + ttlMs });
}

async function toriiQuery<T = Record<string, unknown>>(
  slot: string,
  sql: string,
): Promise<T[]> {
  const url = `${TORII_BASE}/${slot}/torii/sql?query=${encodeURIComponent(sql)}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return [];
    return res.json() as Promise<T[]>;
  } catch {
    return [];
  }
}

// Normalize address to consistent lowercase hex for cache keying and queries.
function normalizeAddr(addr: string): string {
  const hex = addr.toLowerCase();
  return hex.startsWith('0x') ? hex : `0x${hex}`;
}

// ---------------------------------------------------------------------------
// Player stats
// ---------------------------------------------------------------------------

export type PlayerStats = {
  address: string;
  name: string | null;
  totalGames: number;
  wins: number;
  losses: number;
  currentMmr: number;
  peakMmr: number;
  winRate: number;
  activeSlots: string[];
};

export async function getPlayerStats(address: string): Promise<PlayerStats> {
  const addr = normalizeAddr(address);
  const cacheKey = `stats:${addr}`;
  const cached = getCached<PlayerStats>(cacheKey);
  if (cached) return cached;

  // TODO: verify column names against your actual Torii schema.
  // ContractAddress fields are stored as hex strings in Torii SQL.
  const [rankResults, gameResults, nameResults] = await Promise.all([
    Promise.all(
      SLOTS.map((slot) =>
        toriiQuery<{ player: string; mmr: string }>(
          slot,
          `SELECT player, mmr FROM "PlayerRank" WHERE player = '${addr}' LIMIT 1`,
        ).then((rows) => rows.map((r) => ({ slot, mmr: Number(r['mmr']) }))),
      ),
    ).then((r) => r.flat()),

    Promise.all(
      SLOTS.map((slot) =>
        toriiQuery<{ outcome: string; mmr_change: string }>(
          slot,
          `SELECT outcome, mmr_change FROM "MMRGameCommitted" WHERE player = '${addr}'`,
        ).then((rows) =>
          rows.map((r) => ({ outcome: r['outcome'], mmrChange: Number(r['mmr_change']) })),
        ),
      ),
    ).then((r) => r.flat()),

    toriiQuery<{ name: string }>(
      LIVE_SLOT,
      `SELECT name FROM "AddressName" WHERE address = '${addr}' LIMIT 1`,
    ),
  ]);

  const activeMmrSlots = rankResults.filter((r) => r.mmr > 0);
  const currentMmr =
    activeMmrSlots.length > 0 ? Math.max(...activeMmrSlots.map((r) => r.mmr)) : 0;

  const totalGames = gameResults.length;
  // Win detection: positive mmr_change or outcome flag.
  // TODO: adjust win condition to match your actual outcome encoding.
  const wins = gameResults.filter((r) => r.mmrChange > 0 || r.outcome === '1').length;
  const losses = totalGames - wins;

  const stats: PlayerStats = {
    address: addr,
    name: nameResults[0]?.['name'] ?? null,
    totalGames,
    wins,
    losses,
    currentMmr,
    peakMmr: currentMmr, // TODO: derive from PlayerMMRChanged max if needed
    winRate: totalGames > 0 ? Math.round((wins / totalGames) * 100) : 0,
    activeSlots: [...new Set(activeMmrSlots.map((r) => r.slot))],
  };

  setCached(cacheKey, stats, TTL_MS.stats);
  return stats;
}

// ---------------------------------------------------------------------------
// MMR history
// ---------------------------------------------------------------------------

export type MmrHistoryEntry = {
  slot: string;
  oldMmr: number;
  newMmr: number;
  timestamp: string;
};

export async function getPlayerHistory(address: string): Promise<MmrHistoryEntry[]> {
  const addr = normalizeAddr(address);
  const cacheKey = `history:${addr}`;
  const cached = getCached<MmrHistoryEntry[]>(cacheKey);
  if (cached) return cached;

  // TODO: Torii event tables typically have `executed_at` — adjust if different.
  const rows = await Promise.all(
    SLOTS.map((slot) =>
      toriiQuery<{ old_mmr: string; new_mmr: string; executed_at: string }>(
        slot,
        `SELECT old_mmr, new_mmr, executed_at
         FROM "PlayerMMRChanged"
         WHERE player = '${addr}'
         ORDER BY executed_at DESC
         LIMIT 100`,
      ).then((r) =>
        r.map((row) => ({
          slot,
          oldMmr: Number(row['old_mmr']),
          newMmr: Number(row['new_mmr']),
          timestamp: row['executed_at'] ?? '',
        })),
      ),
    ),
  ).then((r) =>
    r
      .flat()
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      .slice(0, 500),
  );

  setCached(cacheKey, rows, TTL_MS.history);
  return rows;
}

// ---------------------------------------------------------------------------
// Leaderboard
// ---------------------------------------------------------------------------

export type LeaderboardEntry = {
  rank: number;
  address: string;
  name: string | null;
  mmr: number;
};

export async function getLeaderboard(limit: number): Promise<LeaderboardEntry[]> {
  const cacheKey = `leaderboard:${limit}`;
  const cached = getCached<LeaderboardEntry[]>(cacheKey);
  if (cached) return cached;

  // Query live slot for current standings.
  // TODO: verify column names and join syntax for your Torii version.
  const rows = await toriiQuery<{ player: string; mmr: string; name?: string }>(
    LIVE_SLOT,
    `SELECT pr.player, pr.mmr, an.name
     FROM "PlayerRank" pr
     LEFT JOIN "AddressName" an ON pr.player = an.address
     ORDER BY CAST(pr.mmr AS INTEGER) DESC
     LIMIT ${limit}`,
  );

  const entries: LeaderboardEntry[] = rows.map((row, i) => ({
    rank: i + 1,
    address: row['player'] ?? '',
    name: row['name'] ?? null,
    mmr: Number(row['mmr']),
  }));

  setCached(cacheKey, entries, TTL_MS.leaderboard);
  return entries;
}

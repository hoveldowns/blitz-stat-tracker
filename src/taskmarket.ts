import { query } from './db.ts';

const TM_BASE = 'https://api-market.daydreams.systems/api';
// USDC on Base uses 6 decimals: 1_000_000 raw = 1.00 USDC
const REWARD_DECIMALS = 1_000_000;

// ---------------------------------------------------------------------------
// TaskMarket API types
// ---------------------------------------------------------------------------

type TMTask = {
  id: string;
  requester: string;
  requesterAgentId: string;
  reward: string;
  status: string;
  worker: string | null;
  rating: number | null;
  createdAt: string;
  expiryTime: string;
  claimedAt: string | null;
  submissionCount: number;
  [key: string]: unknown;
};

type TMSubmission = {
  id: string;
  taskId: string;
  workerAddress: string;
  workerAgentId: string;
  submittedAt: string;
  workerStats: {
    completedTasks: number;
    ratedTasks: number;
    totalStars: number;
    averageRating: number;
  };
  [key: string]: unknown;
};

type TasksPage = {
  tasks: TMTask[];
  nextCursor: string | null;
  hasMore: boolean;
};

// ---------------------------------------------------------------------------
// API fetching
// ---------------------------------------------------------------------------

const ALL_STATUSES = ['open', 'pending_approval', 'completed', 'expired'];

async function fetchTasksPage(status: string, cursor?: string): Promise<TasksPage> {
  const params = new URLSearchParams({ limit: '100', status });
  if (cursor) params.set('cursor', cursor);
  const res = await fetch(`${TM_BASE}/tasks?${params}`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`TaskMarket API error ${res.status} (status=${status})`);
  return res.json() as Promise<TasksPage>;
}

async function fetchAllTasks(): Promise<TMTask[]> {
  const all: TMTask[] = [];
  for (const status of ALL_STATUSES) {
    let cursor: string | undefined;
    do {
      const page = await fetchTasksPage(status, cursor);
      all.push(...page.tasks);
      cursor = page.hasMore && page.nextCursor ? page.nextCursor : undefined;
    } while (cursor);
  }
  return all;
}

async function fetchSubmissions(taskId: string): Promise<TMSubmission[]> {
  const res = await fetch(`${TM_BASE}/tasks/${taskId}/submissions`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return [];
  return res.json() as Promise<TMSubmission[]>;
}

// ---------------------------------------------------------------------------
// Sync: write API data into PostgreSQL
// ---------------------------------------------------------------------------

async function upsertTask(task: TMTask): Promise<void> {
  await query(
    `INSERT INTO tm_tasks
       (id, requester, requester_agent_id, reward, status, worker, rating,
        created_at, expiry_time, claimed_at, data)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (id) DO UPDATE SET
       status        = EXCLUDED.status,
       worker        = EXCLUDED.worker,
       rating        = EXCLUDED.rating,
       claimed_at    = EXCLUDED.claimed_at,
       data          = EXCLUDED.data,
       fetched_at    = NOW()`,
    [
      task.id,
      task.requester.toLowerCase(),
      task.requesterAgentId,
      task.reward,
      task.status,
      task.worker?.toLowerCase() ?? null,
      task.rating,
      task.createdAt,
      task.expiryTime,
      task.claimedAt,
      task,
    ],
  );
}

async function upsertSubmission(sub: TMSubmission): Promise<void> {
  await query(
    `INSERT INTO tm_submissions
       (id, task_id, worker_address, worker_agent_id, submitted_at, worker_stats, data)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (id) DO UPDATE SET
       worker_stats = EXCLUDED.worker_stats,
       data         = EXCLUDED.data,
       fetched_at   = NOW()`,
    [
      sub.id,
      sub.taskId,
      sub.workerAddress.toLowerCase(),
      sub.workerAgentId,
      sub.submittedAt,
      sub.workerStats,
      sub,
    ],
  );
}

async function runSync(): Promise<void> {
  console.log('[taskmarket] syncing tasks...');
  const tasks = await fetchAllTasks();
  for (const task of tasks) await upsertTask(task);
  console.log(`[taskmarket] upserted ${tasks.length} tasks`);

  console.log('[taskmarket] syncing submissions...');
  const tasksWithSubs = tasks.filter((t) => t.submissionCount > 0);
  let subCount = 0;
  for (const task of tasksWithSubs) {
    const subs = await fetchSubmissions(task.id);
    for (const sub of subs) await upsertSubmission(sub);
    subCount += subs.length;
  }
  console.log(`[taskmarket] upserted ${subCount} submissions`);

  await query(
    `INSERT INTO tm_sync_meta (key, value, updated_at) VALUES ('last_sync', NOW()::text, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
  );
}

export function startSync(): void {
  const INTERVAL_MS = 15 * 60 * 1_000;
  void runSync().catch((err) => console.error('[taskmarket] initial sync error:', err));
  setInterval(() => void runSync().catch((err) => console.error('[taskmarket] sync error:', err)), INTERVAL_MS);
}

// ---------------------------------------------------------------------------
// Agent reputation  GET /api/agent/:id/reputation
// ---------------------------------------------------------------------------

export type AgentReputation = {
  agentAddress: string;
  totalSubmissions: number;
  completedTasks: number;       // platform-reported accepted count
  completionRate: number;       // completedTasks / totalSubmissions × 100
  averageRating: number;        // platform-reported avg star rating
  totalEarnedUsdc: number;      // sum of rewards from tasks where this agent was accepted
  recentTasks: {
    taskId: string;
    description: string;
    rewardUsdc: number;
    accepted: boolean;
    rating: number | null;
    submittedAt: string;
    taskStatus: string;
  }[];
};

export async function getAgentReputation(agentAddress: string): Promise<AgentReputation> {
  const addr = agentAddress.toLowerCase();

  const subs = await query<{
    id: string;
    task_id: string;
    submitted_at: Date;
    worker_stats: { completedTasks: number; ratedTasks: number; totalStars: number; averageRating: number };
  }>(
    `SELECT id, task_id, submitted_at, worker_stats
     FROM tm_submissions
     WHERE worker_address = $1
     ORDER BY submitted_at DESC`,
    [addr],
  );

  if (subs.length === 0) {
    return {
      agentAddress: addr,
      totalSubmissions: 0,
      completedTasks: 0,
      completionRate: 0,
      averageRating: 0,
      totalEarnedUsdc: 0,
      recentTasks: [],
    };
  }

  // Use workerStats from most recent submission — platform pre-computes this
  const latestStats = subs[0]!.worker_stats ?? {
    completedTasks: 0, ratedTasks: 0, totalStars: 0, averageRating: 0,
  };

  // Fetch associated tasks for history + earnings
  const taskIds = [...new Set(subs.map((s) => s.task_id))];
  const taskRows = await query<{
    id: string;
    status: string;
    worker: string | null;
    reward: string;
    rating: number | null;
    data: { description?: string };
  }>(
    `SELECT id, status, worker, reward, rating, data
     FROM tm_tasks WHERE id = ANY($1)`,
    [taskIds],
  );
  const taskMap = new Map(taskRows.map((t) => [t.id, t]));

  const totalEarnedUsdc =
    taskRows
      .filter((t) => t.worker === addr)
      .reduce((sum, t) => sum + Number(t.reward) / REWARD_DECIMALS, 0);

  const recentTasks = subs.slice(0, 20).map((sub) => {
    const task = taskMap.get(sub.task_id);
    return {
      taskId: sub.task_id,
      description: String(task?.data.description ?? '').slice(0, 120),
      rewardUsdc: task ? Number(task.reward) / REWARD_DECIMALS : 0,
      accepted: task?.worker === addr,
      rating: task?.worker === addr ? (task.rating ?? null) : null,
      submittedAt: sub.submitted_at instanceof Date
        ? sub.submitted_at.toISOString()
        : String(sub.submitted_at),
      taskStatus: task?.status ?? 'unknown',
    };
  });

  return {
    agentAddress: addr,
    totalSubmissions: subs.length,
    completedTasks: latestStats.completedTasks,
    completionRate:
      subs.length > 0
        ? Math.round((latestStats.completedTasks / subs.length) * 100)
        : 0,
    averageRating: latestStats.averageRating,
    totalEarnedUsdc: Math.round(totalEarnedUsdc * 100) / 100,
    recentTasks,
  };
}

// ---------------------------------------------------------------------------
// Requester reliability  GET /api/requester/:id/reliability
// ---------------------------------------------------------------------------

export type RequesterReliability = {
  requesterAddress: string;
  tasksPosted: number;
  tasksWithAcceptedSubmission: number;
  tasksExpired: number;
  tasksCompleted: number;
  acceptanceRate: number;           // tasks with worker assigned / total posted
  totalRewardPostedUsdc: number;
  totalRewardPaidUsdc: number;
  avgTimeToClaimHours: number | null; // avg(claimedAt - createdAt) for accepted tasks
};

export async function getRequesterReliability(requesterId: string): Promise<RequesterReliability> {
  const addr = requesterId.toLowerCase();

  const tasks = await query<{
    id: string;
    status: string;
    worker: string | null;
    reward: string;
    created_at: Date;
    claimed_at: Date | null;
  }>(
    `SELECT id, status, worker, reward, created_at, claimed_at
     FROM tm_tasks
     WHERE requester = $1
     ORDER BY created_at DESC`,
    [addr],
  );

  if (tasks.length === 0) {
    return {
      requesterAddress: addr,
      tasksPosted: 0,
      tasksWithAcceptedSubmission: 0,
      tasksExpired: 0,
      tasksCompleted: 0,
      acceptanceRate: 0,
      totalRewardPostedUsdc: 0,
      totalRewardPaidUsdc: 0,
      avgTimeToClaimHours: null,
    };
  }

  const accepted = tasks.filter((t) => t.worker != null);
  const expired = tasks.filter((t) => t.status === 'expired');
  const completed = tasks.filter((t) => t.status === 'completed');

  const totalPostedUsdc = tasks.reduce(
    (sum, t) => sum + Number(t.reward) / REWARD_DECIMALS,
    0,
  );
  const totalPaidUsdc = completed.reduce(
    (sum, t) => sum + Number(t.reward) / REWARD_DECIMALS,
    0,
  );

  const claimDelaysMs = accepted
    .filter((t) => t.claimed_at != null)
    .map((t) => {
      const claimedMs = t.claimed_at instanceof Date
        ? t.claimed_at.getTime()
        : new Date(t.claimed_at!).getTime();
      const createdMs = t.created_at instanceof Date
        ? t.created_at.getTime()
        : new Date(t.created_at).getTime();
      return claimedMs - createdMs;
    });
  const avgTimeToClaimHours =
    claimDelaysMs.length > 0
      ? Math.round((claimDelaysMs.reduce((a, b) => a + b, 0) / claimDelaysMs.length / 3_600_000) * 10) / 10
      : null;

  return {
    requesterAddress: addr,
    tasksPosted: tasks.length,
    tasksWithAcceptedSubmission: accepted.length,
    tasksExpired: expired.length,
    tasksCompleted: completed.length,
    acceptanceRate:
      tasks.length > 0 ? Math.round((accepted.length / tasks.length) * 100) : 0,
    totalRewardPostedUsdc: Math.round(totalPostedUsdc * 100) / 100,
    totalRewardPaidUsdc: Math.round(totalPaidUsdc * 100) / 100,
    avgTimeToClaimHours,
  };
}

// ---------------------------------------------------------------------------
// Platform stats  GET /api/stats  (free)
// ---------------------------------------------------------------------------

export type PlatformStats = {
  totalTasks: number;
  byStatus: { open: number; pendingApproval: number; completed: number; expired: number };
  totalRewardPostedUsdc: number;
  totalRewardPaidUsdc: number;
  uniqueRequesters: number;
  uniqueWorkers: number;
  totalSubmissions: number;
  lastSyncedAt: string | null;
};

export async function getPlatformStats(): Promise<PlatformStats> {
  const [taskRow, subRow, syncRow] = await Promise.all([
    query<{
      total: string;
      open: string;
      pending: string;
      completed: string;
      expired: string;
      total_reward: string;
      paid_reward: string;
      unique_requesters: string;
      unique_workers: string;
    }>(
      `SELECT
         COUNT(*) AS total,
         COUNT(*) FILTER (WHERE status = 'open')             AS open,
         COUNT(*) FILTER (WHERE status = 'pending_approval') AS pending,
         COUNT(*) FILTER (WHERE status = 'completed')        AS completed,
         COUNT(*) FILTER (WHERE status = 'expired')          AS expired,
         COALESCE(SUM(CAST(reward AS NUMERIC)) / 1e6, 0)     AS total_reward,
         COALESCE(SUM(CAST(reward AS NUMERIC)) FILTER (WHERE status = 'completed') / 1e6, 0) AS paid_reward,
         COUNT(DISTINCT requester)                            AS unique_requesters,
         COUNT(DISTINCT worker) FILTER (WHERE worker IS NOT NULL) AS unique_workers
       FROM tm_tasks`,
    ),
    query<{ count: string }>(`SELECT COUNT(*) AS count FROM tm_submissions`),
    query<{ value: string; updated_at: string }>(
      `SELECT value, updated_at::text AS updated_at FROM tm_sync_meta WHERE key = 'last_sync'`,
    ),
  ]);

  const s = taskRow[0];
  if (!s) {
    return {
      totalTasks: 0,
      byStatus: { open: 0, pendingApproval: 0, completed: 0, expired: 0 },
      totalRewardPostedUsdc: 0,
      totalRewardPaidUsdc: 0,
      uniqueRequesters: 0,
      uniqueWorkers: 0,
      totalSubmissions: 0,
      lastSyncedAt: null,
    };
  }

  return {
    totalTasks: Number(s.total),
    byStatus: {
      open: Number(s.open),
      pendingApproval: Number(s.pending),
      completed: Number(s.completed),
      expired: Number(s.expired),
    },
    totalRewardPostedUsdc: Math.round(Number(s.total_reward) * 100) / 100,
    totalRewardPaidUsdc: Math.round(Number(s.paid_reward) * 100) / 100,
    uniqueRequesters: Number(s.unique_requesters),
    uniqueWorkers: Number(s.unique_workers),
    totalSubmissions: Number(subRow[0]?.count ?? 0),
    lastSyncedAt: syncRow[0]?.updated_at ?? null,
  };
}

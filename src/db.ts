import pg from 'pg';

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required');
}

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export async function query<T extends Record<string, unknown>>(
  sql: string,
  params?: unknown[],
): Promise<T[]> {
  const result = await pool.query(sql, params);
  return result.rows as T[];
}

export async function migrate(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tm_tasks (
      id TEXT PRIMARY KEY,
      requester TEXT NOT NULL,
      requester_agent_id TEXT,
      reward TEXT,
      status TEXT,
      worker TEXT,
      rating NUMERIC,
      created_at TIMESTAMPTZ,
      expiry_time TIMESTAMPTZ,
      claimed_at TIMESTAMPTZ,
      data JSONB NOT NULL,
      fetched_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS tm_tasks_requester_idx ON tm_tasks(requester);
    CREATE INDEX IF NOT EXISTS tm_tasks_worker_idx ON tm_tasks(worker);
    CREATE INDEX IF NOT EXISTS tm_tasks_status_idx ON tm_tasks(status);

    CREATE TABLE IF NOT EXISTS tm_submissions (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      worker_address TEXT NOT NULL,
      worker_agent_id TEXT,
      submitted_at TIMESTAMPTZ,
      worker_stats JSONB,
      data JSONB NOT NULL,
      fetched_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS tm_submissions_worker_idx ON tm_submissions(worker_address);
    CREATE INDEX IF NOT EXISTS tm_submissions_task_idx ON tm_submissions(task_id);

    CREATE TABLE IF NOT EXISTS tm_sync_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('[db] migrations applied');
}

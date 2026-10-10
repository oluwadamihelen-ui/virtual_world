import pg from 'pg';

// int8 (bigint) -> JS number. MVC amounts are bounded well below 2^53; amounts are range-checked on input.
pg.types.setTypeParser(20, (v) => Number(v));

export type Pool = pg.Pool;
export type Tx = pg.PoolClient;

export const createPool = (connectionString: string) => new pg.Pool({ connectionString, max: 20 });

/** Run fn in a single DB transaction. Retries on deadlock (40P01) and serialization failure (40001). */
export async function withTx<T>(pool: Pool, fn: (tx: Tx) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      if ((err?.code === '40P01' || err?.code === '40001') && attempt < 3) continue;
      throw err;
    } finally {
      client.release();
    }
  }
}

/** Run fn inside a SAVEPOINT so an expected failure (e.g. insufficient funds) does not abort the outer transaction. */
export async function savepoint<T>(tx: Tx, fn: () => Promise<T>): Promise<T> {
  await tx.query('SAVEPOINT mvw_sp');
  try {
    const out = await fn();
    await tx.query('RELEASE SAVEPOINT mvw_sp');
    return out;
  } catch (e) {
    await tx.query('ROLLBACK TO SAVEPOINT mvw_sp');
    throw e;
  }
}

import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { loadGameData } from '../src/gamedata.js';
import { createPool } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { syncGameData } from '../src/seed.js';
import { buildApp } from '../src/app.js';
import type { AppContext } from '../src/context.js';

export const SERVER_KEY = 'test-server-key-test-server-key-1234';
const URL = process.env.TEST_DATABASE_URL ?? 'postgres://mvw:mvw_dev_password@localhost:5432/mvw_test';

export interface TestWorld {
  ctx: AppContext; app: FastifyInstance; clock: { t: Date }; close(): Promise<void>;
  newPlayer(name?: string, email?: string): Promise<{ accountId: string; token: string; characterId: string }>;
  gameReq(method: string, url: string, body?: unknown): Promise<{ status: number; body: any }>;
  playerReq(token: string, method: string, url: string, body?: unknown): Promise<{ status: number; body: any }>;
  setRole(accountId: string, role: 'moderator' | 'admin'): Promise<string>;
}

export async function createWorld(): Promise<TestWorld> {
  const config = loadConfig({
    NODE_ENV: 'test', DATABASE_URL: URL, JWT_SECRET: 'test-jwt-secret-test-jwt-secret-1234', SERVER_API_KEY: SERVER_KEY, GAME_DATA_DIR: '../game-data',
  } as any);
  const pool = createPool(URL);
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(pool);
  const data = loadGameData(config.gameDataDir);
  await syncGameData(pool, data);
  const clock = { t: new Date('2026-01-01T12:00:00Z') };
  const ctx: AppContext = { pool, config, data, now: () => new Date(clock.t) };
  const app = await buildApp(ctx, { rateLimit: false });

  const send = async (headers: Record<string, string>, method: string, url: string, body?: unknown) => {
    const r = await app.inject({ method: method as any, url, headers, payload: body as any });
    return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
  };
  const world: TestWorld = {
    ctx, app, clock,
    close: async () => { await app.close(); await pool.end(); },
    gameReq: (m, u, b) => send({ 'x-server-key': SERVER_KEY }, m, u, b),
    playerReq: (tok, m, u, b) => send({ authorization: `Bearer ${tok}` }, m, u, b),
    async newPlayer(name, email) {
      const id = randomUUID().slice(0, 8);
      email ??= `p${id}@example.com`;
      const reg = await send({}, 'POST', '/v1/auth/register', { email, password: 'correct horse battery' });
      if (reg.status !== 201) throw new Error('register failed ' + JSON.stringify(reg.body));
      const login = await send({}, 'POST', '/v1/auth/login', { email, password: 'correct horse battery' });
      const token = login.body.token as string;
      const ch = await world.playerReq(token, 'POST', '/v1/characters', {
        displayName: name ?? `Player ${id}`,
        appearance: { bodyPreset: 'body_a', skinTone: 2, hairstyle: 'short', hairColor: 'brown', outfit: 'casual_1' },
      });
      if (ch.status !== 201) throw new Error('character failed ' + JSON.stringify(ch.body));
      return { accountId: reg.body.accountId, token, characterId: ch.body.characterId };
    },
    async setRole(accountId, role) {
      await pool.query('UPDATE accounts SET role=$2 WHERE id=$1', [accountId, role]);
      const email = (await pool.query('SELECT email FROM accounts WHERE id=$1', [accountId])).rows[0].email;
      const login = await send({}, 'POST', '/v1/auth/login', { email, password: 'correct horse battery' });
      return login.body.token;
    },
  };
  return world;
}

export const key = () => randomUUID();

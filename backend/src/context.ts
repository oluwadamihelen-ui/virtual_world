import type { Config } from './config.js';
import type { GameData } from './gamedata.js';
import type { Pool } from './db.js';

export interface AppContext {
  pool: Pool;
  config: Config;
  data: GameData;
  /** Injectable clock so rent/shift timing is testable and the server owns time. */
  now: () => Date;
}

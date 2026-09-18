import { DatabaseSync } from 'node:sqlite';
import {
  LocalAgentRepository,
  LocalConversationRepository,
  LocalSuspendedAgentTurnRepository,
} from '../../../../apps/desktop/src/persistence';
import {
  RepositoryTransactions,
  type RepositoryBackend,
  type StorageSnapshot,
} from '../../../../apps/desktop/src/repositoryStorage';
import type { AgentRepository, ConversationRepository, SuspendedAgentTurnRepository } from '../index';

/** Test-only native transport substitute, matching repository.rs's document/revision CAS.
 * Actual desktop repository codecs and transaction retry logic run unchanged.
 * This does NOT run Rust, Tauri, a webview, systemd, or the scheduler ownership lock.
 */
export function openOverlapRepository(path: string) {
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS documents (key TEXT PRIMARY KEY, value TEXT, revision INTEGER NOT NULL);`);
  const backend: RepositoryBackend = {
    async snapshot(keys) {
      const snapshot: StorageSnapshot = { values: {}, revisions: {} };
      const rows = db.prepare('SELECT key,value,revision FROM documents').all();
      for (const row of rows) {
        const key = String(row.key);
        if (keys && !keys.includes(key)) continue;
        snapshot.revisions[key] = Number(row.revision);
        if (row.value !== null) snapshot.values[key] = String(row.value);
      }
      return snapshot;
    },
    async commit(expected, changes) {
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const [key, revision] of Object.entries(expected)) {
          const row = db.prepare('SELECT revision FROM documents WHERE key=?').get(key);
          if (Number(row?.revision ?? 0) !== revision) {
            db.exec('ROLLBACK');
            return false;
          }
        }
        for (const [key, value] of Object.entries(changes)) {
          if (!(key in expected)) throw new Error('Every write requires an expected revision.');
          db.prepare(`INSERT INTO documents(key,value,revision) VALUES(?,?,1)
            ON CONFLICT(key) DO UPDATE SET value=excluded.value, revision=documents.revision+1`)
            .run(key, value);
        }
        db.exec('COMMIT');
        return true;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  };
  const transactions = new RepositoryTransactions(backend);
  const agentKeys = ['iris.agents.config.v2', 'iris.agents.config.v1'];
  const conversationKeys = ['iris.agents.conversations.v1'];
  const suspendedKeys = ['iris.agents.suspended-turns.v1'];
  const agents: AgentRepository = {
    list: () => transactions.run((s) => new LocalAgentRepository(s).list(), agentKeys),
    get: (id) => transactions.run((s) => new LocalAgentRepository(s).get(id), agentKeys),
    save: (agent) => transactions.run((s) => new LocalAgentRepository(s).save(agent), agentKeys),
    remove: (id) => transactions.run((s) => new LocalAgentRepository(s).remove(id), agentKeys),
  };
  const conversations: ConversationRepository = {
    list: (id) => transactions.run((s) => new LocalConversationRepository(s).list(id), conversationKeys),
    save: (id, messages) => transactions.run((s) => new LocalConversationRepository(s).save(id, messages), conversationKeys),
    clear: (id) => transactions.run((s) => new LocalConversationRepository(s).clear(id), conversationKeys),
  };
  const suspended: SuspendedAgentTurnRepository = {
    list: () => transactions.run((s) => new LocalSuspendedAgentTurnRepository(s).list(), suspendedKeys),
    getByAgentId: (id) => transactions.run((s) => new LocalSuspendedAgentTurnRepository(s).getByAgentId(id), suspendedKeys),
    getByApprovalId: (id) => transactions.run((s) => new LocalSuspendedAgentTurnRepository(s).getByApprovalId(id), suspendedKeys),
    save: (turn) => transactions.run((s) => new LocalSuspendedAgentTurnRepository(s).save(turn), suspendedKeys),
    removeByTurnId: (id) => transactions.run((s) => new LocalSuspendedAgentTurnRepository(s).removeByTurnId(id), suspendedKeys),
  };
  return { agents, conversations, suspended, transactions, close: () => db.close() };
}

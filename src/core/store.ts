// Skein's own metadata (G: "Skein keeps its own SQLite"): threads, machines, settings, UI state.
// The conversations themselves stay in ~/.claude and ~/.codex. Uses node:sqlite (built into Electron's
// Node), so there is no native module to compile.
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export class Store {
  private db: DatabaseSync;
  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      pragma journal_mode = wal;
      create table if not exists kv (key text primary key, json text not null);
      create table if not exists threads (id text primary key, json text not null, updated integer not null);
      create table if not exists machines (id text primary key, json text not null);
    `);
  }
  get<T>(key: string): T | undefined {
    const r = this.db.prepare('select json from kv where key = ?').get(key) as { json: string } | undefined;
    return r ? (JSON.parse(r.json) as T) : undefined;
  }
  set(key: string, v: unknown) {
    this.db.prepare('insert into kv(key, json) values(?, ?) on conflict(key) do update set json = excluded.json').run(key, JSON.stringify(v ?? null));
  }
  rows<T>(table: 'threads' | 'machines'): T[] {
    return (this.db.prepare(`select json from ${table}`).all() as { json: string }[]).map(r => JSON.parse(r.json) as T);
  }
  put(table: 'threads' | 'machines', id: string, v: unknown) {
    if (table === 'threads') this.db.prepare('insert into threads(id, json, updated) values(?, ?, ?) on conflict(id) do update set json = excluded.json, updated = excluded.updated').run(id, JSON.stringify(v), Date.now());
    else this.db.prepare('insert into machines(id, json) values(?, ?) on conflict(id) do update set json = excluded.json').run(id, JSON.stringify(v));
  }
  del(table: 'threads' | 'machines', id: string) { this.db.prepare(`delete from ${table} where id = ?`).run(id); }
  close() { this.db.close(); }
}

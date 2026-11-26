// JSON-RPC over a child process's stdio, one JSON object per line: how `codex app-server` and `agy acp` talk.
// Requests carry an id and get a response; notifications have no id; the server also sends requests
// (approvals) that the client must answer.
import type { ChildProcess } from 'node:child_process';
import { log } from '../../log';

type Id = number | string;
export interface RpcError { code: number; message: string; data?: unknown }

export class RpcClosed extends Error {}

export class Rpc {
  private next = 1;
  private pending = new Map<Id, { resolve: (v: unknown) => void; reject: (e: unknown) => void; method: string }>();
  private buf = '';
  private closed = false;
  stderr = '';
  onNotify: (method: string, params: unknown) => void = () => {};
  onRequest: (method: string, params: unknown, id: Id) => Promise<unknown> = async m => { throw { code: -32601, message: `Skein does not handle ${m}` }; };
  onExit: (code: number | null, reason: string) => void = () => {};

  /** A transport: how to write one line, how to stop. Feed incoming data to feed(), the end to ended().
   *  `o.tag` names the server in the log; `o.strict` stamps every message `jsonrpc: '2.0'` (ACP requires it, the
   *  Codex app-server leaves it out). */
  constructor(private out: (line: string) => void, private stop: () => void, private o: { tag?: string; strict?: boolean } = {}) {}

  /** JSON lines from a child process's stdio. */
  static overProcess(proc: ChildProcess, o: { tag?: string; strict?: boolean } = {}): Rpc {
    const rpc = new Rpc(line => proc.stdin?.write(line + '\n'), () => proc.kill(), o);
    proc.stdout?.setEncoding('utf8');
    proc.stdout?.on('data', (d: string) => rpc.feed(d));
    proc.stderr?.on('data', d => { rpc.stderr = (rpc.stderr + String(d)).slice(-4000); });
    proc.on('error', e => rpc.ended(null, e.message));
    proc.on('exit', code => rpc.ended(code, ''));
    proc.stdin?.on('error', e => log(o.tag ?? 'codex', 'stdin', e.message));
    return rpc;
  }

  /** One JSON message per websocket text frame. `proc` is the server process, when this client owns it. */
  static overWebSocket(ws: WebSocket, proc?: ChildProcess): Rpc {
    const rpc = new Rpc(line => ws.send(line), () => { ws.close(); proc?.kill(); });
    ws.addEventListener('message', e => rpc.feed(String(e.data) + '\n'));
    ws.addEventListener('close', e => rpc.ended(e.code, e.reason || 'The Codex app-server connection closed.'));
    ws.addEventListener('error', () => rpc.ended(null, 'The Codex app-server connection failed.'));
    proc?.stderr?.on('data', d => { rpc.stderr = (rpc.stderr + String(d)).slice(-4000); });
    proc?.on('exit', code => rpc.ended(code, ''));
    return rpc;
  }

  get alive() { return !this.closed; }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new RpcClosed(`${this.o.tag === 'agy' ? 'Antigravity' : 'Codex app-server'} is not running`));
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, method });
      this.write({ id, method, params });
    });
  }

  notify(method: string, params?: unknown) { this.write(params === undefined ? { method } : { method, params }); }

  kill() { if (!this.closed) this.stop(); }

  private write(o: object) {
    if (this.closed) return;
    try { this.out(JSON.stringify(this.o.strict ? { jsonrpc: '2.0', ...o } : o)); } catch (e) { log(this.o.tag ?? 'codex', 'write', e); }
  }

  feed(d: string) {
    this.buf += d;
    let i: number;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg: { id?: Id; method?: string; params?: unknown; result?: unknown; error?: RpcError };
      try { msg = JSON.parse(line); } catch { log(this.o.tag ?? 'codex', 'bad line', line.slice(0, 200)); continue; }
      this.dispatch(msg);
    }
  }

  private dispatch(msg: { id?: Id; method?: string; params?: unknown; result?: unknown; error?: RpcError }) {
    if (msg.method && msg.id != null) {
      const id = msg.id;
      this.onRequest(msg.method, msg.params, id).then(
        result => this.write({ id, result: result ?? {} }),
        e => this.write({ id, error: { code: (e as RpcError)?.code ?? -32603, message: (e as RpcError)?.message ?? String(e) } }),
      );
    } else if (msg.method) {
      try { this.onNotify(msg.method, msg.params); } catch (e) { log(this.o.tag ?? 'codex', 'notify handler', msg.method, e); }
    } else if (msg.id != null) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code, data: msg.error.data, method: p.method }));
      else p.resolve(msg.result);
    }
  }

  ended(code: number | null, reason: string) {
    if (this.closed) return;
    this.closed = true;
    const why = reason || this.stderr.trim().split('\n').slice(-3).join('\n') || `exited with code ${code}`;
    for (const p of this.pending.values()) p.reject(new RpcClosed(why));
    this.pending.clear();
    this.onExit(code, why);
  }
}

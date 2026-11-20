// Following a file another process appends to (a harness transcript): new complete lines as they land.
//   LineSplitter  bytes in, whole lines out; a partial last line waits for its newline (pure, for tests)
//   LocalTail     this computer: fs.watch plus a short stat poll (fs.watch drops or merges events on Windows and
//                 network drives), reading from a byte offset; a shrunk or replaced file starts over
//   RemoteTail    an SSH machine: one long-lived `tail -c +N -F` per file, restarted from the offset when the link drops
import { watch, type FSWatcher } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import type { ChildProcess } from 'node:child_process';
import type { Machine } from '../shared/types';
import { spawnOn } from './exec';

export interface TailSink {
  /** Complete lines, in order, without their newline. */
  lines(lines: string[]): void;
  /** The file was truncated or replaced: what was read before no longer describes it. Lines follow from its start. */
  reset(): void;
}

/** Splits a byte stream into lines. Works on bytes so a multi-byte character cut between two reads stays whole. */
export class LineSplitter {
  private rest: Buffer = Buffer.alloc(0);
  push(chunk: Buffer): string[] {
    const buf = this.rest.length ? Buffer.concat([this.rest, chunk]) : chunk;
    const out: string[] = [];
    let start = 0;
    for (let i = buf.indexOf(10); i >= 0; i = buf.indexOf(10, start)) {
      const line = buf.toString('utf8', start, i).replace(/\r$/, '');
      if (line) out.push(line);
      start = i + 1;
    }
    this.rest = Buffer.from(buf.subarray(start));
    return out;
  }
  /** Bytes waiting for a newline. */
  get pending() { return this.rest.length; }
  reset() { this.rest = Buffer.alloc(0); }
}

const CHUNK = 1 << 20;

export class LocalTail {
  private split = new LineSplitter();
  private watcher: FSWatcher | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private again = false;
  private ino: number | null = null;
  private stopped = false;

  /** `offset`: bytes already read (they ended with a whole line). `poll`: ms between stat checks. */
  constructor(readonly file: string, public offset: number, private sink: TailSink, o: { poll?: number; watch?: boolean } = {}) {
    if (o.watch !== false) {
      try { this.watcher = watch(this.file, { persistent: false }, () => this.kick()); this.watcher.on('error', () => this.unwatch()); }
      catch { this.watcher = null; }
    }
    // without a watcher the poll is all there is, so it runs faster
    this.timer = setInterval(() => this.kick(), o.poll ?? (this.watcher ? 2000 : 700));
    this.timer.unref?.();
    void stat(this.file).then(s => { if (this.ino == null) this.ino = s.ino; }, () => {});
  }

  /** Look now (the file changed, or someone thinks it might have). Calls are coalesced. */
  kick() {
    if (this.stopped) return;
    if (this.busy) { this.again = true; return; }
    this.busy = true;
    void this.check().finally(() => { this.busy = false; if (this.again) { this.again = false; this.kick(); } });
  }

  /** Resolves once everything written so far has been delivered. */
  async drain() { while (this.busy) await new Promise(r => setTimeout(r, 5)); this.busy = true; try { await this.check(); } finally { this.busy = false; } }

  private async check() {
    let s;
    try { s = await stat(this.file); } catch { return; }   // gone for now (being replaced): try again next time
    // replaced (a new inode: rotation, or an editor's save-as) or shrunk: start over from the top
    if ((this.ino != null && s.ino !== this.ino && s.ino !== 0) || s.size < this.offset) {
      this.offset = 0; this.split.reset(); this.sink.reset();
    }
    this.ino = s.ino;
    if (s.size <= this.offset) return;
    const fh = await open(this.file, 'r').catch(() => null);
    if (!fh) return;
    try {
      while (this.offset < s.size && !this.stopped) {
        const buf = Buffer.alloc(Math.min(CHUNK, s.size - this.offset));
        const { bytesRead } = await fh.read(buf, 0, buf.length, this.offset);
        if (!bytesRead) break;
        this.offset += bytesRead;
        const lines = this.split.push(buf.subarray(0, bytesRead));
        if (lines.length) this.sink.lines(lines);
      }
    } finally { await fh.close().catch(() => {}); }
  }

  private unwatch() { this.watcher?.close(); this.watcher = null; }
  stop() { this.stopped = true; this.unwatch(); if (this.timer) clearInterval(this.timer); this.timer = null; }
}

/** `tail -c +N -F` over ssh: one connection for as long as the file is followed. GNU, BSD and busybox tail all
 *  take these flags. On truncation GNU tail says so on stderr and prints the file from its start. */
export class RemoteTail {
  private split = new LineSplitter();
  private p: ChildProcess | null = null;
  private stopped = false;
  private retry: ReturnType<typeof setTimeout> | null = null;

  constructor(private m: Machine, readonly file: string, public offset: number, private sink: TailSink, private o: { retryMs?: number; spawn?: typeof spawnOn } = {}) {
    this.start();
  }

  private start() {
    if (this.stopped) return;
    this.split.reset();
    const p = (this.o.spawn ?? spawnOn)(this.m, ['tail', '-c', `+${this.offset + 1}`, '-F', this.file], { stdio: ['ignore', 'pipe', 'pipe'] });
    this.p = p;
    p.stdout?.on('data', (b: Buffer) => {
      // only whole lines move the offset, so a restart never begins mid-line
      const before = this.split.pending;
      const lines = this.split.push(b);
      this.offset += before + b.length - this.split.pending;
      if (lines.length) this.sink.lines(lines);
    });
    p.stderr?.setEncoding('utf8');
    p.stderr?.on('data', (s: string) => { if (/truncated/i.test(s)) { this.offset = 0; this.split.reset(); this.sink.reset(); } });
    p.on('error', () => {});
    p.on('close', () => {
      if (this.p !== p || this.stopped) return;
      this.p = null;
      this.retry = setTimeout(() => this.start(), this.o.retryMs ?? 5000);
    });
  }

  stop() { this.stopped = true; if (this.retry) clearTimeout(this.retry); this.p?.kill(); this.p = null; }
}

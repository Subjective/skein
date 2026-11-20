// Shell detection (mockup scene "detect"): a harness TUI started by hand in a plain shell tab becomes a thread.
// The pty's process tree says what runs in it: we list this computer's processes and look under the shell for
// `claude` or `codex` (the native binaries, or the npm builds run by node). Only this computer's processes can
// be seen; an SSH shell's program runs on the other machine (the renderer falls back to Claude Code's title).
import { readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { execFile } from 'node:child_process';
import type { Harness } from '../shared/types';

export interface Proc { pid: number; ppid: number; cmd: string }

/** What a command line runs, if it is a harness TUI (not `--help`, `--version`, print mode or `codex exec`). */
export function harnessOf(cmd: string): Harness | null {
  const argv = cmd.trim().split(/\s+/);
  const exe = (argv[0] || '').replace(/^.*[\\/]/, '').replace(/\.(exe|cmd|js)$/i, '').toLowerCase();
  let h: Harness | null = null, rest = argv.slice(1);
  if (exe === 'claude') h = 'claude';
  else if (exe === 'codex' || /^codex-(x86_64|aarch64)/.test(exe)) h = 'codex';
  else if (/^node$|^bun$/.test(exe)) {
    // the npm builds: node .../@anthropic-ai/claude-code/cli.js, node .../@openai/codex/bin/codex.js
    const i = argv.findIndex(a => /@anthropic-ai[\\/]claude-code|[\\/]claude(\.js)?$/i.test(a) || /@openai[\\/]codex|[\\/]codex(\.js)?$/i.test(a));
    if (i > 0) { h = /claude/i.test(argv[i]) ? 'claude' : 'codex'; rest = argv.slice(i + 1); }
  }
  if (!h) return null;
  if (rest.some(a => /^(-p|--print|-h|--help|-v|--version)$/.test(a))) return null;
  if (h === 'codex' && /^(exec|e|login|logout|mcp|apply|completion|app-server|mcp-server|proto|debug)$/.test(rest.find(a => !a.startsWith('-')) || '')) return null;
  if (h === 'claude' && /^(mcp|config|doctor|update|install|setup-token|migrate-installer)$/.test(rest.find(a => !a.startsWith('-')) || '')) return null;
  return h;
}

/** The harness running under `root` (a shell's pid), nearest first. Pure, for tests. */
export function harnessUnder(procs: Proc[], root: number): { harness: Harness; pid: number } | null {
  const kids = new Map<number, Proc[]>();
  for (const p of procs) { if (!kids.has(p.ppid)) kids.set(p.ppid, []); kids.get(p.ppid)!.push(p); }
  const seen = new Set<number>([root]);
  let level = kids.get(root) || [];
  while (level.length) {
    for (const p of level) { const h = harnessOf(p.cmd); if (h) return { harness: h, pid: p.pid }; }
    level = level.flatMap(p => (seen.has(p.pid) ? [] : (seen.add(p.pid), kids.get(p.pid) || [])));
  }
  return null;
}

/** Every process on this computer: pid, parent and command line. */
export async function listProcs(): Promise<Proc[]> {
  if (process.platform === 'linux') {
    const out: Proc[] = [];
    for (const d of readdirSync('/proc')) {
      if (!/^\d+$/.test(d)) continue;
      try {
        const stat = readFileSync(`/proc/${d}/stat`, 'utf8'), ppid = +stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1];
        const cmd = readFileSync(`/proc/${d}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ');
        out.push({ pid: +d, ppid, cmd });
      } catch { /* gone */ }
    }
    return out;
  }
  if (process.platform === 'win32') {
    const ps = 'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CommandLine,Name | ForEach-Object { "$($_.ProcessId)`t$($_.ParentProcessId)`t$(if ($_.CommandLine) { $_.CommandLine } else { $_.Name })" }';
    const out = await new Promise<string>(res => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, maxBuffer: 8 << 20 }, (_e, so) => res(String(so || ''))));
    return out.split(/\r?\n/).flatMap(l => { const [a, b, ...c] = l.split('\t'); return a && b ? [{ pid: +a, ppid: +b, cmd: winArgv0(c.join('\t')) }] : []; });
  }
  const out = await new Promise<string>(res => execFile('ps', ['-axo', 'pid=,ppid=,command='], { maxBuffer: 8 << 20 }, (_e, so) => res(String(so || ''))));
  return out.split('\n').flatMap(l => { const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l); return m ? [{ pid: +m[1], ppid: +m[2], cmd: m[3] }] : []; });
}
/** A Windows command line starts with a quoted path that may hold spaces: unquote it so argv[0] splits cleanly. */
const winArgv0 = (c: string) => c.replace(/^"([^"]*)"/, (_m, p: string) => p.replace(/ /g, ' ')).replace(/ /g, '_');

/** The working folder of a process on this computer, when the platform tells it cheaply (Linux). */
export function cwdOf(pid: number): string | undefined {
  if (process.platform !== 'linux') return undefined;
  try { return readlinkSync(`/proc/${pid}/cwd`); } catch { return undefined; }
}

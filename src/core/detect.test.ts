import { describe, expect, it } from 'vitest';
import { harnessOf, harnessUnder } from './detect';

describe('shell detection', () => {
  it('knows the harness TUIs, native or run by node', () => {
    expect(harnessOf('claude')).toBe('claude');
    expect(harnessOf('/home/me/.local/bin/claude --model opus')).toBe('claude');
    expect(harnessOf('node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js')).toBe('claude');
    expect(harnessOf('C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd')).toBe('codex');
    expect(harnessOf('/usr/lib/node_modules/@openai/codex/vendor/x86_64-unknown-linux-musl/codex/codex resume')).toBe('codex');
    expect(harnessOf('node /usr/bin/codex')).toBe('codex');
  });
  it('skips one-shot runs and other programs', () => {
    expect(harnessOf('claude -p "hi"')).toBeNull();
    expect(harnessOf('claude --version')).toBeNull();
    expect(harnessOf('claude mcp list')).toBeNull();
    expect(harnessOf('codex exec "do it"')).toBeNull();
    expect(harnessOf('vim claude.md')).toBeNull();
    expect(harnessOf('node server.js')).toBeNull();
  });
  it('looks under the shell only, nearest first', () => {
    const procs = [
      { pid: 10, ppid: 1, cmd: '/bin/zsh -l' }, { pid: 11, ppid: 10, cmd: 'npm exec' }, { pid: 12, ppid: 11, cmd: 'codex' },
      { pid: 20, ppid: 1, cmd: 'claude' },
    ];
    expect(harnessUnder(procs, 10)).toEqual({ harness: 'codex', pid: 12 });
    expect(harnessUnder(procs, 99)).toBeNull();
  });
});

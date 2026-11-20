import { describe, expect, it } from 'vitest';
import type { AuthPrompt, Machine } from '@shared/types';
import { linkText } from '../ui/LinkNote';
import { authCopy } from './AuthDialog';

const P = (x: Partial<AuthPrompt>): AuthPrompt => ({ machine: 'dev', id: 'p', kind: 'other', text: '', secret: true, ...x });
const dev = { name: 'devbox', home: '/home/me' };

describe('SSH sign-in dialog copy', () => {
  it('names the key with ~ for the local home', () => {
    const c = authCopy(P({ kind: 'passphrase', text: "Enter passphrase for key '/Users/j/.ssh/id_ed25519': " }), dev, '/Users/j');
    expect(c).toMatchObject({ title: 'Unlock your key for devbox', label: 'Passphrase for ~/.ssh/id_ed25519', ok: 'Connect' });
    expect(authCopy(P({ kind: 'passphrase', text: "Enter passphrase for key 'C:\\Users\\j/.ssh/id_ed25519': " }), dev, 'C:\\Users\\j').label).toBe('Passphrase for ~/.ssh/id_ed25519');
  });
  it('says whose password', () => {
    expect(authCopy(P({ kind: 'password', text: "me@devbox's password: " }), dev).label).toBe('Password for me@devbox');
  });
  it('asks to trust a new host key', () => {
    expect(authCopy(P({ kind: 'hostkey', host: 'devbox (10.0.0.5)', secret: false }), dev)).toMatchObject({ title: 'First connection to devbox', ok: 'Trust and connect', label: '' });
  });
  it('shows a verification prompt as ssh wrote it', () => {
    expect(authCopy(P({ kind: 'code', text: 'Verification code: ', secret: false }), dev)).toMatchObject({ title: 'Verify it’s you on devbox', label: 'Verification code' });
  });
});

describe('link note', () => {
  const M = (x: Partial<Machine>): Machine => ({ id: 'dev', name: 'devbox', ssh: { host: 'devbox' }, link: 'up', has: [], ...x });
  it('says nothing while up, or for this computer', () => {
    expect(linkText(M({}))).toBeNull();
    expect(linkText({ id: 'local', name: 'This PC', link: 'up', has: [] })).toBeNull();
  });
  it('only promises the turn keeps running when something keeps it running', () => {
    expect(linkText(M({ link: 'reconnecting', persist: 'tmux' }))!.text).toBe('Reconnecting to {}. The turn keeps running there.');
    expect(linkText(M({ link: 'reconnecting' }))!.text).toBe('Reconnecting to {}.');
  });
  it('pulses amber while connecting, solid amber when it needs you, red with Connect when down', () => {
    expect(linkText(M({ link: 'connecting' }))).toMatchObject({ dot: 'amber', pulse: true, connect: false });
    expect(linkText(M({ link: 'auth' }))).toMatchObject({ dot: 'amber', pulse: false });
    expect(linkText(M({ link: 'down', note: 'No answer from devbox' }))).toMatchObject({ dot: 'red', connect: true, text: '{} is not connected: No answer from devbox' });
  });
});

import { describe, expect, it } from 'vitest';
import { display, hostOf, isLocalHost, normalize, portOf, withPort } from './address';

describe('address bar', () => {
  it('reads a bare port or localhost as a dev server', () => {
    expect(normalize('5173')).toBe('http://localhost:5173/');
    expect(normalize(' 5173 ')).toBe('http://localhost:5173/');
    expect(normalize(':3000/api')).toBe('http://localhost:3000/api');
    expect(normalize('localhost:5173')).toBe('http://localhost:5173/');
    expect(normalize('localhost:5173/docs?q=1#x')).toBe('http://localhost:5173/docs?q=1#x');
    expect(normalize('localhost')).toBe('http://localhost/');
    expect(normalize('127.0.0.1:8080')).toBe('http://127.0.0.1:8080/');
    expect(normalize('0.0.0.0:8000')).toBe('http://0.0.0.0:8000/');
    expect(normalize('[::1]:5173')).toBe('http://[::1]:5173/');
    expect(normalize('192.168.1.20:3000')).toBe('http://192.168.1.20:3000/');
    expect(normalize('devbox:3000')).toBe('http://devbox:3000/');
  });
  it('keeps http(s) as typed and gives a domain https', () => {
    expect(normalize('http://localhost:5173/x')).toBe('http://localhost:5173/x');
    expect(normalize('HTTPS://Example.com')).toBe('https://example.com/');
    expect(normalize('example.com/docs')).toBe('https://example.com/docs');
  });
  it('refuses what is not a web address', () => {
    for (const s of ['', '   ', 'hello world', 'file:///etc/passwd', 'javascript:alert(1)', 'about:blank', 'mailto:a@b.c', 'ftp://x.org', 'notahost', '0', '70000', 'localhost:99999'])
      expect(normalize(s), s).toBeNull();
  });
  it('shows addresses without http:// and a lone slash', () => {
    expect(display('http://localhost:5173/')).toBe('localhost:5173');
    expect(display('http://localhost:5173/a/')).toBe('localhost:5173/a/');
    expect(display('https://example.com/')).toBe('https://example.com');
    expect(display('')).toBe('');
  });
  it('knows local hosts, ports, and moves a URL to another port', () => {
    expect(isLocalHost('localhost') && isLocalHost('127.0.0.1') && isLocalHost('[::1]') && isLocalHost('0.0.0.0')).toBe(true);
    expect(isLocalHost('example.com')).toBe(false);
    expect(hostOf('http://localhost:5173/x')).toBe('localhost:5173');
    expect(portOf('http://localhost/')).toBe(80);
    expect(portOf('https://x.org/')).toBe(443);
    expect(portOf('http://localhost:5173/')).toBe(5173);
    expect(withPort('http://127.0.0.1:5173/a?b#c', 41000)).toBe('http://localhost:41000/a?b#c');
    expect(withPort('http://localhost:41000/a', 5173, '127.0.0.1')).toBe('http://127.0.0.1:5173/a');
  });
});

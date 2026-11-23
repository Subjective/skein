// How long something took, as the app shows it everywhere: 42s, 1m 6s, 1h 5m. No zero padding (Josh, 2026-11-23).
export const dur = (ms: number): string => {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
};

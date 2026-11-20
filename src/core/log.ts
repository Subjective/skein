// Plain logging to stderr; visible in the terminal that ran `pnpm dev` / `pnpm start`.
export const log = (scope: string, ...a: unknown[]) => console.error(`[skein:${scope}]`, ...a);

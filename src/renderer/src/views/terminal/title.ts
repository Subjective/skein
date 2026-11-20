// A TUI's terminal title tells us two things: what the thread is about (Claude Code titles the terminal
// with a summary) and whether it is working (a spinner glyph in front). Codex prints its own title too.
// Claude Code keeps a ✳ in front while idle and cycles ◐◓◑◒ while working, so ✳ alone means idle.
export const SPIN = /^[\u2800-\u28ff\u2730-\u273f\u00b7*✳✻✽✶✢·◐◓◑◒⠁-⣿]\s*/;
const IDLE = /^✳\s/;

/** Whether a harness's terminal title says a turn is running. */
export const titleRunning = (raw: string) => SPIN.test(raw) && !IDLE.test(raw);

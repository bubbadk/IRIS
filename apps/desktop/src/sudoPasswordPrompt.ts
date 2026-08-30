// Bridges the (non-React) Janitor tool to a React password popup. The tool calls
// requestSudoPassword() and awaits it; App.tsx renders a modal while a request is
// pending and resolves it via resolveSudoPasswordRequest() when the user submits or
// cancels. This exists so a local `sudo` command asks for its password in the IRIS
// window instead of blocking on a terminal nobody is watching.

export interface SudoPasswordRequest {
  /** What the user is about to run, shown in the popup for context. */
  command: string;
}

type Resolver = (password: string | null) => void;

let pending: { request: SudoPasswordRequest; resolve: Resolver } | null = null;
let listeners: Array<(pending: SudoPasswordRequest | null) => void> = [];

export function onSudoPasswordRequestChange(
  listener: (pending: SudoPasswordRequest | null) => void,
): () => void {
  listeners.push(listener);
  return () => {
    listeners = listeners.filter((entry) => entry !== listener);
  };
}

function notify(): void {
  const current = pending?.request ?? null;
  listeners.forEach((listener) => listener(current));
}

/** Resolves to the entered password, or null if the user cancelled. */
export function requestSudoPassword(command: string): Promise<string | null> {
  if (pending) {
    // Only one Janitor command runs at a time in practice; refuse a second concurrent
    // prompt rather than silently dropping the first one.
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    pending = { request: { command }, resolve };
    notify();
  });
}

export function resolveSudoPasswordRequest(password: string | null): void {
  const current = pending;
  pending = null;
  notify();
  current?.resolve(password);
}

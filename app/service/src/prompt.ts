// A line read from the terminal without showing it (the demo account's password: `demo:seed`, src/cli.ts). The keys are
// read in raw mode; `readKeys` decides what each one does, so the rule is tested without a terminal.

export interface KeyState {
  text: string;
  /** Inside an escape sequence (an arrow key sends ESC [ A): 1 after ESC, 2 after ESC [ or ESC O until its final byte. */
  escape: 0 | 1 | 2;
}

/**
 * The state after `chunk`, and whether Enter ended the line (`done`) or Ctrl-C stopped it (`cancelled`); what follows either
 * is not read. Printable characters are typed; Backspace removes one; escape sequences (arrows, Home, Delete) and every other
 * control character add nothing.
 */
export function readKeys(state: KeyState, chunk: string): { state: KeyState; outcome: "typing" | "done" | "cancelled" } {
  let { text, escape } = state;
  for (const ch of chunk) {
    if (escape === 1) {
      escape = ch === "[" || ch === "O" ? 2 : 0;
      continue;
    }
    if (escape === 2) {
      if (ch >= "@" && ch <= "~") escape = 0;
      continue;
    }
    if (ch === "\u001b") escape = 1;
    else if (ch === "\r" || ch === "\n") return { state: { text, escape }, outcome: "done" };
    else if (ch === "\u0003") return { state: { text, escape }, outcome: "cancelled" };
    else if (ch === "\u007f" || ch === "\b") text = [...text].slice(0, -1).join("");
    else if (ch >= " ") text += ch;
  }
  return { state: { text, escape }, outcome: "typing" };
}

/** Asks `question` on the terminal and reads a line without echoing it. Ctrl-C ends the process (130). */
export function askHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let state: KeyState = { text: "", escape: 0 };
    const finish = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      process.stdout.write("\n");
    };
    const onData = (chunk: string) => {
      const r = readKeys(state, chunk);
      state = r.state;
      if (r.outcome === "typing") return;
      finish();
      if (r.outcome === "cancelled") process.exit(130);
      resolve(state.text);
    };
    stdin.on("data", onData);
  });
}

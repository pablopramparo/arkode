/**
 * Reads a password from an interactive terminal with the input hidden.
 * Refuses (throws) when there is no TTY — the same "unattended context
 * declines what needs a human" stance as confirmHostInteractively. The
 * value is never read from argv or an env var.
 */
export function promptPassword(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    return Promise.reject(
      new Error('A master password is required, but this is not an interactive terminal. Run the command from a real console.')
    );
  }

  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const stdout = process.stdout;
    stdout.write(prompt);

    let value = '';
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    const cleanup = () => {
      stdin.setRawMode(wasRaw);
      stdin.pause();
      stdin.removeListener('data', onData);
      stdout.write('\n');
    };

    const onData = (chunk: string) => {
      for (const ch of chunk) {
        const code = ch.charCodeAt(0);
        if (code === 13 || code === 10 || code === 4) {
          // Enter / newline / Ctrl-D — done.
          cleanup();
          resolve(value);
          return;
        }
        if (code === 3) {
          // Ctrl-C — abort.
          cleanup();
          reject(new Error('Aborted.'));
          return;
        }
        if (code === 127 || code === 8) {
          // Backspace / DEL.
          value = value.slice(0, -1);
          continue;
        }
        // Ignore other control characters; keep everything printable.
        if (code >= 32) value += ch;
      }
    };

    stdin.on('data', onData);
  });
}

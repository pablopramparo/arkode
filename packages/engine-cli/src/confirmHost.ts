import { createInterface } from 'node:readline/promises';

/**
 * Interactive host-key confirmation for a terminal session. Never auto-
 * accepts — a "no"/empty answer or non-interactive stdin both reject.
 */
export async function confirmHostInteractively(presented: { keyType: string; fingerprintSha256: string }): Promise<boolean> {
  if (!process.stdin.isTTY) {
    process.stderr.write(
      `Refusing unknown host (${presented.keyType} ${presented.fingerprintSha256}) — no interactive terminal to confirm it.\n`
    );
    return false;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(
      `Unknown host key presented:\n  type: ${presented.keyType}\n  fingerprint (sha256): ${presented.fingerprintSha256}\nTrust this host? [y/N] `
    );
    return answer.trim().toLowerCase() === 'y';
  } finally {
    rl.close();
  }
}

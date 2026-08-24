import { describe, expect, it } from 'vitest';
import { redactPassword } from '../../src/scheduler/windowsTaskScheduler.js';

describe('redactPassword', () => {
  it('removes every occurrence of the password from an error message', () => {
    const message =
      'Command failed: schtasks.exe /Create /TN X /RU user /RP hunter2 /F\nError: hunter2 was rejected';
    expect(redactPassword(message, 'hunter2')).toBe(
      'Command failed: schtasks.exe /Create /TN X /RU user /RP [redacted] /F\nError: [redacted] was rejected'
    );
  });

  it('leaves the message untouched if the password does not appear in it', () => {
    const message = 'Access denied.';
    expect(redactPassword(message, 'hunter2')).toBe('Access denied.');
  });
});

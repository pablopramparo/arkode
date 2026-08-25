import { describe, expect, it } from 'vitest';
import { buildTaskDefinitionXml } from '../../src/scheduler/taskDefinitionXml.js';

describe('buildTaskDefinitionXml', () => {
  it('includes both a CalendarTrigger at the given time and a catch-up LogonTrigger', () => {
    const xml = buildTaskDefinitionXml({
      description: 'test',
      scheduleTime: '03:00',
      command: 'C:\\node.exe',
      arguments: '"C:\\index.js" run-due',
    });

    expect(xml).toContain('<CalendarTrigger>');
    expect(xml).toMatch(/<StartBoundary>\d{4}-\d{2}-\d{2}T03:00:00<\/StartBoundary>/);
    expect(xml).toContain('<LogonTrigger>');
    expect(xml).toContain('<Delay>PT2M</Delay>');
  });

  it('runs as SYSTEM (by SID, not the literal name) with no LogonType, so no credentials are ever needed', () => {
    const xml = buildTaskDefinitionXml({
      description: 'test',
      scheduleTime: '03:00',
      command: 'C:\\node.exe',
      arguments: 'run-due',
    });
    expect(xml).toContain('<UserId>S-1-5-18</UserId>');
    expect(xml).toContain('<RunLevel>HighestAvailable</RunLevel>');
    expect(xml).not.toContain('<LogonType>');
    expect(xml).not.toContain('Password');
    expect(xml).not.toContain('S4U');
  });

  it('tolerates missed slots and never runs two instances at once', () => {
    const xml = buildTaskDefinitionXml({
      description: 'test',
      scheduleTime: '03:00',
      command: 'C:\\node.exe',
      arguments: 'run-due',
    });
    expect(xml).toContain('<StartWhenAvailable>true</StartWhenAvailable>');
    expect(xml).toContain('<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>');
  });

  it('escapes XML-significant characters in free-form fields', () => {
    const xml = buildTaskDefinitionXml({
      description: 'Client "Winners" & <special>',
      scheduleTime: '03:00',
      command: 'C:\\node.exe',
      arguments: '"C:\\some path\\index.js" run-due --task abc',
    });
    expect(xml).toContain('Client &quot;Winners&quot; &amp; &lt;special&gt;');
    expect(xml).not.toContain('<special>');
  });
});

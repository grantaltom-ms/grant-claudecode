import { describe, it, expect } from 'vitest';
import { selectedTasks, tasksForRun, TASKS, SENT_MAIL_TASK, CONTEXT_CARD_TASK, ALL_TASKS } from '../pages/api/memory-maintenance';

const ROTATION_NAMES = TASKS.map(t => t.name);

describe('memory-maintenance task selection', () => {
  it('includes backfill_sent_mail in every default daily run, regardless of which task the rotation picked', () => {
    const tasks = tasksForRun({ query: {} });
    expect(tasks.some(t => t.name === SENT_MAIL_TASK.name)).toBe(true);
  });

  it('includes context_cards in every default daily run', () => {
    const tasks = tasksForRun({ query: {} });
    expect(tasks.some(t => t.name === CONTEXT_CARD_TASK.name)).toBe(true);
  });

  it("the rotated task itself is always one of the round-robin TASKS' names", () => {
    const tasks = tasksForRun({ query: {} });
    const rotated = tasks.find(t => t.name !== SENT_MAIL_TASK.name && t.name !== CONTEXT_CARD_TASK.name);
    // If the rotation happened to land on context_cards itself, there's no
    // separate "rotated" entry left after excluding both always-appended
    // names -- that's expected, not a bug.
    if (rotated) expect(ROTATION_NAMES).toContain(rotated.name);
  });

  it('skip_sent_mail=1 omits backfill_sent_mail but keeps context_cards', () => {
    const tasks = tasksForRun({ query: { skip_sent_mail: '1' } });
    expect(tasks.some(t => t.name === SENT_MAIL_TASK.name)).toBe(false);
    expect(tasks.some(t => t.name === CONTEXT_CARD_TASK.name)).toBe(true);
  });

  it('skip_context_cards=1 omits context_cards but keeps backfill_sent_mail', () => {
    const tasks = tasksForRun({ query: { skip_context_cards: '1' } });
    expect(tasks.some(t => t.name === CONTEXT_CARD_TASK.name)).toBe(false);
    expect(tasks.some(t => t.name === SENT_MAIL_TASK.name)).toBe(true);
  });

  it('?task=backfill_sent_mail resolves the sent-mail task individually', () => {
    const tasks = tasksForRun({ query: { task: 'backfill_sent_mail' } });
    expect(tasks.some(t => t.name === SENT_MAIL_TASK.name)).toBe(true);
  });

  it('?all=1 resolves every task exactly once, with no duplicates', () => {
    const tasks = selectedTasks({ query: { all: '1' } });
    expect(tasks).toEqual(ALL_TASKS);
    const names = tasks.map(t => t.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain('backfill_sent_mail');
    expect(names).toContain('context_cards');
  });

  it('an unknown ?task= still resolves to an empty list (400 error path), not silently padded with always-appended tasks', () => {
    const tasks = tasksForRun({ query: { task: 'does_not_exist' } });
    expect(tasks).toEqual([]);
  });

  it("the other 10 rotated tasks' composition is unaffected by pulling sent-mail out of the rotation", () => {
    expect(TASKS.map(t => t.name)).not.toContain('backfill_sent_mail');
    expect(TASKS).toHaveLength(10);
  });
});

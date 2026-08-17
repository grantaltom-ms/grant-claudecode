import { describe, it, expect } from 'vitest';
import { formatResolvedMessage, buildConversationHistory } from '../../lib/comply-blocks';

const BOT = 'U_BOT';
const DRAFT =
  'Section 2 - Draft:\n\nOn August 16, 2026, management observed an unapproved golden retriever in Unit C - 02.';
const QUESTION = 'Which staff member should be listed on this notice?\n1. Gregory\n2. Someone else';

describe('button-resolved messages keep their text in conversation history', () => {
  it('keeps the approved draft and appends the outcome', () => {
    const resolved = formatResolvedMessage(
      `${DRAFT}APPROVE_OR_REVISE`,
      '✅ *Approved by grant*',
      '✅ *grant* approved this section.'
    );

    expect(resolved).toContain('unapproved golden retriever');
    expect(resolved).toContain('✅ *Approved by grant*');
    expect(resolved).not.toContain('APPROVE_OR_REVISE');
  });

  it('keeps the question text when a choice button is used', () => {
    const resolved = formatResolvedMessage(
      QUESTION,
      '✅ *grant* selected: 1. Gregory',
      '✅ *grant* selected: 1. Gregory'
    );

    expect(resolved).toContain('Which staff member');
    expect(resolved).toContain('selected: 1. Gregory');
  });

  it('falls back to the bare confirmation when the message had no text', () => {
    expect(formatResolvedMessage('', '✅ approved', 'fallback text')).toBe('fallback text');
  });

  // The regression: approvals used to replace the draft with a bare confirmation. Because
  // history is rebuilt from the thread, successive approvals then read as a run of identical
  // assistant turns with no drafts in them, and the bot restarted the interview.
  it('leaves each approved section distinguishable after several approvals', () => {
    const section = (n) => `Section ${n} - Draft:\n\nBody of section ${n}.`;
    const threadMessages = [1, 2, 3].map((n) => ({
      user: BOT,
      ts: `${n}.0`,
      text: formatResolvedMessage(
        `${section(n)}APPROVE_OR_REVISE`,
        '✅ *Approved by grant*',
        '✅ *grant* approved this section.'
      ),
    }));

    const history = buildConversationHistory(threadMessages, BOT);
    const transcript = history.map((h) => h.content).join('\n');

    for (const n of [1, 2, 3]) {
      expect(transcript).toContain(`Body of section ${n}.`);
    }
  });
});

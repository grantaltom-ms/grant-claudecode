// lib/comply-blocks.js
// Block Kit builders for the Comply-or-Vacate bot.
// Called after runAgent() to optionally wrap plain-text responses in interactive blocks.

const MAX_SECTION_TEXT_LENGTH = 2900;

function buildMarkdownSectionBlocks(text) {
  const normalizedText = (text || '').trim() || ' ';
  const blocks = [];

  for (let i = 0; i < normalizedText.length; i += MAX_SECTION_TEXT_LENGTH) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: normalizedText.slice(i, i + MAX_SECTION_TEXT_LENGTH),
      },
    });
  }

  return blocks;
}

/**
 * Detect a numbered choice list in the agent's text and build Block Kit button blocks.
 * Returns null if the text is not a choice prompt.
 *
 * Pattern: 2+ lines matching /^\d+\.\s+.+$/ with avg length <= 120 chars.
 * Skips section drafts (those use buildApprovalBlocks instead).
 */
export function buildChoiceBlocks(text, threadTs) {
  // Section drafts use the APPROVE_OR_REVISE sentinel — skip those here
  if (text.includes('APPROVE_OR_REVISE')) return null;

  const lines = text.split('\n');
  const choices = [];
  let questionEndIdx = -1;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    const match = trimmed.match(/^(\d+)\.\s+(.+)$/);
    if (match) {
      if (choices.length === 0) questionEndIdx = i;
      choices.push({ number: parseInt(match[1], 10), text: match[2].trim() });
    }
  }

  // Need at least 2 choices
  if (choices.length < 2) return null;

  // All choices must be short (options, not legal prose)
  if (choices.some((c) => c.text.length > 120)) return null;

  // Build question text (everything before the first numbered item)
  const questionLines = lines
    .slice(0, questionEndIdx)
    .map((l) => l.trim())
    .filter(Boolean);
  const questionText = questionLines.join('\n') || text;

  const blocks = buildMarkdownSectionBlocks(questionText);

  // Create button elements — max 5 per actions block
  const elements = choices.map((c) => ({
    type: 'button',
    text: {
      type: 'plain_text',
      text: c.text.length > 75 ? c.text.slice(0, 72) + '…' : c.text,
      emoji: true,
    },
    action_id: 'comply_choice',
    value: JSON.stringify({ choiceText: `${c.number}. ${c.text}`, threadTs }),
  }));

  for (let i = 0; i < elements.length; i += 5) {
    blocks.push({ type: 'actions', elements: elements.slice(i, i + 5) });
  }

  return blocks;
}

/**
 * Detect the APPROVE_OR_REVISE sentinel the agent appends to section drafts.
 * Strips the sentinel and returns Block Kit blocks with Approve / Request changes buttons.
 * Returns null if the sentinel is not present.
 */
export function buildApprovalBlocks(text, threadTs) {
  if (!text.includes('APPROVE_OR_REVISE')) return null;

  const cleanText = text.replace(/APPROVE_OR_REVISE/g, '').trim();

  const blocks = [
    ...buildMarkdownSectionBlocks(cleanText),
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '✅ Approve', emoji: true },
          action_id: 'comply_approve',
          style: 'primary',
          value: JSON.stringify({ threadTs }),
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '✏️ Request changes', emoji: true },
          action_id: 'comply_revise',
          value: JSON.stringify({ threadTs }),
        },
      ],
    },
  ];

  return blocks;
}

/**
 * Build history-reconstruction-friendly conversation history from Slack thread messages.
 * Bot messages prefixed with [USER_CHOICE] are treated as user role.
 */
export function buildConversationHistory(threadMessages, botUserId, skipTs = null) {
  const history = [];

  for (const msg of threadMessages) {
    if (skipTs && msg.ts === skipTs) continue;
    const isBot = msg.user === botUserId;
    let cleanText = (msg.text || '').replace(/<!--STATE:.*?-->/gs, '').trim();
    if (!cleanText || cleanText === '_On it..._') continue;

    let role;
    if (isBot && cleanText.startsWith('[USER_CHOICE] ')) {
      role = 'user';
      cleanText = cleanText.slice('[USER_CHOICE] '.length);
    } else {
      role = isBot ? 'assistant' : 'user';
    }

    const last = history[history.length - 1];
    if (last && last.role === role) {
      last.content += '\n' + cleanText;
    } else {
      history.push({ role, content: cleanText });
    }
  }

  return history;
}

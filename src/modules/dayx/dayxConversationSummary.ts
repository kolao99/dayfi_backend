export type ChatTurn = { role: string; content: string };

/** Compact rolling summary injected into the system prompt for longer threads. */
export function buildConversationSummary(
  history: ChatTurn[],
  maxTurns = 14
): string {
  const turns = history.filter((h) => h.content?.trim()).slice(-maxTurns);
  if (!turns.length) return '';

  const lines = turns.map((h) => {
    const role = h.role === 'assistant' ? 'Assistant' : 'User';
    const text = h.content.replace(/\s+/g, ' ').trim().slice(0, 160);
    return `- ${role}: ${text}`;
  });

  return (
    'Conversation so far (use for context; wallet balances in Live context are authoritative):\n' +
    lines.join('\n')
  );
}

/**
 * Thin wrapper — conversational brain is the source of intelligent replies.
 * Kept for callers that still import composeConversationalReply.
 */

import { runConversationalBrain } from './conversationalBrain';

export function resetNaturalReplyRotationForTests(): void {
  /* no-op — brain stub heuristics are pure */
}

export async function composeConversationalReply(input: {
  userId: string;
  conversationId: string;
  text: string;
  firstName?: string;
}): Promise<string> {
  const brain = await runConversationalBrain(input);
  if (brain.kind === 'chat') return brain.reply;
  if (brain.kind === 'action' && brain.note) return brain.note;
  return `I can help with that — let's continue.`;
}

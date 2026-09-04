import type { EngineReply, EngineResult } from '../engine/conversationEngine';
import type { FourEngineTurnResult, FourOutboundMessage } from './types';

/** Map engine replies → channel-neutral outbound messages. */
export function engineResultToChannel(result: EngineResult): FourEngineTurnResult {
  return {
    intentId: result.intentId,
    replies: result.replies.map(engineReplyToChannel),
  };
}

export function engineReplyToChannel(reply: EngineReply): FourOutboundMessage {
  const buttons = (reply.metadata?.buttons as Array<{
    id: string;
    label: string;
    disabled?: boolean;
    userText?: string;
  }>) ?? [];

  return {
    text: reply.content,
    type: reply.type,
    scope: String(reply.metadata?.scope ?? 'action'),
    metadata: reply.metadata,
    actions: buttons.map((b) => ({
      id: b.id,
      label: b.label,
      userText: b.userText,
      disabled: b.disabled,
    })),
  };
}

export function channelReplyToEngine(reply: FourOutboundMessage): EngineReply {
  return {
    role: 'assistant',
    type: reply.type ?? 'text',
    content: reply.text,
    metadata: {
      ...(reply.metadata ?? {}),
      scope: reply.scope,
      buttons: reply.actions?.map((a) => ({
        id: a.id,
        label: a.label,
        userText: a.userText,
        disabled: a.disabled,
      })),
    },
  };
}

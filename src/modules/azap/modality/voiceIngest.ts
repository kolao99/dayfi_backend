/**
 * Phase 2 scaffold — voice notes → STT → Azap understanding.
 * Does not execute money. Wire Meta media download + STT provider next.
 */

export type VoiceIngestResult =
  | { ok: true; transcript: string; languageHint?: string }
  | { ok: false; userMessage: string };

/**
 * Placeholder until STT (Yoruba / Pidgin / Hausa / Igbo / English) is wired.
 * Callers should pass a successful transcript into handleUserText.
 */
export async function ingestVoiceNote(_input: {
  userId: string;
  mediaUrl?: string;
  mimeType?: string;
  mediaId?: string;
}): Promise<VoiceIngestResult> {
  return {
    ok: false,
    userMessage:
      "I can't take voice notes yet — type it for me and I'll handle it 🙏",
  };
}

/** Once STT exists: transcript → existing conversationEngine (no separate payment path). */
export function voicePipelineNote(): string {
  return 'VOICE → STT → transcript → Azap understanding → conversation | action';
}

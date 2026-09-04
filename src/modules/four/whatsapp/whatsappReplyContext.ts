import { AsyncLocalStorage } from 'async_hooks';
import type { OutboundWhatsappMessage } from './whatsappClient';

type WhatsappReplyContext = {
  twimlBodies: string[];
  contentReplies: OutboundWhatsappMessage[];
};

const storage = new AsyncLocalStorage<WhatsappReplyContext>();

export function runWithTwimlReplies<T>(
  fn: () => Promise<T>
): Promise<{ result: T; bodies: string[]; contentReplies: OutboundWhatsappMessage[] }> {
  const twimlBodies: string[] = [];
  const contentReplies: OutboundWhatsappMessage[] = [];
  return storage.run({ twimlBodies, contentReplies }, async () => {
    const result = await fn();
    return { result, bodies: twimlBodies, contentReplies };
  });
}

export function pushTwimlReply(text: string): void {
  storage.getStore()?.twimlBodies.push(text);
}

export function pushContentReply(message: OutboundWhatsappMessage): void {
  storage.getStore()?.contentReplies.push(message);
}

export function twimlReplyActive(): boolean {
  return Boolean(storage.getStore());
}

export function buildTwimlResponse(bodies: string[]): string {
  if (!bodies.length) return '<Response></Response>';
  const messages = bodies
    .map((body) => `<Message>${escapeXml(body)}</Message>`)
    .join('');
  return `<Response>${messages}</Response>`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

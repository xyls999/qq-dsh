import { createHmac } from 'node:crypto';

const MAX_TEXT_LENGTH = 20_000;

/**
 * Converts one OneBot event into a local record only when it belongs to the selected group.
 * @param {unknown} input The untrusted OneBot event.
 * @param {{groupId: string, selfId?: string | null, pseudonymKey: Buffer}} options Local filtering and pseudonym settings.
 * @returns {{groupId: string, messageKey: string, messageRef: string | null, timestampMs: number, senderKey: string, text: string} | null} A text-only record or null when the event is out of scope.
 */
export function normalizeEvent(input, options) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const event = /** @type {Record<string, unknown>} */ (input);
  if (event.post_type !== 'message' || event.message_type !== 'group'
    || String(event.group_id ?? '') !== options.groupId || !Array.isArray(event.message)) return null;

  const sender = event.sender && typeof event.sender === 'object'
    ? /** @type {Record<string, unknown>} */ (event.sender)
    : {};
  const userId = String(event.user_id ?? sender.user_id ?? '');
  if (!userId) return null;
  if (!Buffer.isBuffer(options.pseudonymKey) || options.pseudonymKey.length < 32) return null;

  const text = event.message.map((segment) => {
    if (!segment || typeof segment !== 'object') return '';
    const value = /** @type {Record<string, unknown>} */ (segment);
    if (value.type === 'text') {
      const data = value.data && typeof value.data === 'object'
        ? /** @type {Record<string, unknown>} */ (value.data)
        : {};
      return typeof data.text === 'string' ? data.text : '';
    }
    return value.type === 'at' ? '[提及]' : '';
  }).join('').trim();
  if (!text || text.length > MAX_TEXT_LENGTH) return null;

  const seconds = Number(event.time);
  const timestampMs = Math.trunc(seconds * 1000);
  if (!Number.isSafeInteger(timestampMs) || timestampMs <= 0) return null;

  const senderKey = `member-${createHmac('sha256', options.pseudonymKey).update(userId).digest('hex').slice(0, 16)}`;
  const rawMessageRef = event.message_id ?? event.msg_id ?? null;
  const messageRef = rawMessageRef === null || rawMessageRef === undefined
    ? null
    : String(rawMessageRef).slice(0, 256);
  const messageKey = messageRef
    ? `onebot:${messageRef}`
    : `fallback-${createHmac('sha256', options.pseudonymKey)
      .update(`${options.groupId}\0${timestampMs}\0${senderKey}\0${text}`)
      .digest('hex')}`;

  return { groupId: options.groupId, messageKey, messageRef, timestampMs, senderKey, text };
}

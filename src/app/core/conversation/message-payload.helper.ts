import type { MessageReplyTo, ReactionPayload } from './conversation.types';

export interface ParsedChatPayload {
  type: 'chat';
  text: string;
  replyTo?: MessageReplyTo;
}

export interface ParsedReactionPayload {
  type: 'reaction';
  reaction: ReactionPayload;
}

export interface ParsedUnknownPayload {
  type: 'unknown';
  text: string;
}

export type ParsedMessagePayload = ParsedChatPayload | ParsedReactionPayload | ParsedUnknownPayload;

export class MessagePayloadHelper {
  private static readonly CURRENT_VERSION = 1;

  /**
   * Encodes a chat text message, optionally with replyTo metadata.
   */
  static encodeChatMessage(text: string, replyTo?: MessageReplyTo): string {
    if (!replyTo) {
      // For simple messages, send standard string for maximum efficiency & backward compatibility
      return text;
    }

    return JSON.stringify({
      v: this.CURRENT_VERSION,
      type: 'chat',
      text,
      replyTo: {
        messageId: replyTo.messageId,
        senderDid: replyTo.senderDid,
        senderHandle: replyTo.senderHandle,
        textSnippet: replyTo.textSnippet.length > 120 
          ? replyTo.textSnippet.substring(0, 117) + '...' 
          : replyTo.textSnippet,
        mediaThumbnail: replyTo.mediaThumbnail,
      },
    });
  }

  /**
   * Encodes a reaction action payload (add/remove emoji).
   */
  static encodeReactionMessage(targetMessageId: string, emoji: string, action: 'add' | 'remove'): string {
    return JSON.stringify({
      v: this.CURRENT_VERSION,
      type: 'reaction',
      reaction: {
        targetMessageId,
        emoji,
        action,
      },
    });
  }

  /**
   * Parses raw decrypted plaintext into a structured payload.
   * Gracefully handles non-JSON raw strings from legacy/standard messages.
   */
  static parseMessagePayload(rawText: string): ParsedMessagePayload {
    if (!rawText || typeof rawText !== 'string') {
      return { type: 'chat', text: '' };
    }

    const trimmed = rawText.trim();
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
      return { type: 'chat', text: rawText };
    }

    try {
      const parsed = JSON.parse(trimmed);
      if (!parsed || parsed.v !== this.CURRENT_VERSION) {
        return { type: 'chat', text: rawText };
      }

      if (parsed.type === 'chat') {
        return {
          type: 'chat',
          text: typeof parsed.text === 'string' ? parsed.text : '',
          replyTo: parsed.replyTo && typeof parsed.replyTo.messageId === 'string'
            ? {
                messageId: parsed.replyTo.messageId,
                senderDid: parsed.replyTo.senderDid || '',
                senderHandle: parsed.replyTo.senderHandle,
                textSnippet: parsed.replyTo.textSnippet || '',
                // Only set when present -- an explicit `mediaThumbnail: undefined`
                // own-property (vs. simply absent) makes this object structurally
                // unequal to a caller-built MessageReplyTo that never mentions the
                // key at all (Jasmine's toEqual, unlike JSON.stringify, treats the two differently).
                ...(typeof parsed.replyTo.mediaThumbnail === 'string' ? { mediaThumbnail: parsed.replyTo.mediaThumbnail } : {}),
              }
            : undefined,
        };
      }

      if (parsed.type === 'reaction' && parsed.reaction) {
        const r = parsed.reaction;
        if (typeof r.targetMessageId === 'string' && typeof r.emoji === 'string' && (r.action === 'add' || r.action === 'remove')) {
          return {
            type: 'reaction',
            reaction: {
              targetMessageId: r.targetMessageId,
              emoji: r.emoji,
              action: r.action,
            },
          };
        }
      }

      return { type: 'chat', text: rawText };
    } catch {
      return { type: 'chat', text: rawText };
    }
  }

  /**
   * Applies a reaction payload mutation to an existing ReactionMap.
   * Returns a new updated ReactionMap.
   */
  static applyReactionMutation(
    currentReactions: Record<string, string[]> | undefined,
    senderDid: string,
    emoji: string,
    action: 'add' | 'remove'
  ): Record<string, string[]> {
    const updated: Record<string, string[]> = { ...(currentReactions || {}) };
    const currentList = updated[emoji] ? [...updated[emoji]] : [];

    if (action === 'add') {
      if (!currentList.includes(senderDid)) {
        currentList.push(senderDid);
      }
      updated[emoji] = currentList;
    } else if (action === 'remove') {
      const filtered = currentList.filter(did => did !== senderDid);
      if (filtered.length > 0) {
        updated[emoji] = filtered;
      } else {
        delete updated[emoji];
      }
    }

    return updated;
  }
}

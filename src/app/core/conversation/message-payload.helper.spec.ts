import { MessagePayloadHelper } from './message-payload.helper';

describe('MessagePayloadHelper', () => {
  it('encodes and parses simple text message', () => {
    const raw = MessagePayloadHelper.encodeChatMessage('Hello world');
    expect(raw).toBe('Hello world');

    const parsed = MessagePayloadHelper.parseMessagePayload(raw);
    expect(parsed).toEqual({
      type: 'chat',
      text: 'Hello world',
    });
  });

  it('encodes and parses message with replyTo', () => {
    const replyTo = {
      messageId: 'msg-123',
      senderDid: 'did:plc:alice',
      senderHandle: 'alice.bsky.social',
      textSnippet: 'This is the quoted message',
    };

    const raw = MessagePayloadHelper.encodeChatMessage('My reply message', replyTo);
    expect(raw).toContain('"type":"chat"');
    expect(raw).toContain('"messageId":"msg-123"');

    const parsed = MessagePayloadHelper.parseMessagePayload(raw);
    expect(parsed.type).toBe('chat');
    if (parsed.type === 'chat') {
      expect(parsed.text).toBe('My reply message');
      expect(parsed.replyTo).toEqual(replyTo);
    }
  });

  it('encodes and parses reaction action', () => {
    const raw = MessagePayloadHelper.encodeReactionMessage('target-msg-99', '❤️', 'add');
    const parsed = MessagePayloadHelper.parseMessagePayload(raw);

    expect(parsed.type).toBe('reaction');
    if (parsed.type === 'reaction') {
      expect(parsed.reaction).toEqual({
        targetMessageId: 'target-msg-99',
        emoji: '❤️',
        action: 'add',
      });
    }
  });

  it('handles invalid JSON or legacy strings gracefully', () => {
    const parsed1 = MessagePayloadHelper.parseMessagePayload('{ not valid json }');
    expect(parsed1).toEqual({ type: 'chat', text: '{ not valid json }' });

    const parsed2 = MessagePayloadHelper.parseMessagePayload('random string');
    expect(parsed2).toEqual({ type: 'chat', text: 'random string' });
  });

  it('applies reaction mutations correctly', () => {
    let map = MessagePayloadHelper.applyReactionMutation(undefined, 'user1', '👍', 'add');
    expect(map).toEqual({ '👍': ['user1'] });

    map = MessagePayloadHelper.applyReactionMutation(map, 'user2', '👍', 'add');
    expect(map).toEqual({ '👍': ['user1', 'user2'] });

    map = MessagePayloadHelper.applyReactionMutation(map, 'user1', '👍', 'remove');
    expect(map).toEqual({ '👍': ['user2'] });

    map = MessagePayloadHelper.applyReactionMutation(map, 'user2', '👍', 'remove');
    expect(map).toEqual({});
  });
});

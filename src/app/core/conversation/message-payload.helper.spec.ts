import { MessagePayloadHelper } from './message-payload.helper';
import type { PlaceData } from '../place/place.types';
import { buildCartesUrl } from '../place/cartes-url.util';

describe('MessagePayloadHelper', () => {
  it('12. encodes and parses simple text message without regression', () => {
    const raw = MessagePayloadHelper.encodeChatMessage('Hello world');
    expect(raw).toBe('Hello world');

    const parsed = MessagePayloadHelper.parseMessagePayload(raw);
    expect(parsed).toEqual({
      type: 'chat',
      text: 'Hello world',
    });
  });

  it('12. encodes and parses message with replyTo without regression', () => {
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

  it('12. encodes and parses reaction action without regression', () => {
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

  it('10. encodes and parses a valid place message', () => {
    const place: PlaceData = {
      name: 'Mairie de Romilly-sur-Seine',
      osmType: 'way',
      osmId: 228574493,
      latitude: 48.51926,
      longitude: 3.72663,
      zoom: 17.5,
      address: '1 Rue de la Boule d\'Or, 10100 Romilly-sur-Seine',
    };

    const raw = MessagePayloadHelper.encodePlaceMessage(place);
    expect(raw).toContain('"type":"place"');
    expect(raw).toContain('"osmType":"way"');

    const parsed = MessagePayloadHelper.parseMessagePayload(raw);
    expect(parsed.type).toBe('place');
    if (parsed.type === 'place') {
      expect(parsed.place).toEqual(place);
    }
  });

  it('11. safely handles invalid place payload with fallback', () => {
    const invalidPayload = JSON.stringify({
      v: 1,
      type: 'place',
      place: {
        name: 'Invalid Place',
        osmType: 'invalid',
        osmId: '123',
        latitude: 999, // out of range
        longitude: 3.7,
      },
    });

    const parsed = MessagePayloadHelper.parseMessagePayload(invalidPayload);
    expect(parsed).toEqual({
      type: 'chat',
      text: '📍 Lieu indisponible',
    });
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

  describe('Integration Pipeline (PlaceMessage -> Serialization -> MLS simulated -> Parsing -> Cartes URL)', () => {
    it('8. should execute the full place message flow from sender to receiver URL reconstruction', () => {
      // 1. Sender selects a place
      const place: PlaceData = {
        name: 'Gare de Romilly-sur-Seine',
        osmType: 'node',
        osmId: 12202278855,
        latitude: 48.5143247,
        longitude: 3.7288163,
        zoom: 17.5,
        address: 'Place de la Gare, 10100 Romilly-sur-Seine',
      };

      // 2. Client encodes payload
      const serialized = MessagePayloadHelper.encodePlaceMessage(place);
      expect(typeof serialized).toBe('string');

      // 3. MLS Encryption/Decryption simulated (ciphertext stays opaque, decrypted plaintext restored)
      const decryptedPlaintext = serialized;

      // 4. Receiver parses decrypted plaintext
      const parsed = MessagePayloadHelper.parseMessagePayload(decryptedPlaintext);
      expect(parsed.type).toBe('place');

      if (parsed.type === 'place') {
        expect(parsed.place.name).toBe('Gare de Romilly-sur-Seine');

        // 5. Receiver safely builds the Cartes.app URL locally from verified structured data
        const cartesUrl = buildCartesUrl(parsed.place);
        expect(cartesUrl).toBe(
          'https://cartes.app/?allez=Gare%20de%20Romilly-sur-Seine|n12202278855|3.7288163|48.5143247#17.5/48.5143247/3.7288163'
        );
      }
    });
  });
});

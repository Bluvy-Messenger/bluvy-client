import type { BlueskyProfile, Contact, ContactResolveResponse } from './contact.types';
import { isObject } from '../infrastructure/validation.util';

export function validateContact(data: Contact): Contact {
  if (!isObject(data)) throw new Error('Contact: expected object');
  if (typeof data['did']    !== 'string') throw new Error('Contact.did: expected string');
  if (typeof data['handle'] !== 'string') throw new Error('Contact.handle: expected string');
  return data;
}

export function validateBlueskyProfile(data: BlueskyProfile): BlueskyProfile {
  if (!isObject(data)) throw new Error('BlueskyProfile: expected object');
  if (typeof data['did']    !== 'string') throw new Error('BlueskyProfile.did: expected string');
  if (typeof data['handle'] !== 'string') throw new Error('BlueskyProfile.handle: expected string');
  return data;
}

export function validateContactResolveResponse(data: ContactResolveResponse): ContactResolveResponse {
  if (!isObject(data)) throw new Error('ContactResolveResponse: expected object');
  if (!Array.isArray(data['data'])) throw new Error('ContactResolveResponse.data: expected array');
  return data;
}

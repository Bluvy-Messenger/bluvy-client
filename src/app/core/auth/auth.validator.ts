import type { AuthResponse, AuthSessionResponse } from './auth.types';
import { isObject } from '../infrastructure/validation.util';

export function validateAuthResponse(data: AuthResponse): AuthResponse {
  if (!isObject(data)) throw new Error('AuthResponse: expected object');
  if (typeof data['accessToken'] !== 'string') throw new Error('AuthResponse.accessToken: expected string');
  if (typeof data['refreshToken'] !== 'string') throw new Error('AuthResponse.refreshToken: expected string');
  if (!isObject(data['user'])) throw new Error('AuthResponse.user: expected object');
  if (!isObject(data['device'])) throw new Error('AuthResponse.device: expected object');
  return data;
}

export function validateAuthSessionResponse(data: AuthSessionResponse): AuthSessionResponse {
  if (!isObject(data)) throw new Error('AuthSessionResponse: expected object');
  if (!isObject(data['user'])) throw new Error('AuthSessionResponse.user: expected object');
  if (!isObject(data['device'])) throw new Error('AuthSessionResponse.device: expected object');
  return data;
}

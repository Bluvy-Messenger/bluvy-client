import { EmbedProviderId } from './embed-provider.types';

export interface EmbedPreferencesRecord {
  $type: 'com.bluvy.preferences.embeds';
  schemaVersion: number;
  providers: Partial<Record<EmbedProviderId, boolean>>;
  updatedAt: string;
}

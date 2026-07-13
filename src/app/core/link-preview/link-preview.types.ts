export interface LinkPreviewMeta {
  url:         string;
  status:      'ok' | 'unavailable';
  title:       string | null;
  description: string | null;
  siteName:    string | null;
  // Relative /v1/link-preview/image path (our own proxy), not the third-party URL — or null.
  imageUrl:    string | null;
}

import type {
  AppBskyFeedDefs,
  AppBskyEmbedImages,
  AppBskyEmbedVideo,
  AppBskyEmbedExternal,
  AppBskyEmbedRecord,
  AppBskyEmbedRecordWithMedia,
} from '@atproto/api';
import type {
  BskyPostAuthor,
  BskyPostEmbed,
  BskyPostImage,
  BskyPostVideo,
  BskyPostExternal,
  BskyPostView,
  BskyQuotedMediaEmbed,
  BskyQuotedPost,
  BskyQuoteTarget,
} from './bsky-post.types';

function toAuthor(author: { did: string; handle: string; displayName?: string; avatar?: string }): BskyPostAuthor {
  return {
    did: author.did,
    handle: author.handle,
    displayName: author.displayName ?? null,
    avatarUrl: author.avatar ?? null,
  };
}

function toImages(view: AppBskyEmbedImages.View): BskyPostImage[] {
  return view.images.map(img => ({ thumb: img.thumb, fullsize: img.fullsize, alt: img.alt }));
}

function toVideo(view: AppBskyEmbedVideo.View): BskyPostVideo {
  return { thumbnail: view.thumbnail ?? null, alt: view.alt ?? null };
}

function toExternal(view: AppBskyEmbedExternal.View): BskyPostExternal {
  return {
    uri: view.external.uri,
    title: view.external.title,
    description: view.external.description,
    thumb: view.external.thumb ?? null,
  };
}

// Media-only mapping used both for the top-level post's plain media embeds
// and for a quoted post's own embed -- excludes record/recordWithMedia so a
// quote can never itself carry a further nested quote.
function toQuotedMediaEmbed(embed: unknown): BskyQuotedMediaEmbed | null {
  const typed = embed as { $type?: string } | undefined;
  switch (typed?.$type) {
    case 'app.bsky.embed.images#view':
      return { kind: 'images', images: toImages(embed as AppBskyEmbedImages.View) };
    case 'app.bsky.embed.video#view':
      return { kind: 'video', video: toVideo(embed as AppBskyEmbedVideo.View) };
    case 'app.bsky.embed.external#view':
      return { kind: 'external', external: toExternal(embed as AppBskyEmbedExternal.View) };
    default:
      return null;
  }
}

function toQuoteTarget(record: AppBskyEmbedRecord.View['record']): BskyQuoteTarget {
  const typed = record as { $type?: string };
  if (typed.$type !== 'app.bsky.embed.record#viewRecord') {
    if (typed.$type === 'app.bsky.embed.record#viewNotFound') return { kind: 'notFound' };
    if (typed.$type === 'app.bsky.embed.record#viewBlocked') return { kind: 'blocked' };
    // viewDetached, or a non-post quote target (feed generator, list, labeler, starter pack).
    return { kind: 'unavailable' };
  }

  const viewRecord = record as AppBskyEmbedRecord.ViewRecord;
  const value = viewRecord.value as { text?: string; createdAt?: string };
  // A ViewRecord's own `embeds` array can itself contain another record#view
  // (a quote-of-a-quote) -- only the first media-type entry is kept, any
  // record/recordWithMedia entry is dropped, enforcing the 1-level limit.
  const firstMediaEmbed = viewRecord.embeds?.map(toQuotedMediaEmbed).find(e => e !== null) ?? null;

  const quotedPost: BskyQuotedPost = {
    uri: viewRecord.uri,
    cid: viewRecord.cid,
    author: toAuthor(viewRecord.author),
    text: typeof value.text === 'string' ? value.text : '',
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : viewRecord.indexedAt,
    embed: firstMediaEmbed,
    replyCount: viewRecord.replyCount ?? 0,
    repostCount: viewRecord.repostCount ?? 0,
    likeCount: viewRecord.likeCount ?? 0,
  };
  return { kind: 'post', post: quotedPost };
}

function toTopLevelEmbed(embed: NonNullable<AppBskyFeedDefs.PostView['embed']>): BskyPostEmbed | null {
  const typed = embed as { $type?: string };
  switch (typed.$type) {
    case 'app.bsky.embed.images#view':
      return { kind: 'images', images: toImages(embed as AppBskyEmbedImages.View) };
    case 'app.bsky.embed.video#view':
      return { kind: 'video', video: toVideo(embed as AppBskyEmbedVideo.View) };
    case 'app.bsky.embed.external#view':
      return { kind: 'external', external: toExternal(embed as AppBskyEmbedExternal.View) };
    case 'app.bsky.embed.record#view':
      return { kind: 'quote', quote: toQuoteTarget((embed as AppBskyEmbedRecord.View).record) };
    case 'app.bsky.embed.recordWithMedia#view': {
      const rwm = embed as AppBskyEmbedRecordWithMedia.View;
      const media = toQuotedMediaEmbed(rwm.media);
      if (!media) return { kind: 'quote', quote: toQuoteTarget(rwm.record.record) };
      return { kind: 'quoteWithMedia', quote: toQuoteTarget(rwm.record.record), media };
    }
    default:
      return null;
  }
}

export function toBskyPostView(raw: AppBskyFeedDefs.PostView): BskyPostView {
  const value = raw.record as { text?: string; createdAt?: string };
  return {
    uri: raw.uri,
    cid: raw.cid,
    author: toAuthor(raw.author),
    text: typeof value.text === 'string' ? value.text : '',
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : raw.indexedAt,
    embed: raw.embed ? toTopLevelEmbed(raw.embed) : null,
    replyCount: raw.replyCount ?? 0,
    repostCount: raw.repostCount ?? 0,
    likeCount: raw.likeCount ?? 0,
    quoteCount: raw.quoteCount ?? 0,
    viewerLikeUri: raw.viewer?.like ?? null,
    viewerRepostUri: raw.viewer?.repost ?? null,
  };
}

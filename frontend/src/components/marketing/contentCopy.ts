/**
 * The social media planner's words and colours (docs/BUSINESS-FIGURES-SPEC.md §8e) —
 * shared by the calendar, board, ideas list, library and post editor so they agree.
 */

export type Channel = 'instagram' | 'facebook' | 'newsletter' | 'blog';
export type PostStatus = 'idea' | 'in_progress' | 'review' | 'approved' | 'scheduled' | 'published' | 'dropped';

export const CHANNELS: Array<{ key: Channel; label: string; short: string; cls: string }> = [
  { key: 'instagram', label: 'Instagram', short: 'IG', cls: 'bg-pink-100 text-pink-800 border-pink-200' },
  { key: 'facebook', label: 'Facebook', short: 'FB', cls: 'bg-blue-100 text-blue-800 border-blue-200' },
  { key: 'newsletter', label: 'Newsletter', short: 'News', cls: 'bg-amber-100 text-amber-800 border-amber-200' },
  { key: 'blog', label: 'Blog', short: 'Blog', cls: 'bg-emerald-100 text-emerald-800 border-emerald-200' },
];
export const channelOf = (k: string) => CHANNELS.find((c) => c.key === k);

/** Formats by channel — the editor offers the ones that fit the channels ticked. */
export const FORMATS: Array<{ key: string; label: string; for: Channel[] }> = [
  { key: 'reel', label: 'Reel', for: ['instagram', 'facebook'] },
  { key: 'carousel', label: 'Carousel', for: ['instagram', 'facebook'] },
  { key: 'image', label: 'Image', for: ['instagram', 'facebook'] },
  { key: 'story', label: 'Story', for: ['instagram', 'facebook'] },
  { key: 'video', label: 'Video', for: ['instagram', 'facebook'] },
  { key: 'text', label: 'Text post', for: ['facebook'] },
  { key: 'newsletter', label: 'Newsletter issue', for: ['newsletter'] },
  { key: 'article', label: 'Blog article', for: ['blog'] },
];
export const formatLabel = (k: string | null | undefined) => FORMATS.find((f) => f.key === k)?.label ?? '';

export const STATUSES: Array<{ key: PostStatus; label: string; cls: string }> = [
  { key: 'idea', label: 'Idea', cls: 'bg-gray-100 text-gray-700' },
  { key: 'in_progress', label: 'In progress', cls: 'bg-sky-100 text-sky-800' },
  { key: 'review', label: 'Review', cls: 'bg-amber-100 text-amber-800' },
  { key: 'approved', label: 'Approved', cls: 'bg-violet-100 text-violet-800' },
  { key: 'scheduled', label: 'Scheduled in Meta', cls: 'bg-indigo-100 text-indigo-800' },
  { key: 'published', label: 'Published', cls: 'bg-green-100 text-green-800' },
  { key: 'dropped', label: 'Dropped', cls: 'bg-gray-100 text-gray-500 line-through' },
];
export const statusOf = (k: string) => STATUSES.find((s) => s.key === k) ?? STATUSES[0];

export const ASSET_KINDS: Array<{ key: string; label: string; icon: string }> = [
  { key: 'photo', label: 'Photo(s)', icon: '📷' },
  { key: 'video', label: 'Video', icon: '🎬' },
  { key: 'graphic', label: 'Graphic', icon: '🎨' },
  { key: 'other', label: 'Other', icon: '📎' },
];
export const assetKindOf = (k: string) => ASSET_KINDS.find((a) => a.key === k) ?? ASSET_KINDS[3];

/** Instagram's caption limit, and its hashtag limit. */
export const IG_CAPTION_MAX = 2200;
export const IG_HASHTAG_MAX = 30;
export const countHashtags = (s: string | null | undefined) => (String(s || '').match(/#[\p{L}\p{N}_]+/gu) || []).length;

export interface Post {
  id: string;
  title: string;
  publish_date: string | null;
  publish_time: string | null;
  channels: Channel[];
  format: string | null;
  caption: string | null;
  hashtags: string | null;
  theme: string | null;
  status: PostStatus;
  owner_person_id: string | null;
  owner_name: string | null;
  job_id: string | null;
  job_number: number | null;
  job_name: string | null;
  organisation_id: string | null;
  organisation_name: string | null;
  credit_person_id: string | null;
  credit_name: string | null;
  tracked_link_id: string | null;
  tracked_link_code: string | null;
  tracked_link_url: string | null;
  live_url: string | null;
  notes: string | null;
  asset_count: number;
  assets?: Asset[];
}

export interface Asset {
  id: string;
  title: string;
  url: string;
  kind: string;
  notes: string | null;
  source: 'staff' | 'sitter';
  credit_person_id: string | null;
  credit_name: string | null;
  job_id: string | null;
  job_number: number | null;
  job_name: string | null;
  organisation_id: string | null;
  organisation_name: string | null;
  added_by_name: string | null;
  used_in: number;
  created_at: string;
  archived_at: string | null;
}

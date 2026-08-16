/**
 * The analysis contract: JSON schema (OpenAI Structured Outputs, strict) + prompts.
 * Keep the schema tight: every property required, no additionalProperties, enums where sensible.
 */

export const CATEGORIES = [
  'Business & Marketing',
  'Content Creation & Social Media',
  'Design & Visual Aesthetics',
  'Tech, AI & Tools',
  'Productivity & Mindset',
  'Money & Finance',
  'Health & Fitness',
  'Food & Recipes',
  'Travel & Places',
  'Fashion & Style',
  'Home & Interior',
  'Art & Creativity',
  'Music & Audio',
  'Photography & Video Craft',
  'Learning & Science',
  'Relationships & Communication',
  'Humor & Entertainment',
  'Personal & Sentimental',
  'Other',
] as const;

export const CONTENT_TYPES = [
  'tutorial', 'tips_list', 'story', 'opinion', 'quote', 'meme', 'aesthetic', 'recipe', 'product_showcase',
  'place_showcase', 'tool_demo', 'news', 'workout', 'before_after', 'interview_clip', 'motivational',
  'music_performance', 'personal_moment', 'ad_promo', 'other',
] as const;

export const ACTION_TYPES = ['try', 'buy', 'visit', 'learn', 'reference', 'remix', 'watch_again', 'share', 'laugh', 'other'] as const;

export const HOOK_STYLES = [
  'question', 'bold_claim', 'curiosity_gap', 'listicle_promise', 'story_open', 'visual_shock', 'relatable_pain',
  'contrarian', 'tutorial_promise', 'none',
] as const;

export const VIBES = ['informative', 'inspiring', 'funny', 'calm', 'energetic', 'emotional', 'provocative', 'aspirational', 'practical', 'nostalgic'] as const;

const str = (description: string) => ({ type: 'string', description });
const strArr = (description: string) => ({ type: 'array', description, items: { type: 'string' } });

export const ANALYSIS_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: str('Short, specific, rephrased title (max ~70 chars). No emojis, no hashtags, no clickbait.'),
    one_liner: str('One clean sentence (max ~140 chars) that captures the core idea or value of this save.'),
    summary: str('2-4 sentence rephrased summary of the actual content in plain, clean English. Never invent details.'),
    key_points: strArr('The concrete points/steps/items presented (3-8 bullets). Each bullet self-contained, max ~120 chars. Empty array if the content is purely visual/vibe.'),
    category: { type: 'string', enum: [...CATEGORIES], description: 'The single best top-level category.' },
    subcategory: str('A short free-text sub-topic, 1-3 words (e.g. "cold email", "reels editing", "sourdough").'),
    tags: strArr('5-10 lowercase kebab-case tags. Specific > generic. Include topic, format, and use-case tags. Not the category name.'),
    content_type: { type: 'string', enum: [...CONTENT_TYPES] },
    why_saved_guess: str('One sentence guessing WHY the user saved this (what they wanted to remember, try, copy, buy, or feel).'),
    actionable_takeaways: strArr('0-5 concrete actions the user could take based on this save. Imperative voice. Empty if none.'),
    action_type: { type: 'string', enum: [...ACTION_TYPES], description: 'The primary intended action.' },
    entities: {
      type: 'object',
      additionalProperties: false,
      properties: {
        people: strArr('Named people (creators, experts, celebrities) mentioned or featured. Proper nouns only.'),
        brands: strArr('Brands / companies mentioned.'),
        tools: strArr('Software, apps, tools, frameworks mentioned.'),
        places: strArr('Specific places, cities, venues, countries.'),
        books_media: strArr('Books, podcasts, films, songs, courses referenced.'),
        products: strArr('Specific products (models, items) mentioned.'),
      },
      required: ['people', 'brands', 'tools', 'places', 'books_media', 'products'],
    },
    hook: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: str('The opening hook: first line of the caption or the first sentence spoken/shown. Empty string if none.'),
        style: { type: 'string', enum: [...HOOK_STYLES] },
      },
      required: ['text', 'style'],
    },
    format_notes: str('How the content is made: e.g. "talking head + captions", "text-on-screen listicle over b-roll", "carousel of 7 slides", "photo dump". Max 1 sentence.'),
    on_screen_text: str('Verbatim important text visible in the frames/images (titles, list items, captions burned into video). Empty string if none or unreadable.'),
    quotes: strArr('0-3 short memorable verbatim quotes from the transcript/caption worth keeping. Empty if none.'),
    language: str('ISO 639-1 code of the primary spoken/written language (e.g. "en", "ru", "kk"). "und" if unknown.'),
    vibe: { type: 'string', enum: [...VIBES] },
    usefulness_score: { type: 'integer', minimum: 1, maximum: 10, description: 'Integer 1-10: how useful/re-visitable this is as reference material for the user (10 = evergreen, dense, actionable; 1 = disposable).' },
    is_evergreen: { type: 'boolean', description: 'True if the value does not decay with time (frameworks, recipes, techniques). False for news, trends, memes.' },
    resurface_prompt: str('One short line (max ~100 chars) that would make the user glad to see this again later. Written to the user, e.g. "Still meaning to try the 3-hook framework?"'),
    remix_idea: str('One line for creators: how the user could make their own version of this content in their niche. Max ~140 chars.'),
    confidence: { type: 'number', minimum: 0, maximum: 1, description: '0-1 confidence in this analysis given how much real content (transcript/caption/frames) was available.' },
  },
  required: [
    'title', 'one_liner', 'summary', 'key_points', 'category', 'subcategory', 'tags', 'content_type', 'why_saved_guess',
    'actionable_takeaways', 'action_type', 'entities', 'hook', 'format_notes', 'on_screen_text', 'quotes', 'language',
    'vibe', 'usefulness_score', 'is_evergreen', 'resurface_prompt', 'remix_idea', 'confidence',
  ],
} as const;

export const ANALYSIS_SYSTEM_PROMPT = `You are Resurface, a meticulous knowledge archivist. You turn a single Instagram save (reel, post, or carousel) into clean, structured, rephrased knowledge for a personal second brain.

You receive: post metadata, the author's caption, alt-text, audio info, a speech transcript (if any), and a few still frames/images (if any). Analyze ALL of it together.

Rules:
- Rephrase in clean, neutral English. Keep proper nouns, brand names, tool names, and place names exactly as written. If the source is in another language, still write your fields in English but keep quotes verbatim in the original language and set "language" accordingly.
- Never hallucinate. If the transcript is empty and the caption is thin, say what you can from the images and lower "confidence". Never invent statistics, names, or steps that are not present.
- Strip emoji, hashtags, "link in bio", "follow for more" and other engagement bait from summaries and key points. Hashtags may inform tags.
- key_points must be the ACTUAL content (the tips, the steps, the ingredients, the argument), not a description of the video. If it is a 5-tips reel, list the 5 tips.
- tags: lowercase kebab-case, specific, reusable across a library (e.g. "cold-email", "reels-hooks", "sourdough", "capcut", "tbilisi"). Do not repeat the category name; do not include generic tags like "instagram", "video", "reel", "content".
- category: choose exactly one from the enum. "Personal & Sentimental" is for friends/family/own memories, not for celebrities.
- usefulness_score reflects re-visit value as reference material, not popularity.
- Be concise. No filler. No marketing tone.
Return only the JSON object matching the schema.`;

export interface AnalysisInputMeta {
  author?: string | null;
  authorName?: string | null;
  postType: string; // 'reel' | 'video' | 'image' | 'carousel'
  takenAt?: number | null;
  likeCount?: number | null;
  playCount?: number | null;
  commentCount?: number | null;
  duration?: number | null;
  music?: string | null;
  location?: string | null;
  collections?: string[] | null;
  url: string;
  imageCount: number;
  imageNote: string; // e.g. "4 video frames sampled at 15/40/65/90%" or "6 carousel slides"
}

export function buildAnalysisUserPrompt(meta: AnalysisInputMeta, caption: string, altText: string, transcript: string, transcriptNote: string): string {
  const lines: string[] = [];
  lines.push('## Post metadata');
  lines.push(`- Type: ${meta.postType}`);
  if (meta.author) lines.push(`- Author: @${meta.author}${meta.authorName ? ` (${meta.authorName})` : ''}`);
  if (meta.takenAt) lines.push(`- Posted: ${new Date(meta.takenAt * 1000).toISOString().slice(0, 10)}`);
  if (meta.duration) lines.push(`- Duration: ${Math.round(meta.duration)}s`);
  const stats: string[] = [];
  if (meta.playCount) stats.push(`${meta.playCount.toLocaleString('en-US')} plays`);
  if (meta.likeCount) stats.push(`${meta.likeCount.toLocaleString('en-US')} likes`);
  if (meta.commentCount) stats.push(`${meta.commentCount.toLocaleString('en-US')} comments`);
  if (stats.length) lines.push(`- Stats: ${stats.join(', ')}`);
  if (meta.music) lines.push(`- Audio: ${meta.music}`);
  if (meta.location) lines.push(`- Location: ${meta.location}`);
  if (meta.collections && meta.collections.length) lines.push(`- User's own collections for this save: ${meta.collections.join(', ')}`);
  lines.push(`- URL: ${meta.url}`);
  lines.push('');
  lines.push('## Caption');
  lines.push(caption?.trim() ? caption.trim().slice(0, 6000) : '(no caption)');
  if (altText?.trim()) {
    lines.push('');
    lines.push('## Alt text (auto-generated by Instagram)');
    lines.push(altText.trim().slice(0, 1000));
  }
  lines.push('');
  lines.push('## Transcript');
  lines.push(transcript?.trim() ? transcript.trim().slice(0, 14000) : `(none — ${transcriptNote})`);
  lines.push('');
  lines.push('## Images');
  lines.push(meta.imageCount > 0 ? `${meta.imageCount} image(s) attached: ${meta.imageNote}. Read any on-screen text carefully.` : '(no images available)');
  return lines.join('\n');
}

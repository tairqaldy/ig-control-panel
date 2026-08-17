/* Round 7 §5 — the templates gallery. Six named behaviours; one click fills the builder and lands on
   "Then", where the only thing left to do is write the message. Nothing is saved until Create rule. */
import { BadgePercent, Clapperboard, Gift, HandCoins, Link2, MessageCircle, Sparkles, UserCheck } from 'lucide-react';
import { type RuleDraft, EMPTY_DRAFT } from '../../lib/types-automations';
import { cn } from '../../lib/utils';

export interface RuleTemplate {
  key: string;
  name: string;
  /** what this behaviour does, in one line */
  blurb: string;
  icon: typeof MessageCircle;
  /** colours the icon tile — comment-side rules are amber, DM-side rules accent */
  tone: 'comment' | 'dm';
  draft: RuleDraft;
}

/** Templates arrive switched off: their text still carries placeholders, and a half-edited template
    must never DM "$XX" to a real person. The builder's header toggle is right there to switch it on. */
const base = (over: Partial<RuleDraft>): RuleDraft => ({ ...EMPTY_DRAFT, enabled: false, ...over });

/** The six templates from ROUND7-SPEC §5. Keywords and text are starting points — every one is editable. */
export const TEMPLATES: RuleTemplate[] = [
  {
    key: 'comment_link', name: 'Comment → DM the link', blurb: 'Someone comments your keyword, they get the link in a private DM.',
    icon: Link2, tone: 'comment',
    draft: base({
      name: 'Comment → DM the link', trigger: 'comment', keywords: ['link', 'send', 'guide'], priority: 10, cooldownMinutes: 1440,
      publicReplyText: 'Sent you a DM', replyText: "Hey {{username}} — here's the link you asked for:",
    }),
  },
  {
    key: 'story_thanks', name: 'Story reply → thank you', blurb: 'Every reply to your story gets a short answer instead of silence.',
    icon: Clapperboard, tone: 'dm',
    draft: base({
      name: 'Story reply → thank you', trigger: 'story_reply', keywords: [], priority: 60, cooldownMinutes: 1440,
      replyText: 'Thanks for replying, {{username}}. I read every one — what made you send it?',
    }),
  },
  {
    key: 'dm_welcome', name: 'First DM → welcome', blurb: "The first time someone writes, they hear back within seconds.",
    icon: UserCheck, tone: 'dm',
    draft: base({
      name: 'First DM → welcome', trigger: 'dm_first', keywords: [], priority: 50, cooldownMinutes: 10080, oncePerPerson: true,
      replyText: 'Hey {{username}}, thanks for writing. I answer these myself — give me a few hours and tell me what you need.',
    }),
  },
  {
    key: 'discount_code', name: 'Keyword → discount code', blurb: 'A word like "code" in a DM returns your current offer.',
    icon: BadgePercent, tone: 'dm',
    draft: base({
      name: 'Keyword → discount code', trigger: 'dm', keywords: ['code', 'discount', 'promo'], priority: 30, cooldownMinutes: 10080, oncePerPerson: true,
      replyText: "Here's your code, {{username}}: SAVE10. It works at checkout for the next 7 days.",
    }),
  },
  {
    key: 'price_answer', name: 'Price question → answer', blurb: 'People asking what it costs get the number, not a wait.',
    icon: HandCoins, tone: 'dm',
    draft: base({
      name: 'Price question → answer', trigger: 'dm', keywords: ['price', 'cost', 'how much'], priority: 40, cooldownMinutes: 1440,
      replyText: 'Hey {{username}} — it is $XX and includes X, Y and Z. Want me to walk you through it?',
    }),
  },
  {
    key: 'giveaway_entry', name: 'Giveaway entry → confirmed', blurb: 'A comment that is just the entry word gets confirmed, with the draw date.',
    icon: Gift, tone: 'comment',
    // "is exactly", not "contains": short entry words are substrings of ordinary comments ("in" is inside
    // "amazing", "me" inside "awesome"), and a giveaway rule that answers every comment is worse than none.
    draft: base({
      name: 'Giveaway entry → confirmed', trigger: 'comment', matchMode: 'exact', keywords: ['in', 'im in', "i'm in", 'entered'], priority: 20, cooldownMinutes: 0, oncePerPerson: true,
      publicReplyText: "You're in", replyText: "You're entered, {{username}}. I draw the winner on <date> and announce it right here in your DMs.",
    }),
  },
];

export interface TemplateGalleryProps {
  onPick: (draft: RuleDraft) => void;
  /** false when the plan's rule limit is reached — picking then opens the upgrade modal instead */
  canCreate?: boolean;
  onBlocked?: () => void;
  /** the empty state gets the headline; the in-page version is quieter */
  variant?: 'empty' | 'inline';
  className?: string;
}

export function TemplateGallery({ onPick, canCreate = true, onBlocked, variant = 'empty', className }: TemplateGalleryProps) {
  const pick = (t: RuleTemplate) => {
    if (!canCreate) { onBlocked?.(); return; }
    // a fresh copy every time: the draft object is edited in place by the builder
    onPick({ ...t.draft, keywords: [...t.draft.keywords], mediaIds: [...t.draft.mediaIds] });
  };
  return (
    <section className={className}>
      {variant === 'empty' ? (
        <div className="mb-4">
          <div className="eyebrow mb-1">Start here</div>
          <h2 className="display text-[22px]">Pick a behaviour</h2>
          <p className="text-[12.5px] text-muted">Each one opens with the trigger already set. You write the message, then switch it on.</p>
        </div>
      ) : (
        <div className="mb-3 flex items-center gap-2">
          <Sparkles size={13} className="text-accent" />
          <span className="text-[13px] font-medium">Start from a template</span>
          <span className="text-[12.5px] text-muted">— the trigger is filled in, you write the message.</span>
        </div>
      )}
      <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
        {TEMPLATES.map((t) => (
          <button
            key={t.key} type="button" onClick={() => pick(t)}
            className="card p-3.5 text-left transition-all hover:border-line-2 hover:-translate-y-[1px] active:translate-y-0"
          >
            <span className="flex items-start gap-3">
              <span className={cn('mt-0.5 h-8 w-8 shrink-0 grid place-items-center rounded-lg', t.tone === 'comment' ? 'bg-warn-soft text-warn' : 'bg-accent-soft text-accent')}>
                <t.icon size={15} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[13.5px] font-medium">{t.name}</span>
                <span className="mt-0.5 block text-[12.5px] text-muted leading-relaxed">{t.blurb}</span>
              </span>
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}

/* Onboarding / first-run types (docs/dev/ROUND5-SPEC.md §7). Owned by the web-onboarding agent. */

export interface OnboardingSteps {
  import: { done: boolean; count: number };
  analyze: { done: boolean; analyzed: number; total: number; running: boolean };
  ask: { done: boolean };
  /** hasOpenedLibraryOrGraph — set by POST /api/onboarding/event { key: 'explored' } */
  explore: { done: boolean };
  connectInstagram: { done: boolean; available: boolean };
  companion: { done: boolean };
}
export type SuggestedNext = 'import' | 'wait' | 'ask' | 'explore' | 'connect' | 'done';
export interface OnboardingState {
  steps: OnboardingSteps;
  dismissed: boolean;
  /** no items and never dismissed */
  firstRun: boolean;
  suggestedNext: SuggestedNext;
  /** optional extras a server may add; tolerated, never required */
  welcomeSeen?: boolean;
  /** client-only: true when GET /api/onboarding was unavailable and the state was derived from /api/stats + /api/jobs/status */
  derived?: boolean;
}
export type OnboardingEventKey = 'explored' | 'dismissed' | 'asked' | 'welcome_seen';

/** GET /api/ask/suggestions — normalised to plain strings (see useAskSuggestions in components/Onboarding.tsx; Companion/pairing types live in types-instagram.ts) */
export type Suggestion = string;

/** Welcome flow steps (?step=1|2|3) */
export type WelcomeStep = 1 | 2 | 3;

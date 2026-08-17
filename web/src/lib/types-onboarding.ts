/* Onboarding / first-run types (docs/dev/ROUND5-SPEC.md §7, rebuilt as a linear wizard in ROUND7-SPEC §2). Owned by the web-onboarding agent. */
import type { WorkerStatus } from './types';

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
  /** the wizard was finished or left for good (meta key `onboarding_welcome_done`); older servers omit it */
  welcomeDone?: boolean;
  /** furthest wizard screen reached, 1–5 (meta key `onboarding_welcome_step`); older servers omit it, so the URL and localStorage stay the first source of truth */
  welcomeStep?: number;
  /** client-only: true when GET /api/onboarding was unavailable and the state was derived from /api/stats + /api/jobs/status */
  derived?: boolean;
}
export type OnboardingEventKey = 'explored' | 'dismissed' | 'asked' | 'welcome_seen' | 'welcome_done';
/** `POST /api/onboarding/event { key: 'welcome_step', value }` — the one event that carries a number instead of a flag. */
export interface WelcomeStepEvent { key: 'welcome_step'; value: WelcomeStep }

/** GET /api/ask/suggestions — normalised to plain strings (see useAskSuggestions in components/Onboarding.tsx; Companion/pairing types live in types-instagram.ts) */
export type Suggestion = string;

/* ---------------------------------------------------------------- the wizard ---------------------------------------------------------------- */

/** Welcome wizard screens (`?step=1…5`): saves → analysis → first question → Instagram → done. */
export type WelcomeStep = 1 | 2 | 3 | 4 | 5;
export const WELCOME_STEPS: WelcomeStep[] = [1, 2, 3, 4, 5];

/** How screen 1 is bringing saves in. Mirrored to localStorage so a reload lands back on the same panel. */
export type BringMethod = 'choose' | 'companion' | 'upload';

/** GET /api/jobs/status carries hosted extras (HOSTED-SPEC §7b) that the shared WorkerStatus doesn't declare. */
export type WorkerStatusX = WorkerStatus & {
  planBlocked?: boolean;
  quota?: { used: number; limit: number | null; remaining: number | null; resetsAt?: number | null; ok?: boolean } | null;
};

/* ------------------------------------------------------- Instagram availability (§3) ------------------------------------------------------- */

/**
 * `GET /api/instagram/availability` (ROUND7-SPEC §3) → `{ canConnect, mode, reason, waitlist }`.
 * `unknown` is web-only: the endpoint is not on this server yet, so we say we cannot tell instead of promising a button that fails.
 */
export type IgAvailabilityMode = 'live' | 'development' | 'unconfigured' | 'unknown';
export interface IgAvailability {
  canConnect: boolean;
  mode: IgAvailabilityMode;
  /** one sentence a non-developer understands; the UI shows it verbatim when we have nothing better */
  reason: string;
  /** this tenant already asked to be told when connecting opens */
  waitlist: boolean;
  /** the server's own call on whether "tell me when it's ready" makes sense here */
  waitlistOffered?: boolean;
  /** the address the server has on file for this tenant's waitlist row — shown instead of guessing from the session */
  waitlistEmail?: string | null;
  connected: boolean;
  username: string | null;
  /** client-only: derived from /api/instagram/account because the availability endpoint is missing */
  derived?: boolean;
}

/** `POST /api/instagram/waitlist` → the server's own confirmation sentence, so screen 4 never invents which address we wrote down. */
export interface IgWaitlistResult {
  waitlist: boolean;
  alreadyOn: boolean;
  email: string | null;
  message: string | null;
}

/** Why "tell me when it's ready" did not work. `missing` = no such endpoint (older server); `rejected` = the server refused, with its own sentence. */
export type IgWaitlistFailure = { kind: 'missing' } | { kind: 'rejected'; message: string };

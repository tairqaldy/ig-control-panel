/* Data layer for the Profile score page (ROUND7 §4).
   The server answers its failure cases with a full payload plus a `code`, so `rate_limited`,
   `profile_required` and `ai_unavailable` come back as *state* rather than as thrown errors — the page
   keeps showing the last report and says what happened. Only 402 (quota) and the unexpected throw. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import {
  EMPTY_SCORE_STATE, normalizeQuestions, normalizeScoreState,
  type ProfileGoals, type ProfileQuestionsState, type ProfileScoreState, type ProfileSubject,
} from '../../lib/types-profile';

export const PROFILE_QUESTIONS_KEY = ['profile-questions'] as const;
export const PROFILE_SCORE_KEY = ['profile-score'] as const;

/** 404 / 501, or a 200 that is the SPA html because the route does not exist on this build. */
const isMissing = (e: unknown) => e instanceof ApiError && (e.status === 404 || e.status === 501);
/** Failure bodies that are really a payload: render them instead of throwing. */
const STATE_CODES = ['rate_limited', 'profile_required', 'ai_unavailable'];
function stateFromError(e: unknown): ProfileScoreState | null {
  if (!(e instanceof ApiError) || !e.body || typeof e.body !== 'object') return null;
  const code = String((e.body as { code?: unknown }).code ?? '');
  return STATE_CODES.includes(code) ? normalizeScoreState(e.body) : null;
}

export async function fetchProfileQuestions(): Promise<ProfileQuestionsState> {
  try {
    const r = await api.get<unknown>('/api/profile/questions');
    if (!r || typeof r !== 'object') return { questions: [], goals: null, subject: null, unavailable: true };
    return normalizeQuestions(r);
  } catch (e) {
    if (isMissing(e)) return { questions: [], goals: null, subject: null, unavailable: true };
    throw e;
  }
}

export async function fetchProfileScore(): Promise<ProfileScoreState> {
  try {
    const r = await api.get<unknown>('/api/profile/score');
    if (!r || typeof r !== 'object') return { ...EMPTY_SCORE_STATE, unavailable: true };
    return normalizeScoreState(r);
  } catch (e) {
    if (isMissing(e)) return { ...EMPTY_SCORE_STATE, unavailable: true };
    throw e;
  }
}

export function useProfileQuestions(enabled = true) {
  return useQuery({ queryKey: PROFILE_QUESTIONS_KEY, queryFn: fetchProfileQuestions, enabled, staleTime: 5 * 60_000, retry: 1 });
}

export function useProfileScoreQuery() {
  return useQuery({ queryKey: PROFILE_SCORE_KEY, queryFn: fetchProfileScore, staleTime: 30_000, retry: 1 });
}

export function useSaveGoals() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (goals: ProfileGoals) => {
      // Saving the answers must never be the reason a score does not run — they travel with the run too.
      try { await api.post('/api/profile/goals', goals); } catch (e) { if (!isMissing(e)) throw e; }
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: PROFILE_QUESTIONS_KEY }); },
  });
}

/** What the person pasted when Instagram is not connected — the one place the feature must work without it. */
export type ManualProfileInput = Pick<ProfileSubject, 'username' | 'name' | 'bio' | 'link'>;
export interface RunScoreInput { manual?: ManualProfileInput | null; goals?: ProfileGoals | null }

export function useRunScore() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: RunScoreInput = {}): Promise<ProfileScoreState> => {
      const m = input.manual;
      // Every key present in `manual` overwrites the stored paste, so an empty object would erase it:
      // send the block only when the person actually typed something.
      const manual = m && (m.username || m.name || m.bio || m.link)
        ? { username: m.username || null, name: m.name || null, bio: m.bio || null, link: m.link || null }
        : null;
      const body: Record<string, unknown> = {};
      if (manual) body.manual = manual;
      if (input.goals) body.goals = input.goals;
      try {
        const r = await api.post<unknown>('/api/profile/score', body);
        return r && typeof r === 'object' ? normalizeScoreState(r) : { ...EMPTY_SCORE_STATE };
      } catch (e) {
        const state = stateFromError(e);
        if (state) return state;
        throw e;
      }
    },
    onSuccess: (state) => {
      qc.setQueryData(PROFILE_SCORE_KEY, state);
      if (state.goals) void qc.invalidateQueries({ queryKey: PROFILE_QUESTIONS_KEY });
      if (state.charged) void qc.invalidateQueries({ queryKey: ['plan'] }); // a credit was spent
    },
  });
}

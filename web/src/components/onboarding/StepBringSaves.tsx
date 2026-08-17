/**
 * Screen 1 — Bring your saves in (ROUND7-SPEC §2).
 *
 * One decision: install the Companion (opens the install page, then shows the pairing code and watches for the pairing
 * on its own) or upload an Instagram export. While waiting we show what is about to happen, not a bare spinner, and the
 * screen advances by itself the moment the first save lands.
 *
 * Which of the two leads depends on `COMPANION_IS_STORE`: while the extension is not in the Chrome Web Store,
 * installing it means downloading a zip and switching on Developer mode, which a distracted person cannot finish — so
 * the export upload takes the primary button and the Companion says plainly what it costs. The spec's order comes back
 * on its own the day `VITE_COMPANION_URL` points at the store.
 */
import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import { Check, ExternalLink, FileUp, Loader2, TriangleAlert } from 'lucide-react';
import type { BringMethod } from '../../lib/types-onboarding';
import { cn, isHandheld } from '../../lib/utils';
import { ChromeGlyph } from '../instagram/icons';
import { DropZone, PairingCode, useImports } from '../import';
import { COMPANION_DEVICES_KEY, COMPANION_INSTALL_URL, COMPANION_IS_STORE, fetchCompanionDevices } from '../import/useCompanion';
import { WizardShell, type StepProps } from './WizardShell';
import { useJobs } from './useWizard';

const METHOD_KEY = 'rs-welcome-bring';
const readMethod = (): BringMethod => {
  try { const v = localStorage.getItem(METHOD_KEY); return v === 'companion' || v === 'upload' ? v : 'choose'; } catch { return 'choose'; }
};

const EXPORT_REQUEST_URL = 'https://accountscenter.instagram.com/info_and_permissions/dyi/';

/** Store install: two clicks and a code. Zip install: the real four steps, named, because half-told is worse than long. */
const PAIR_STEPS: Array<[string, string]> = COMPANION_IS_STORE
  ? [
      ['Add it to Chrome', 'In the tab that just opened, click “Add to Chrome”, then confirm.'],
      ['Paste this code in the Companion', 'Click the Resurfly icon next to Chrome’s address bar and paste this code.'],
      ['Your saves start arriving', 'The first sync walks your whole saved list. A big library takes a few minutes.'],
    ]
  : [
      ['Download the zip from that page', 'The Companion is not in the Chrome Web Store yet, so Chrome installs it from a folder on your computer.'],
      ['Load it into Chrome', 'Unzip it. Open chrome://extensions, switch on Developer mode, click “Load unpacked” and choose that folder.'],
      ['Paste this code in the Companion', 'Click the Resurfly icon next to Chrome’s address bar and paste this code.'],
      ['Your saves start arriving', 'The first sync walks your whole saved list. A big library takes a few minutes.'],
    ];
/** The code belongs under the line that tells them to paste it, and nowhere earlier — before the extension is in Chrome it is just a number to worry about. */
const CODE_STEP = PAIR_STEPS.findIndex(([t]) => t.startsWith('Paste'));

export function StepBringSaves({ step, onStep, onLeave, next }: StepProps) {
  const [method, setMethod] = useState<BringMethod>(readMethod);
  /* A Chrome extension cannot be installed on a phone. Offering it there — as the primary button, the day the store
     listing lands — is a first step that cannot be finished, on the layout the spec calls primary. */
  const handheld = isHandheld();
  const qc = useQueryClient();
  const jobs = useJobs(true);
  const total = jobs.data?.total ?? 0;

  // Faster poll than the shared 30 s one: this screen is literally waiting for the pairing.
  const devices = useQuery({ queryKey: COMPANION_DEVICES_KEY, queryFn: fetchCompanionDevices, refetchInterval: method === 'companion' ? 4000 : 30_000, retry: 1 });
  const paired = (devices.data?.devices.length ?? 0) > 0;
  const companionUnavailable = !!devices.data?.unavailable;

  const imports = useImports({ autoAnalyze: true, onDone: () => { void qc.invalidateQueries({ queryKey: ['jobs-status'] }); } });
  const importError = imports.exportZip.isError && !imports.exportZip.isPending ? String((imports.exportZip.error as Error | null)?.message || 'That file could not be read.') : null;

  const pick = (m: BringMethod) => { setMethod(m); try { localStorage.setItem(METHOD_KEY, m); } catch {} };

  // Auto-advance the moment the first save lands — but only on a transition we watched, so someone who walked
  // back to this screen with a full library isn't bounced straight out of it.
  const baseline = useRef<number | null>(null);
  const advanced = useRef(false);
  const [advancing, setAdvancing] = useState(false);
  useEffect(() => {
    if (jobs.data === undefined || advanced.current) return;
    if (baseline.current === null) { baseline.current = total; return; }
    if (baseline.current === 0 && total > 0) { advanced.current = true; setAdvancing(true); next(); }
  }, [total, jobs.data, next]);

  /* Quiet text always offers a way on: forward once there is something to see, out of setup while there is not. */
  const later = total > 0
    ? { label: 'Move on to the next step', onClick: next }
    : { label: 'I’ll bring my saves in later', onClick: onLeave };

  const openStore = () => {
    window.open(COMPANION_INSTALL_URL, '_blank', 'noopener,noreferrer');
    pick('companion');
  };

  const companionCard = (
    <li className="card p-4">
      <div className="mb-1 inline-flex items-center gap-2 font-medium text-ink"><ChromeGlyph size={15} /> Companion</div>
      <div className="text-muted leading-relaxed">
        {handheld
          ? 'Keeps syncing on its own every few hours — but it is a Chrome extension, so it has to be installed on a computer.'
          : COMPANION_IS_STORE
            ? 'Keeps syncing on its own every few hours. Two clicks and one code.'
            : 'Keeps syncing on its own every few hours. Not in the Chrome Web Store yet, so installing it needs Developer mode.'}
      </div>
    </li>
  );
  const exportCard = (
    <li className="card p-4">
      <div className="mb-1 inline-flex items-center gap-2 font-medium text-ink"><FileUp size={15} /> Instagram export</div>
      <div className="text-muted leading-relaxed">A one-off ZIP from Instagram. Nothing to install; the file can take a few hours to arrive.</div>
    </li>
  );

  /* ---------------- choose ---------------- */
  if (method === 'choose') {
    const companionAction = { label: handheld ? 'Install the Companion on a computer' : 'Install the Companion', onClick: openStore, icon: <ChromeGlyph size={16} /> };
    const uploadAction = { label: 'Upload an Instagram export', onClick: () => pick('upload'), icon: <FileUp size={15} /> };
    const companionLeads = COMPANION_IS_STORE && !handheld;
    return (
      <WizardShell
        step={step} onStep={onStep} onLeave={onLeave}
        title="Bring your saves in"
        body={handheld
          ? 'On a phone, the upload is the way in. The Companion is a Chrome extension and needs a computer.'
          : COMPANION_IS_STORE
            ? 'The Companion is a small Chrome extension. It reads your saved posts while you are signed in to Instagram and sends them here.'
            : 'Two ways in. The upload needs nothing installed; the Companion keeps syncing later but Chrome has to install it by hand.'}
        primary={companionLeads ? companionAction : uploadAction}
        secondary={companionLeads ? uploadAction : companionAction}
        later={later}
        footNote="Nothing is posted or changed on Instagram. You can remove the Companion at any time."
      >
        <ul className="grid gap-2.5 text-[13.5px] sm:grid-cols-2">
          {companionLeads ? <>{companionCard}{exportCard}</> : <>{exportCard}{companionCard}</>}
        </ul>
        {total > 0 && <WaitStrip paired={false} total={total} advancing={advancing} />}
      </WizardShell>
    );
  }

  /* ---------------- companion: pair, then wait ----------------
     The one filled button here is the pairing code inside the list, so the action bar deliberately has no
     primary of its own until the saves are actually in. */
  if (method === 'companion') {
    return (
      <WizardShell
        step={step} onStep={onStep} onLeave={onLeave}
        back={() => pick('choose')}
        title={paired ? 'Paired — your saves are on their way' : 'Now pair it with this account'}
        body={paired
          ? 'The first sync is running. This screen moves on by itself as soon as your saves arrive.'
          : `${PAIR_STEPS.length} short things, then this screen moves on by itself.`}
        primary={total > 0 ? { label: 'See what it found', onClick: next } : undefined}
        secondary={total > 0 ? undefined : { label: 'Upload an Instagram export instead', onClick: () => pick('upload'), icon: <FileUp size={15} /> }}
        later={later}
      >
        {companionUnavailable ? (
          <div className="card p-5 text-[13.5px] text-ink-2">This server does not offer Companion pairing. Use the Instagram export instead — the button below switches to it.</div>
        ) : (
          <ol className="space-y-3">
            {PAIR_STEPS.map(([t, d], i) => (
              <li key={t} className="flex gap-3">
                {/* Only the pairing itself is something we can actually observe — ticking steps we cannot see would be guessing. */}
                <span className={cn('mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full border font-mono text-[11px]', paired ? 'border-accent bg-accent text-accent-ink' : 'border-line text-muted')}>
                  {paired ? <Check size={13} strokeWidth={3} /> : i + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-[14px] font-medium">{t}</div>
                  <div className="mt-0.5 text-[13px] text-muted leading-relaxed">
                    {d}
                    {i === 0 && <> <button onClick={openStore} className="underline decoration-line-2 underline-offset-2 hover:text-ink">Open that page again</button>.</>}
                  </div>
                  {/* Minted when they ask for it, not on mount: the code lives five minutes and this step sits behind
                      "download the zip, unzip it, switch on Developer mode", so an auto-started code was usually dead
                      by the time it was pasted — and the person had already copied the expired number. */}
                  {i === CODE_STEP && <PairingCode className="mt-2.5" primary />}
                </div>
              </li>
            ))}
          </ol>
        )}
        <WaitStrip paired={paired} total={total} advancing={advancing} />
      </WizardShell>
    );
  }

  /* ---------------- Instagram export ---------------- */
  return (
    <WizardShell
      step={step} onStep={onStep} onLeave={onLeave}
      back={() => pick('choose')}
      title="Upload your Instagram export"
      body="Instagram can e-mail you a copy of your data. Drop that ZIP here and we read the saved posts out of it."
      primary={total > 0
        ? { label: 'See what it found', onClick: next }
        : { label: 'Ask Instagram for my export', onClick: () => window.open(EXPORT_REQUEST_URL, '_blank', 'noopener,noreferrer'), icon: <ExternalLink size={15} /> }}
      secondary={{ label: 'Use the Companion instead', onClick: () => pick('companion'), icon: <ChromeGlyph size={15} /> }}
      later={later}
      footNote="Choose “Saved posts” when Instagram asks what to include. The file can take a few hours to arrive."
    >
      <DropZone
        accept=".zip,application/zip"
        busy={imports.exportZip.isPending}
        onFile={(f) => imports.exportZip.mutate(f)}
        label="Drop the ZIP here, or tap to choose it"
        hint="instagram-yourname.zip, straight from Instagram’s e-mail"
      />
      {/* The server's refusals are specific and long ("request only Saved, JSON, low media quality"). Delivered only
          as a four-second toast, on a phone, behind the sticky action bar, they may as well not exist — and the drop
          zone goes back to looking untouched. Keep the sentence on screen until the next attempt. */}
      {importError && (
        <div className="mt-3 flex items-start gap-2.5 rounded-xl border border-danger/40 bg-danger-soft/60 px-3.5 py-3 text-[13px]" role="alert">
          <TriangleAlert size={15} className="mt-0.5 shrink-0 text-danger" />
          <span className="text-ink-2 leading-relaxed">{importError}</span>
        </div>
      )}
      <WaitStrip paired={false} total={total} advancing={advancing} />
    </WizardShell>
  );
}

/** Says what is happening in one line — never a spinner on its own. */
function WaitStrip({ paired, total, advancing }: { paired: boolean; total: number; advancing: boolean }) {
  const done = total > 0;
  return (
    <AnimatePresence mode="wait">
      <motion.div
        key={done ? 'in' : paired ? 'paired' : 'wait'}
        initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
        className={cn('mt-5 flex items-center gap-2.5 rounded-xl border px-3.5 py-2.5 text-[13px]', done ? 'border-accent/40 bg-accent-soft/50' : 'border-line bg-surface')}
      >
        {done ? <Check size={15} className="shrink-0 text-accent" /> : <Loader2 size={15} className="shrink-0 animate-spin text-muted" />}
        <span className="text-ink-2">
          {done
            ? <><b>{total.toLocaleString()}</b> save{total === 1 ? '' : 's'} are in.{advancing ? ' Moving on…' : ''}</>
            : paired ? 'Paired. Waiting for the first saves to come across.' : 'Waiting — this page notices on its own, nothing to refresh.'}
        </span>
      </motion.div>
    </AnimatePresence>
  );
}

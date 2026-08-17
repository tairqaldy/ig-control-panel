import { useEffect } from 'react';
import { MarketingPage, PublicHeader, PublicFooter, PricingSection, CostNote, FAQ, FAQ_ITEMS, Section } from '../components/marketing';
import { usePlansCatalog } from '../components/Pricing';
import { CREDIT_RULE_LINE, CREDIT_UNIT_LINE, fmtCredits, perCreditLabel } from '../lib/types-credits';

/** The credit packs, priced from the live catalog. Buying happens in Billing, so these are read-only cards here. */
function CreditsSection() {
  const { catalog } = usePlansCatalog();
  return (
    <Section id="credits" eyebrow="Credits" title="Need more than your plan in one month? Top up." lead={`${CREDIT_UNIT_LINE} ${CREDIT_RULE_LINE}`}>
      <div className="grid gap-4 sm:grid-cols-3">
        {catalog.creditPacks.map((p) => (
          <div key={p.id} className="card p-5">
            <div className="flex items-baseline gap-1.5"><span className="display text-[30px] tabular">{fmtCredits(p.credits)}</span><span className="text-[13px] text-muted">credits</span></div>
            <div className="text-[13px] text-ink-2 mt-1">${p.price} one time</div>
            {perCreditLabel(p) && <div className="text-[12px] text-muted mt-0.5">{perCreditLabel(p)}</div>}
          </div>
        ))}
      </div>
      <div className="mt-4 text-[12px] text-muted">Buy them on the Billing page once you have an account. Prepaid, non-refundable once spent, not transferable between accounts.</div>
    </Section>
  );
}

/** /pricing — the same pricing section as the landing, standalone, plus credits and the money-related FAQ. Light paper like the landing. */
export default function Pricing() {
  useEffect(() => { document.title = 'Pricing — Resurfly'; return () => { document.title = 'Resurfly'; }; }, []);
  const items = FAQ_ITEMS.filter((f) => /trial ends|cancel|Pro and Studio|Can I export|run it myself/i.test(f.q));
  return (
    <MarketingPage>
      <PublicHeader active="pricing" />
      <PricingSection id="plans" />
      <CreditsSection />
      <CostNote />
      <Section eyebrow="Questions about money" title="Before you pay.">
        <FAQ items={items} />
      </Section>
      <PublicFooter />
    </MarketingPage>
  );
}

import { useEffect } from 'react';
import { MarketingPage, PublicHeader, PublicFooter, PricingSection, CostNote, FAQ, FAQ_ITEMS, Section } from '../components/marketing';

/** /pricing — the same pricing section as the landing, standalone, plus the money-related FAQ. Light paper like the landing. */
export default function Pricing() {
  useEffect(() => { document.title = 'Pricing — Resurfly'; return () => { document.title = 'Resurfly'; }; }, []);
  const items = FAQ_ITEMS.filter((f) => /trial ends|cancel|Pro and Studio|Can I export|run it myself/i.test(f.q));
  return (
    <MarketingPage>
      <PublicHeader active="pricing" />
      <PricingSection id="plans" />
      <CostNote />
      <Section eyebrow="Questions about money" title="Before you pay.">
        <FAQ items={items} />
      </Section>
      <PublicFooter />
    </MarketingPage>
  );
}

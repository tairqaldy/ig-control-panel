import { PublicHeader, PublicFooter, PricingSection, CostNote, FAQ, FAQ_ITEMS, Section } from '../components/marketing';

/** /pricing — the same pricing section as the landing, standalone, plus the money-related FAQ. */
export default function Pricing() {
  const items = FAQ_ITEMS.filter((f) => /trial|cancel|Pro and Studio|export|run it myself/i.test(f.q));
  return (
    <div className="relative z-[1] min-h-full">
      <PublicHeader active="pricing" />
      <PricingSection id="plans" title={<>Three days free, then <span className="text-accent">$12</span> a month. Or self-host for free.</>} />
      <CostNote />
      <Section eyebrow="Questions about money" title="Before you pay.">
        <FAQ items={items} />
      </Section>
      <PublicFooter />
    </div>
  );
}

/**
 * The shared layout of the /privacy and /terms pages.
 *
 * Both are long runs of plain text, so they share one readable column, the same heading styles, and the same contact
 * address.
 */

const CONTACT_EMAIL = "kam.yin.yip@gmail.com";

export function LegalSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="font-display text-2xl">{title}</h2>
      {children}
    </section>
  );
}

/** The address privacy requests and questions about the terms go to, as a mailto link. */
export function LegalContact() {
  return (
    <a href={`mailto:${CONTACT_EMAIL}`} className="text-link">
      {CONTACT_EMAIL}
    </a>
  );
}

export function LegalPage({
  title,
  lastUpdated,
  children,
}: {
  title: string;
  lastUpdated: string;
  children: React.ReactNode;
}) {
  return (
    <article className="mx-auto max-w-2xl space-y-8 text-sm leading-relaxed sm:text-base [&_li]:ml-5 [&_ul]:list-disc [&_ul]:space-y-1">
      <header className="space-y-2">
        <h1 className="font-display text-4xl">{title}</h1>
        <p className="text-muted-foreground">Last updated {lastUpdated}</p>
      </header>
      {children}
    </article>
  );
}

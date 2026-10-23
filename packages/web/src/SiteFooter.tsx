// Site-wide footer: the mark and a one-line pitch, the main pages, project links, and the
// project's GitHub and X accounts. Shown under every page except the full-viewport canvases.
// Marks: Simple Icons (https://simpleicons.org, CC0-1.0).
import type { ReactNode } from "react";
import { Wordmark } from "./Wordmark.tsx";

const REPO_URL = "https://github.com/OpenTraceIntelligence/OSSTrace";
/** The project's X (Twitter) account. */
const X_URL = "https://x.com/OSSTrace";
/** All the project's other links in one place. */
const LINKTREE_URL = "https://linktr.ee/OpenSourceTrace";

const PRODUCT_LINKS: readonly { label: string; href: string }[] = [
  { label: "Explorer", href: "#" },
  { label: "Visualizer", href: "#graph" },
  { label: "Tracer", href: "#trace" },
  { label: "Alerts", href: "#alerts" },
  { label: "Labels", href: "#labels" },
  { label: "Bounties", href: "#bounties" },
];

const PROJECT_LINKS: readonly { label: string; href: string }[] = [
  { label: "Source code", href: REPO_URL },
  { label: "Contributing guide", href: `${REPO_URL}/blob/main/CONTRIBUTING.md` },
  { label: "Design decisions", href: `${REPO_URL}/tree/main/docs/adr` },
  { label: "Report an issue", href: `${REPO_URL}/issues` },
];

export default function SiteFooter() {
  return (
    <footer className="border-t border-line">
      <div className="mx-auto grid w-full max-w-[96rem] grid-cols-2 gap-10 px-4 py-12 sm:px-6 md:grid-cols-[1.4fr_1fr_1fr]">
        <div className="col-span-2 max-w-sm md:col-span-1">
          <a href="#" className="inline-flex rounded-md transition-opacity duration-150 hover:opacity-85" aria-label="OSSTrace home">
            <Wordmark />
          </a>
          <p className="mt-3 text-sm leading-relaxed text-ink-dim">Open-source on-chain intelligence for Ethereum, BNB Chain, Robinhood Chain, Base and Solana. Every number shows where it came from.</p>
          <div className="mt-5 flex items-center gap-2">
            <Social href={REPO_URL} label="OSSTrace on GitHub">
              <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
            </Social>
            {X_URL && (
              <Social href={X_URL} label="OSSTrace on X">
                <path d="M14.234 10.162 22.977 0h-2.072l-7.591 8.824L7.251 0H.258l9.168 13.343L.258 24H2.33l8.016-9.318L16.749 24h6.993zm-2.837 3.299-.929-1.329L3.076 1.56h3.182l5.965 8.532.929 1.329 7.754 11.09h-3.182z" />
              </Social>
            )}
            {LINKTREE_URL && (
              <Social href={LINKTREE_URL} label="All OSSTrace links (Linktree)">
                {/* A plain link glyph, not Linktree's own brand mark -- same reasoning as every
                    other "don't guess a brand path from memory" icon in this codebase. */}
                <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 15l6 -6" />
                  <path d="M11 6l.463 -.536a5 5 0 0 1 7.071 7.072l-.534 .464" />
                  <path d="M13 18l-.397 .534a5.068 5.068 0 0 1 -7.127 0a4.972 4.972 0 0 1 0 -7.071l.524 -.463" />
                </g>
              </Social>
            )}
          </div>
        </div>
        <LinkColumn title="Product" links={PRODUCT_LINKS} />
        <LinkColumn title="Project" links={PROJECT_LINKS} external />
      </div>
      <div className="border-t border-line">
        <div className="mx-auto flex w-full max-w-[96rem] flex-col gap-1 px-4 py-5 text-xs text-ink-faint sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <span>© {new Date().getFullYear()} OSSTrace contributors. Open source under AGPL-3.0.</span>
          <span>No affiliation with any proprietary platform.</span>
        </div>
      </div>
    </footer>
  );
}

function LinkColumn({ title, links, external }: { title: string; links: readonly { label: string; href: string }[]; external?: boolean }) {
  return (
    <nav aria-label={title}>
      <div className="text-xs font-medium text-ink-faint">{title}</div>
      <ul className="mt-3 space-y-2">
        {links.map((link) => (
          <li key={link.label}>
            <a
              href={link.href}
              {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
              className="text-sm text-ink-dim transition-colors duration-150 hover:text-ink"
            >
              {link.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function Social({ href, label, children }: { href: string; label: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={label}
      title={label}
      className="flex h-9 w-9 items-center justify-center rounded-full bg-[var(--helium-elevated-7)] text-ink-dim transition-colors duration-150 hover:bg-[var(--helium-elevated-10)] hover:text-ink"
    >
      <svg viewBox="0 0 24 24" width={16} height={16} fill="currentColor" aria-hidden="true">
        {children}
      </svg>
    </a>
  );
}

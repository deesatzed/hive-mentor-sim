import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Mentor Hive",
  description: "A local simulation of one mind built from a swarm of mentor-grounded Voices.",
};

const NAV: [string, string][] = [
  ["/hive", "Talk"],
  ["/formation", "Formation"],
  ["/constitution", "Constitution"],
  ["/reveal", "Reveal"],
  ["/calibration", "Calibration"],
  ["/predictions", "Predictions"],
  ["/interoception", "Interoception"],
  ["/ledger", "Ledger"],
  ["/settings", "Settings"],
];

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>
        <a className="skip-link" href="#content">
          Skip to content
        </a>
        <header className="site-header">
          <Link href="/" className="brand">
            Mentor Hive
          </Link>
          <span className="sim-label" data-testid="sim-label">
            Simulation
          </span>
          <nav aria-label="Main" className="site-nav">
            {NAV.map(([href, label]) => (
              <Link key={href} href={href}>
                {label}
              </Link>
            ))}
          </nav>
        </header>
        <div id="content" tabIndex={-1}>
          {children}
        </div>
      </body>
    </html>
  );
}

import Link from "next/link";
import { DueBanner } from "./due-banner";

export default function Home() {
  return (
    <main className="home">
      <h1>Mentor Hive</h1>
      <p>A simulated mind made of cooperating Voices. Proof of concept (M10): every page is in the menu above; Ledger shows measured spend, Settings shows the configured models.</p>
      <p>
        <Link href="/hive">Talk to the Hive</Link> · <Link href="/interoception">Interoception</Link> · <Link href="/formation">Formation</Link> · <Link href="/constitution">Constitution</Link> · <Link href="/reveal">Reveal</Link> · <Link href="/calibration">Calibration</Link> · <Link href="/predictions">Predictions</Link> · <Link href="/ledger">Ledger</Link> · <Link href="/settings">Settings</Link>
      </p>
      <DueBanner />
    </main>
  );
}

import Link from "next/link";
import { DueBanner } from "./due-banner";

export default function Home() {
  return (
    <main className="home">
      <h1>Mentor Hive</h1>
      <p>A simulated mind made of cooperating Voices. Milestone M9: predictions and track record, signals and patterns, advisors with endorsement.</p>
      <p>
        <Link href="/hive">Talk to the Hive</Link> · <Link href="/interoception">Interoception</Link> · <Link href="/formation">Formation</Link> · <Link href="/constitution">Constitution</Link> · <Link href="/reveal">Reveal</Link> · <Link href="/calibration">Calibration</Link> · <Link href="/predictions">Predictions</Link>
      </p>
      <DueBanner />
    </main>
  );
}

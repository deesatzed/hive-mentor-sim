import Link from "next/link";

export default function Home() {
  return (
    <main className="home">
      <h1>Mentor Hive</h1>
      <p>A simulated mind made of cooperating Voices. Milestone M7: Reveal, declared vs. revealed character.</p>
      <p>
        <Link href="/hive">Talk to the Hive</Link> · <Link href="/interoception">Interoception</Link> · <Link href="/formation">Formation</Link> · <Link href="/constitution">Constitution</Link> · <Link href="/reveal">Reveal</Link>
      </p>
    </main>
  );
}

import Link from "next/link";

export default function Home() {
  return (
    <main className="home">
      <h1>Mentor Hive</h1>
      <p>A simulated mind made of cooperating Voices. Milestone M4: the thinking cycle and its identity layer (commitments, ego audit, coherence).</p>
      <p>
        <Link href="/hive">Talk to the Hive</Link> · <Link href="/interoception">Interoception</Link>
      </p>
    </main>
  );
}

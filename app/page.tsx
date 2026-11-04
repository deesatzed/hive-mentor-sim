import Link from "next/link";

export default function Home() {
  return (
    <main className="home">
      <h1>Mentor Hive</h1>
      <p>A simulated mind made of cooperating Voices. Milestone M3: the thinking cycle runs end to end.</p>
      <p>
        <Link href="/hive">Talk to the Hive</Link>
      </p>
    </main>
  );
}

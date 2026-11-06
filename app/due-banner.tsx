"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

/** Home-page notice when prediction check-ins are due. */
export function DueBanner() {
  const [n, setN] = useState<number | null>(null);
  useEffect(() => {
    fetch("/api/predictions")
      .then((r) => r.json())
      .then((d: { due: unknown[] }) => setN(d.due.length))
      .catch(() => setN(null));
  }, []);
  if (!n) return null;
  return (
    <p data-testid="checkin-due" aria-live="polite">
      <strong>{n === 1 ? "1 check-in due" : `${n} check-ins due`}.</strong> <Link href="/predictions">Rate how the Hive&apos;s predictions turned out</Link>
    </p>
  );
}

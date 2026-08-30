import Link from "next/link";

export default function HomePage() {
  return (
    <main style={{ padding: 40, maxWidth: 640 }}>
      <h1>Cairn Demo</h1>
      <p>A tiny app used to exercise the Cairn indexer and the Copilot widget end to end.</p>
      <p>
        <Link href="/invoices">Go to Invoices →</Link>
      </p>
      <p>
        <Link href="/dashboard">View failure dashboard →</Link>
      </p>
    </main>
  );
}

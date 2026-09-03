import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Cairn Evals",
  description: "Scenario runs, traces, and capability coverage for @cairnvibe/evals.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <nav className="nav">
          <div className="nav-brand">
            cairn<span>evals</span>
          </div>
          <div className="nav-links">
            <a href="/">Scenarios</a>
            <a href="/capabilities">Capabilities</a>
            <a href="/compare">Compare</a>
            <a href="/run">Run</a>
          </div>
        </nav>
        <main>{children}</main>
      </body>
    </html>
  );
}

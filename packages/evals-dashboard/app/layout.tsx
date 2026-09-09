import type { Metadata } from "next";
import "./globals.css";
import { Sidebar } from "../components/Sidebar";

export const metadata: Metadata = {
  title: "Cairn Evals",
  description: "Scenario runs, traces, and capability coverage for @cairnvibe/evals.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="shell">
          <Sidebar />
          <main>{children}</main>
        </div>
      </body>
    </html>
  );
}

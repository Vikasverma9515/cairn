import type { ReactNode } from "react";
import { Copilot } from "@cairn/sdk";
import "./globals.css";

export const metadata = {
  title: "Cairn Demo",
  description: "A small Next.js app used to exercise the Cairn indexer and runtime SDK end-to-end.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <Copilot registeredActions={["archiveInvoice"]} />
      </body>
    </html>
  );
}

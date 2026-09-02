import type { ReactNode } from "react";
import Link from "next/link";
import { Bot, Compass, FileText, MessageSquare, TriangleAlert } from "lucide-react";
import { CairnWebMcpTools } from "../components/CairnWebMcpTools";
import { CopilotWithActions } from "../components/CopilotWithActions";
import "../components/WebMcpPolyfill"; // demo-only shim — see that file's doc comment
import "./globals.css";

export const metadata = {
  title: "Cairn Demo",
  description: "A small Next.js app used to exercise the Cairn indexer and runtime SDK end-to-end.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-[#f8f9fb] text-gray-900 antialiased">
        <nav className="flex items-center gap-6 border-b border-gray-200 bg-white px-8 py-4">
          <Link href="/" className="flex items-center gap-2 font-medium text-gray-800 hover:text-gray-950">
            <Compass size={16} /> Home
          </Link>
          <Link href="/invoices" className="flex items-center gap-2 font-medium text-gray-600 hover:text-gray-950">
            <FileText size={16} /> Invoices
          </Link>
          <Link href="/dashboard" className="flex items-center gap-2 font-medium text-gray-600 hover:text-gray-950">
            <TriangleAlert size={16} /> Failures
          </Link>
          <Link href="/sessions" className="flex items-center gap-2 font-medium text-gray-600 hover:text-gray-950">
            <MessageSquare size={16} /> Sessions
          </Link>
          <Link href="/agents" className="flex items-center gap-2 font-medium text-gray-600 hover:text-gray-950">
            <Bot size={16} /> Agents
          </Link>
        </nav>
        {children}
        <CairnWebMcpTools />
        <CopilotWithActions />
      </body>
    </html>
  );
}

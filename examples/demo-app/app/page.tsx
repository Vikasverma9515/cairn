import Link from "next/link";
import { ArrowRight, Bot, FileText, MessageSquare, TriangleAlert } from "lucide-react";

export default function HomePage() {
  return (
    <main className="mx-auto max-w-2xl px-8 py-16">
      <h1 className="text-3xl font-semibold tracking-tight text-gray-900">Cairn Demo</h1>
      <p className="mt-3 text-gray-600">
        A small app used to exercise the Cairn indexer and the Copilot widget end to end — including the real-time
        voice conversation. Click the mark in the bottom-right corner to try it.
      </p>
      <div className="mt-8 flex flex-col gap-3">
        <Link
          href="/invoices"
          className="flex items-center justify-between rounded-xl border border-gray-200 bg-white px-5 py-4 shadow-sm transition hover:border-gray-300 hover:shadow"
        >
          <span className="flex items-center gap-3 font-medium text-gray-800">
            <FileText size={18} className="text-indigo-500" /> Go to Invoices
          </span>
          <ArrowRight size={16} className="text-gray-400" />
        </Link>
        <Link
          href="/dashboard"
          className="flex items-center justify-between rounded-xl border border-gray-200 bg-white px-5 py-4 shadow-sm transition hover:border-gray-300 hover:shadow"
        >
          <span className="flex items-center gap-3 font-medium text-gray-800">
            <TriangleAlert size={18} className="text-amber-500" /> View failure dashboard
          </span>
          <ArrowRight size={16} className="text-gray-400" />
        </Link>
        <Link
          href="/sessions"
          className="flex items-center justify-between rounded-xl border border-gray-200 bg-white px-5 py-4 shadow-sm transition hover:border-gray-300 hover:shadow"
        >
          <span className="flex items-center gap-3 font-medium text-gray-800">
            <MessageSquare size={18} className="text-emerald-500" /> Sessions (no per-row id, on purpose)
          </span>
          <ArrowRight size={16} className="text-gray-400" />
        </Link>
        <Link
          href="/agents"
          className="flex items-center justify-between rounded-xl border border-gray-200 bg-white px-5 py-4 shadow-sm transition hover:border-gray-300 hover:shadow"
        >
          <span className="flex items-center gap-3 font-medium text-gray-800">
            <Bot size={18} className="text-violet-500" /> Agent Builder (click-only action, no fetch)
          </span>
          <ArrowRight size={16} className="text-gray-400" />
        </Link>
      </div>
    </main>
  );
}

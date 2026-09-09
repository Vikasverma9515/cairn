"use client";

import { usePathname } from "next/navigation";

const NAV_ITEMS = [
  {
    href: "/",
    label: "Overview",
    icon: (
      <path d="M3 3h7v7H3V3zm0 11h7v7H3v-7zm11-11h7v7h-7V3zm0 11h7v7h-7v-7z" strokeWidth="1.6" strokeLinejoin="round" />
    ),
  },
  {
    href: "/scenarios",
    label: "Scenarios",
    icon: <path d="M4 5h16M4 12h16M4 19h10" strokeWidth="1.8" strokeLinecap="round" />,
  },
  {
    href: "/capabilities",
    label: "Capabilities",
    icon: <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z M12 3v18 M4 7.5l8 4.5 8-4.5" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />,
  },
  {
    href: "/compare",
    label: "Compare",
    icon: <path d="M8 3v18M16 3v18M4 8h4M16 8h4M4 16h4M16 16h4" strokeWidth="1.6" strokeLinecap="round" />,
  },
  {
    href: "/run",
    label: "Run",
    icon: <path d="M6 4l14 8-14 8V4z" strokeWidth="1.6" strokeLinejoin="round" />,
  },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <span className="sidebar-mark">C</span>
        <span>
          cairn<b>evals</b>
        </span>
      </div>
      <nav className="sidebar-nav">
        {NAV_ITEMS.map((item) => {
          const active = item.href === "/" ? pathname === "/" : pathname?.startsWith(item.href);
          return (
            <a key={item.href} href={item.href} className={`sidebar-link ${active ? "active" : ""}`}>
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                {item.icon}
              </svg>
              {item.label}
            </a>
          );
        })}
      </nav>
      <div className="sidebar-footer">
        <a href="https://github.com/Vikasverma9515/cairn" className="sidebar-link">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <path
              d="M12 2a10 10 0 00-3.16 19.5c.5.1.68-.22.68-.48v-1.7c-2.78.6-3.37-1.34-3.37-1.34-.46-1.16-1.11-1.47-1.11-1.47-.9-.62.07-.6.07-.6 1 .07 1.53 1.03 1.53 1.03.9 1.52 2.34 1.08 2.91.83.09-.65.35-1.08.63-1.33-2.22-.25-4.56-1.11-4.56-4.94 0-1.1.39-1.99 1.03-2.69-.1-.25-.45-1.27.1-2.64 0 0 .84-.27 2.75 1.02a9.55 9.55 0 015 0c1.91-1.3 2.75-1.02 2.75-1.02.55 1.37.2 2.39.1 2.64.64.7 1.03 1.59 1.03 2.69 0 3.84-2.34 4.68-4.57 4.93.36.31.68.92.68 1.85v2.74c0 .27.18.58.69.48A10 10 0 0012 2z"
              strokeWidth="0"
              fill="currentColor"
            />
          </svg>
          Source
        </a>
      </div>
    </aside>
  );
}

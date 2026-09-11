import type { Metadata } from "next";
import "./globals.css";

const favicon =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 128 128'%3E%3Crect width='128' height='128' rx='30' fill='%231B1815'/%3E%3Cellipse cx='64' cy='83' rx='38' ry='17' fill='%23EDE6DA'/%3E%3Cellipse cx='45' cy='79' rx='18' ry='12' fill='%23EDE6DA'/%3E%3Cellipse cx='86' cy='82' rx='15' ry='11' fill='%23EDE6DA'/%3E%3Cellipse cx='55' cy='61' rx='27' ry='13' fill='%23EDE6DA' fill-opacity='.82'/%3E%3Cellipse cx='38' cy='58' rx='12' ry='8' fill='%23EDE6DA' fill-opacity='.82'/%3E%3Cellipse cx='75' cy='59' rx='11' ry='8' fill='%23EDE6DA' fill-opacity='.82'/%3E%3Cellipse cx='74' cy='39' rx='17' ry='10' fill='%23E07A3F'/%3E%3Cellipse cx='84' cy='36' rx='8' ry='6' fill='%23E07A3F'/%3E%3C/svg%3E";

export const metadata: Metadata = {
  title: "Cairn — talk to your software instead of clicking around",
  description:
    "Cairn is an agentic AI copilot that lives inside your product and actually completes real multi-step tasks for your customer — clicking, filling, navigating, or talking — while they just say what they want.",
  icons: {
    icon: favicon,
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
        <link
          href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,500;0,9..144,600;1,9..144,500;1,9..144,600&family=Work+Sans:wght@400;500;600;700;800;900&family=IBM+Plex+Mono:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}

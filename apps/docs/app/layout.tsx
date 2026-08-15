import type { ReactNode } from "react";
import Link from "next/link";
import { RootProvider } from "fumadocs-ui/provider/next";
import "./globals.css";

export const metadata = {
  title: "AgentScope",
  description: "Coding-agent observability",
};

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <RootProvider>
          <header className="site-header">
            <Link className="brand" href="/">
              <span
                className="brand-logo"
                role="img"
                aria-label="AgentScope oscilloscope"
              />
              AgentScope
            </Link>
            <nav>
              <Link href="/docs">Documentation</Link>
              <a href="https://github.com/Melbourneandrew/agentscope">GitHub</a>
            </nav>
          </header>
          {children}
        </RootProvider>
      </body>
    </html>
  );
}

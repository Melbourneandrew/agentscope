import type { ReactNode } from "react";
import Link from "next/link";
import "./globals.css";

export const metadata = {
  title: "AgentScope",
  description: "Coding-agent observability",
};

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="site-header">
          <Link className="brand" href="/">
            <span className="brand-mark" />
            AgentScope
          </Link>
          <nav>
            <Link href="/docs">Documentation</Link>
            <a href="https://github.com/Melbourneandrew/agentscope">GitHub</a>
          </nav>
        </header>
        <div className="shell">
          <aside className="sidebar">
            <p className="nav-label">Get started</p>
            <Link className="active" href="/docs">
              Introduction
            </Link>
            <Link href="/docs">Installation</Link>
            <Link href="/docs">Configuration</Link>
            <p className="nav-label">Reference</p>
            <Link href="/docs">CLI</Link>
            <Link href="/docs">Reporters</Link>
            <Link href="/docs">Harnesses</Link>
          </aside>
          <main className="content">{children}</main>
        </div>
      </body>
    </html>
  );
}

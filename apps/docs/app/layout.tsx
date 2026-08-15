import type { ReactNode } from "react";
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
          <a className="brand" href="/">
            <span className="brand-mark" />
            AgentScope
          </a>
          <nav>
            <a href="/docs">Documentation</a>
            <a href="https://github.com/Melbourneandrew/agentscope">GitHub</a>
          </nav>
        </header>
        <div className="shell">
          <aside className="sidebar">
            <p className="nav-label">Get started</p>
            <a className="active" href="/docs">
              Introduction
            </a>
            <a href="/docs">Installation</a>
            <a href="/docs">Configuration</a>
            <p className="nav-label">Reference</p>
            <a href="/docs">CLI</a>
            <a href="/docs">Reporters</a>
            <a href="/docs">Harnesses</a>
          </aside>
          <main className="content">{children}</main>
        </div>
      </body>
    </html>
  );
}

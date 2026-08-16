import type { ReactNode } from "react";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { source } from "../../lib/source";

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <DocsLayout
      tree={source.getPageTree()}
      nav={{
        title: (
          <span className="docs-brand">
            <span
              className="brand-logo"
              role="img"
              aria-label="AgentScope oscilloscope"
            />
            AgentScope
          </span>
        ),
        url: "/docs",
      }}
    >
      {children}
    </DocsLayout>
  );
}

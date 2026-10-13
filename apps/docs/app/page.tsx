import Link from "next/link";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { DocsBrand } from "./docs-brand";
import { source } from "../lib/source";

export default function Home() {
  return (
    <DocsLayout
      tree={source.getPageTree()}
      nav={{ title: <DocsBrand />, url: "/" }}
    >
      <main className="content homepage">
        <p className="eyebrow">0.1.0 alpha · publication pending</p>
        <h1>Trace the work your agents actually do.</h1>
        <p className="lead">
          Candidate evidence is complete for Codex and Claude Code on Linux x64
          CI with Langfuse. Agentscope is not published yet; start with the
          exact pre-release scope and safe setup boundary.
        </p>
        <div className="actions">
          <Link className="button primary" href="/docs/getting-started">
            Check alpha status
          </Link>
          <a
            className="button"
            href="https://github.com/Melbourneandrew/agentscope"
          >
            View source
          </a>
        </div>
        <div className="grid">
          <section className="card">
            <h2>CLI-first</h2>
            <p>Plan and inspect owned integrations through one CLI.</p>
          </section>
          <section className="card">
            <h2>Harness-aware</h2>
            <p>
              Codex and Claude Code have exact, version-bound candidate rows.
            </p>
          </section>
          <section className="card">
            <h2>Destination-bound</h2>
            <p>Alpha evidence uses the reviewed first-party Langfuse path.</p>
          </section>
        </div>
      </main>
    </DocsLayout>
  );
}

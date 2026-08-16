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
        <p className="eyebrow">Coding-agent observability</p>
        <h1>Trace the work your agents actually do.</h1>
        <p className="lead">
          Agentscope captures coding-agent sessions, normalizes the important
          events, and sends them to Langfuse or an extensible reporter you
          control.
        </p>
        <div className="actions">
          <Link className="button primary" href="/docs">
            Read the docs
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
            <p>Install and manage hooks with one global command.</p>
          </section>
          <section className="card">
            <h2>Harness-aware</h2>
            <p>
              Each coding-agent harness maps native artifacts into one model.
            </p>
          </section>
          <section className="card">
            <h2>Reporter-ready</h2>
            <p>Start with Langfuse, then add an approved destination.</p>
          </section>
        </div>
      </main>
    </DocsLayout>
  );
}

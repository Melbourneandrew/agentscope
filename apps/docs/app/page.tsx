import Link from "next/link";

export default function Home() {
  return (
    <>
      <p className="eyebrow">Coding-agent observability</p>
      <h1>Trace the work your agents actually do.</h1>
      <p className="lead">
        AgentScope captures coding-agent sessions, normalizes the important
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
          <p>
            Install and manage hooks with one global command instead of bespoke
            setup per agent.
          </p>
        </section>
        <section className="card">
          <h2>Harness-aware</h2>
          <p>
            Codex, Claude Code, and Cursor adapters translate native artifacts
            into one model.
          </p>
        </section>
        <section className="card">
          <h2>Reporter-ready</h2>
          <p>
            Start with Langfuse, then add an approved destination through a
            small TypeScript API.
          </p>
        </section>
      </div>
    </>
  );
}

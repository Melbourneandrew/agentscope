export function generateStaticParams() {
  return [{ slug: [] }];
}

export default function DocsPlaceholder() {
  return (
    <article className="docs-prose">
      <p className="eyebrow">Introduction</p>
      <h1>AgentScope documentation</h1>
      <p className="lead">
        A CLI-first system for capturing traces from coding agents and reporting
        them to Langfuse or a custom destination.
      </p>
      <h2>Planned quick start</h2>
      <pre>
        <code>
          npx @agentscope/cli init{"\n"}agent-scope configure reporter langfuse
          {"\n"}agent-scope install codex
        </code>
      </pre>
      <p>
        The Fumadocs MDX source and standard package dependencies are
        scaffolded; this styled documentation shell is ready for the first
        complete guide set.
      </p>
    </article>
  );
}

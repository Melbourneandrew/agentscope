import type { CSSProperties } from "react";

const logoStyle = {
  "--brand-logo-url": `url("${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/brand/agentscope-oscilloscope-logo.svg")`,
} as CSSProperties;

export function DocsBrand() {
  return (
    <span className="docs-brand">
      <span
        className="brand-logo"
        role="img"
        aria-label="Agentscope oscilloscope"
        style={logoStyle}
      />
      Agentscope
    </span>
  );
}

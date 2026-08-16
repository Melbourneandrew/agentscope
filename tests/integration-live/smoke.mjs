const required = [
  "LANGFUSE_PUBLIC_KEY",
  "LANGFUSE_SECRET_KEY",
  "LANGFUSE_BASE_URL",
];

const missing = required.filter((name) => !process.env[name]);
if (missing.length > 0) {
  throw new Error(
    `Live integration requires protected environment values: ${missing.join(", ")}`,
  );
}

const endpoint = new URL(process.env.LANGFUSE_BASE_URL);
if (!["http:", "https:"].includes(endpoint.protocol)) {
  throw new Error("LANGFUSE_BASE_URL must be an HTTP(S) URL");
}

console.log(
  "Live Langfuse environment is configured. Reporter emission assertions will be added with @agentscope/reporter-langfuse.",
);

const [mode, token] = process.argv.slice(2);
if (
  mode !== "leaked-child" ||
  typeof token !== "string" ||
  !/^[a-f0-9]{32}$/u.test(token)
)
  throw new Error("integration.fixture.negative-input");

process.on("SIGTERM", () => {});
process.stdout.write(`AGENTSCOPE_NEGATIVE_READY=${token}\n`, (error) => {
  if (error !== undefined && error !== null)
    throw new Error("integration.fixture.negative-readiness");
  setInterval(() => {}, 1_000);
});

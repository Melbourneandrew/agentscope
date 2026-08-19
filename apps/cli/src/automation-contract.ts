export const CLI_AUTOMATION_CONTRACT = Object.freeze({
  channels: Object.freeze({
    diagnostic: "stderr",
    plan: "stderr-before-mutation",
    result: "stdout-after-completion",
  }),
  diagnosticJson: "agentscope.cli.diagnostic.v1",
  planJson: "agentscope.cli.plan.v1",
  planJsonl: "agentscope.cli.plan-record.v1",
  planJsonlSequence: "zero-or-more-plan-records-then-one-summary",
  resultJson: "agentscope.cli.result.v1",
  resultJsonl: "agentscope.cli.record.v1",
  resultJsonlSequence: "zero-or-more-data-records-then-one-summary",
  schema: "agentscope.cli.automation-contract.v1",
});

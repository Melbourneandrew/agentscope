const endpoint = process.env.AGENTSCOPE_COLLECTOR_URL;
if (!endpoint) throw new Error("AGENTSCOPE_COLLECTOR_URL is required");

const response = await fetch(endpoint);
if (!response.ok)
  throw new Error(`collector health check failed: ${response.status}`);
console.log("Integration runner scaffold reached the isolated collector.");

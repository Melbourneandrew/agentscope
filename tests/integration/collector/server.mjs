import { createServer } from "node:http";

const received = [];
createServer((request, response) => {
  if (request.method === "POST") {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      received.push(body);
      response.writeHead(202).end();
    });
    return;
  }
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ received: received.length }));
}).listen(4318, () =>
  console.log("Agentscope mock collector listening on 4318"),
);

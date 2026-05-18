import express from "express";
import type { Request, Response } from "express";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";

// Stub AWS services in local dev
if (process.env["LOCAL_DEV"] === "1") {
  process.env["AWS_REGION"] = process.env["AWS_REGION"] ?? "us-east-1";
  process.env["COGNITO_USER_POOL_ID"] = process.env["COGNITO_USER_POOL_ID"] ?? "us-east-1_local";
  process.env["COGNITO_CLIENT_ID"] = process.env["COGNITO_CLIENT_ID"] ?? "local_client";
}

import { handler as hintHandler } from "../handlers/hint.js";
import { handler as sessionsHandler } from "../handlers/sessions.js";
import { handler as configHandler } from "../handlers/config.js";

const app = express();
app.use(express.json());

function makeEvent(req: Request, pathParameters?: Record<string, string>): APIGatewayProxyEventV2 {
  return {
    version: "2.0",
    routeKey: `${req.method} ${req.path}`,
    rawPath: req.path,
    rawQueryString: new URLSearchParams(req.query as Record<string, string>).toString(),
    headers: req.headers as Record<string, string>,
    queryStringParameters: req.query as Record<string, string>,
    pathParameters,
    requestContext: {
      accountId: "local",
      apiId: "local",
      domainName: "localhost",
      domainPrefix: "localhost",
      http: {
        method: req.method,
        path: req.path,
        protocol: "HTTP/1.1",
        sourceIp: req.ip ?? "127.0.0.1",
        userAgent: req.headers["user-agent"] ?? "",
      },
      requestId: "local-request",
      routeKey: `${req.method} ${req.path}`,
      stage: "$default",
      time: new Date().toISOString(),
      timeEpoch: Date.now(),
    },
    body: req.body ? JSON.stringify(req.body) : undefined,
    isBase64Encoded: false,
  };
}

async function handleLambda(
  handler: (event: APIGatewayProxyEventV2) => Promise<APIGatewayProxyResultV2>,
  req: Request,
  res: Response,
  pathParameters?: Record<string, string>
): Promise<void> {
  try {
    const event = makeEvent(req, pathParameters);
    const result = await handler(event);
    if (typeof result === "object" && result !== null && "statusCode" in result) {
      const r = result as { statusCode: number; headers?: Record<string, string>; body?: string };
      if (r.headers) {
        Object.entries(r.headers).forEach(([k, v]) => res.setHeader(k, v));
      }
      res.status(r.statusCode).send(r.body);
    } else {
      res.status(200).json(result);
    }
  } catch (err) {
    console.error("Handler error:", err);
    res.status(500).json({ error: "internal_error" });
  }
}

app.post("/hint", (req, res) => { void handleLambda(hintHandler, req, res); });
app.post("/sessions", (req, res) => { void handleLambda(sessionsHandler, req, res); });
app.patch("/sessions/:id", (req, res) => { void handleLambda(sessionsHandler, req, res, { id: req.params["id"] ?? "" }); });
app.get("/sessions", (req, res) => { void handleLambda(sessionsHandler, req, res); });
app.get("/config", (req, res) => { void handleLambda(configHandler, req, res); });

const PORT = parseInt(process.env["PORT"] ?? "3000", 10);
app.listen(PORT, () => {
  console.log(`[knowable-be] Local dev server running on http://localhost:${PORT}`);
  console.log("LOCAL_DEV:", process.env["LOCAL_DEV"]);
});

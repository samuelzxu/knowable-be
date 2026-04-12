import { describe, it, expect, vi, beforeEach } from "vitest";
import type { APIGatewayProxyEventV2 } from "aws-lambda";

// Mock dependencies before importing handler
vi.mock("../src/lib/auth.js", () => ({
  verifyJwt: vi.fn().mockResolvedValue({ sub: "test-user-id" }),
  extractBearerToken: vi.fn().mockReturnValue("test-token"),
}));

vi.mock("../src/lib/quota.js", () => ({
  checkAndIncrementGlobalDailyQuota: vi.fn().mockResolvedValue({ ok: true }),
  checkAndIncrementUserDailyQuota: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock("../src/lib/region-check.js", () => ({
  checkRegionOnColdStart: vi.fn().mockResolvedValue(undefined),
  assertRegionAvailable: vi.fn(),
  RegionUnavailableError: class RegionUnavailableError extends Error {
    constructor(region: string, modelId: string) {
      super(`Bedrock model ${modelId} unavailable in region ${region}`);
      this.name = "RegionUnavailableError";
    }
  },
}));

vi.mock("../src/lib/bedrock.js", () => ({
  invokeBedrock: vi.fn().mockResolvedValue({
    text: "Milo here. Here is a hint.",
    tokensIn: 100,
    tokensOut: 50,
  }),
  RegionUnavailableError: class RegionUnavailableError extends Error {
    constructor(region: string, modelId: string) {
      super(`Bedrock model ${modelId} unavailable in region ${region}`);
      this.name = "RegionUnavailableError";
    }
  },
}));

vi.mock("../src/lib/prompt.js", () => ({
  buildPassiveHintPrompt: vi.fn().mockReturnValue([{ role: "user", content: "passive prompt" }]),
  buildActiveQueryPrompt: vi.fn().mockReturnValue([{ role: "user", content: "active prompt" }]),
  NO_ANSWER_GUARDRAIL: "You must never reveal the direct final answer.",
}));

import { handler } from "../src/handlers/hint.js";
import { buildPassiveHintPrompt, buildActiveQueryPrompt } from "../src/lib/prompt.js";
import { checkAndIncrementGlobalDailyQuota, checkAndIncrementUserDailyQuota } from "../src/lib/quota.js";

function makeEvent(body: unknown, authHeader = "Bearer test-token"): APIGatewayProxyEventV2 {
  return {
    version: "2.0",
    routeKey: "POST /hint",
    rawPath: "/hint",
    rawQueryString: "",
    headers: { authorization: authHeader },
    requestContext: {
      accountId: "123",
      apiId: "api",
      domainName: "example.com",
      domainPrefix: "example",
      http: { method: "POST", path: "/hint", protocol: "HTTP/1.1", sourceIp: "1.2.3.4", userAgent: "" },
      requestId: "req-1",
      routeKey: "POST /hint",
      stage: "$default",
      time: new Date().toISOString(),
      timeEpoch: Date.now(),
    },
    body: JSON.stringify(body),
    isBase64Encoded: false,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(checkAndIncrementGlobalDailyQuota).mockResolvedValue({ ok: true });
  vi.mocked(checkAndIncrementUserDailyQuota).mockResolvedValue({ ok: true });
});

describe("hint handler", () => {
  it("routes passive_stuck to buildPassiveHintPrompt", async () => {
    const event = makeEvent({
      source: "passive_stuck",
      problem_text: "Solve for x: 2x + 5 = 13",
      transcript: "hmm",
      hint_history: [],
    });

    const result = await handler(event);
    expect(buildPassiveHintPrompt).toHaveBeenCalledOnce();
    expect(buildActiveQueryPrompt).not.toHaveBeenCalled();
    expect(result).toMatchObject({ statusCode: 200 });
  });

  it("routes active_voice to buildActiveQueryPrompt", async () => {
    const event = makeEvent({
      source: "active_voice",
      problem_text: "Solve for x: 2x + 5 = 13",
      user_query: "how do I start?",
      hint_history: [],
    });

    const result = await handler(event);
    expect(buildActiveQueryPrompt).toHaveBeenCalledOnce();
    expect(buildPassiveHintPrompt).not.toHaveBeenCalled();
  });

  it("routes active_text to buildActiveQueryPrompt", async () => {
    const event = makeEvent({
      source: "active_text",
      problem_text: "Solve for x: 2x + 5 = 13",
      user_query: "what is the next step?",
      hint_history: [],
    });

    const result = await handler(event);
    expect(buildActiveQueryPrompt).toHaveBeenCalledOnce();
    expect(buildPassiveHintPrompt).not.toHaveBeenCalled();
  });

  it("returns expected shape {hint, tokensIn, tokensOut, source}", async () => {
    const event = makeEvent({
      source: "passive_stuck",
      problem_text: "Solve for x",
      transcript: "",
      hint_history: [],
    });

    const result = await handler(event);
    const body = JSON.parse((result as { body: string }).body) as unknown;
    expect(body).toMatchObject({
      hint: expect.any(String) as unknown,
      tokensIn: expect.any(Number) as unknown,
      tokensOut: expect.any(Number) as unknown,
      source: "passive_stuck",
    });
  });

  it("returns 429 with reason=global_ceiling when global quota exceeded", async () => {
    vi.mocked(checkAndIncrementGlobalDailyQuota).mockResolvedValue({ ok: false, reason: "global_ceiling" });

    const event = makeEvent({
      source: "passive_stuck",
      problem_text: "Solve for x",
      transcript: "",
    });

    const result = await handler(event);
    expect((result as { statusCode: number }).statusCode).toBe(429);
    const body = JSON.parse((result as { body: string }).body) as { reason: string };
    expect(body.reason).toBe("global_ceiling");
  });

  it("returns 429 with reason=user_quota when user quota exceeded", async () => {
    vi.mocked(checkAndIncrementUserDailyQuota).mockResolvedValue({ ok: false, reason: "user_quota" });

    const event = makeEvent({
      source: "passive_stuck",
      problem_text: "Solve for x",
      transcript: "",
    });

    const result = await handler(event);
    expect((result as { statusCode: number }).statusCode).toBe(429);
    const body = JSON.parse((result as { body: string }).body) as { reason: string };
    expect(body.reason).toBe("user_quota");
  });

  it("returns 400 when source is missing", async () => {
    const event = makeEvent({ problem_text: "Solve for x" });
    const result = await handler(event);
    expect((result as { statusCode: number }).statusCode).toBe(400);
  });

  it("returns 400 for invalid source", async () => {
    const event = makeEvent({ source: "invalid_source", problem_text: "Solve for x" });
    const result = await handler(event);
    expect((result as { statusCode: number }).statusCode).toBe(400);
  });

  it("returns 401 when no auth header", async () => {
    const { extractBearerToken } = await import("../src/lib/auth.js");
    vi.mocked(extractBearerToken).mockReturnValueOnce(null);

    const event = makeEvent({ source: "passive_stuck", problem_text: "x" }, "");
    const result = await handler(event);
    expect((result as { statusCode: number }).statusCode).toBe(401);
  });
});

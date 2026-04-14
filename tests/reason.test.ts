import { describe, it, expect, vi, beforeEach } from "vitest";
import type { APIGatewayProxyEventV2 } from "aws-lambda";

// Mock dependencies before importing handler
vi.mock("../src/lib/auth.js", () => ({
  verifyJwt: vi.fn().mockResolvedValue({ sub: "test-user-id" }),
  extractBearerToken: vi.fn().mockReturnValue("test-token"),
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
    text: [
      "UNDERSTANDING: Student is solving 2x + 5 = 13. They have written 2x = 8 and appear to be stuck on the final step.",
      "EVENTS: [00:25] likely_stuck: student paused after writing 2x = 8",
      "HINT: What do you need to do to isolate x from 2x?",
      "STATE: \\boxed{active}",
    ].join("\n"),
    tokensIn: 200,
    tokensOut: 80,
  }),
  RegionUnavailableError: class RegionUnavailableError extends Error {
    constructor(region: string, modelId: string) {
      super(`Bedrock model ${modelId} unavailable in region ${region}`);
      this.name = "RegionUnavailableError";
    }
  },
}));

vi.mock("../src/lib/dynamo.js", () => ({
  updateSessionAnalysis: vi.fn().mockResolvedValue(undefined),
  putMessage: vi.fn().mockResolvedValue(undefined),
}));

import { handler, parseReasonResponse } from "../src/handlers/reason.js";

function makeEvent(body: unknown, authHeader = "Bearer test-token"): APIGatewayProxyEventV2 {
  return {
    version: "2.0",
    routeKey: "POST /reason",
    rawPath: "/reason",
    rawQueryString: "",
    headers: { authorization: authHeader },
    requestContext: {
      accountId: "123",
      apiId: "api",
      domainName: "example.com",
      domainPrefix: "example",
      http: { method: "POST", path: "/reason", protocol: "HTTP/1.1", sourceIp: "1.2.3.4", userAgent: "" },
      requestId: "req-1",
      routeKey: "POST /reason",
      stage: "$default",
      time: new Date().toISOString(),
      timeEpoch: Date.now(),
    },
    body: JSON.stringify(body),
    isBase64Encoded: false,
  };
}

const baseBody = {
  frames: ["dGVzdA=="], // base64 "test"
  event_log: "[00:00] session_start: session started",
  current_analysis: "",
  flags: {
    is_milo_speaking: false,
    soft_muted: false,
    force_reply: false,
  },
  session_id: "session-123",
};

beforeEach(() => {
  vi.clearAllMocks();
});

// ---- parseReasonResponse unit tests ----

describe("parseReasonResponse", () => {
  it("parses well-formed response correctly", () => {
    const text = [
      "UNDERSTANDING: Student is working on quadratic equation ax^2 + bx + c = 0.",
      "EVENTS: [01:30] observed_write: student wrote the quadratic formula",
      "[01:35] progress: student substituted values correctly",
      "HINT: Does the discriminant tell you how many solutions there are?",
      "STATE: \\boxed{active}",
    ].join("\n");

    const result = parseReasonResponse(text);
    expect(result.understanding).toBe("Student is working on quadratic equation ax^2 + bx + c = 0.");
    expect(result.events).toHaveLength(2);
    expect(result.events[0]).toBe("[01:30] observed_write: student wrote the quadratic formula");
    expect(result.events[1]).toBe("[01:35] progress: student substituted values correctly");
    expect(result.hint).toBe("Does the discriminant tell you how many solutions there are?");
    expect(result.state).toBe("active");
  });

  it("returns null hint when HINT section is empty", () => {
    const text = [
      "UNDERSTANDING: Student is actively writing.",
      "EVENTS:",
      "HINT:",
      "STATE: \\boxed{active}",
    ].join("\n");

    const result = parseReasonResponse(text);
    expect(result.hint).toBeNull();
    expect(result.events).toHaveLength(0);
  });

  it("handles missing EVENTS section gracefully", () => {
    const text = [
      "UNDERSTANDING: Student paused.",
      "HINT: What is the next step you could try?",
      "STATE: \\boxed{active}",
    ].join("\n");

    const result = parseReasonResponse(text);
    expect(result.understanding).toBe("Student paused.");
    expect(result.events).toHaveLength(0);
    expect(result.hint).toBe("What is the next step you could try?");
  });

  it("handles malformed response with extra text before sections", () => {
    const text = [
      "Sure! Here is my analysis:",
      "UNDERSTANDING: Student is working on integration by parts.",
      "EVENTS: [02:00] observed_write: wrote u = ln(x)",
      "HINT:",
      "STATE: \\boxed{positioning_camera}",
    ].join("\n");

    const result = parseReasonResponse(text);
    expect(result.understanding).toBe("Student is working on integration by parts.");
    expect(result.events).toHaveLength(1);
    expect(result.hint).toBeNull();
    expect(result.state).toBe("positioning_camera");
  });

  it("extracts boxed state: camera_lost", () => {
    const text = [
      "UNDERSTANDING: No paper visible.",
      "EVENTS:",
      "HINT:",
      "STATE: \\boxed{camera_lost}",
    ].join("\n");

    const result = parseReasonResponse(text);
    expect(result.state).toBe("camera_lost");
  });

  it("defaults state to active when boxed state is unrecognized", () => {
    const text = [
      "UNDERSTANDING: Something.",
      "EVENTS:",
      "HINT:",
      "STATE: \\boxed{unknown_state}",
    ].join("\n");

    const result = parseReasonResponse(text);
    expect(result.state).toBe("active");
  });
});

// ---- handler integration tests ----

describe("reason handler", () => {
  it("returns 200 with expected shape", async () => {
    const event = makeEvent(baseBody);
    const result = await handler(event);

    expect((result as { statusCode: number }).statusCode).toBe(200);
    const body = JSON.parse((result as { body: string }).body) as unknown;
    expect(body).toMatchObject({
      understanding: expect.any(String) as unknown,
      events: expect.any(Array) as unknown,
      tokensIn: expect.any(Number) as unknown,
      tokensOut: expect.any(Number) as unknown,
    });
  });

  it("returns 401 when no auth token", async () => {
    const { extractBearerToken } = await import("../src/lib/auth.js");
    vi.mocked(extractBearerToken).mockReturnValueOnce(null);

    const event = makeEvent(baseBody, "");
    const result = await handler(event);
    expect((result as { statusCode: number }).statusCode).toBe(401);
  });

  it("returns 400 when frames is missing", async () => {
    const event = makeEvent({ ...baseBody, frames: undefined });
    const result = await handler(event);
    expect((result as { statusCode: number }).statusCode).toBe(400);
  });

  it("returns 400 when frames is empty array", async () => {
    const event = makeEvent({ ...baseBody, frames: [] });
    const result = await handler(event);
    expect((result as { statusCode: number }).statusCode).toBe(400);
  });
});

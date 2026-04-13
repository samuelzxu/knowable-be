import { describe, it, expect, vi, beforeEach } from "vitest";
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import {
  checkRegionOnColdStart,
  assertRegionAvailable,
  _resetRegionCheckForTest,
  _setRegionCheckResultForTest,
  RegionUnavailableError,
} from "../src/lib/region-check.js";

beforeEach(() => {
  _resetRegionCheckForTest();
  vi.clearAllMocks();
});

describe("assertRegionAvailable", () => {
  it("does not throw when regionCheckPassed is null (not yet checked)", () => {
    // null = check hasn't run yet, fail open
    expect(() => assertRegionAvailable()).not.toThrow();
  });

  it("does not throw when regionCheckPassed is true", () => {
    _setRegionCheckResultForTest(true);
    expect(() => assertRegionAvailable()).not.toThrow();
  });

  it("throws RegionUnavailableError when regionCheckPassed is false", () => {
    _setRegionCheckResultForTest(false);
    expect(() => assertRegionAvailable()).toThrow(RegionUnavailableError);
  });
});

describe("checkRegionOnColdStart", () => {
  it("sets regionCheckPassed=true when InvokeModel probe returns a non-403/404 error (ValidationException)", async () => {
    const mockSend = vi.fn().mockRejectedValue(
      Object.assign(new Error("ValidationException"), {
        name: "ValidationException",
        $metadata: { httpStatusCode: 400 },
      })
    );
    vi.mocked(BedrockRuntimeClient).mockImplementation(
      () => ({ send: mockSend }) as unknown as BedrockRuntimeClient
    );

    await checkRegionOnColdStart();
    expect(() => assertRegionAvailable()).not.toThrow();
  });

  it("sets regionCheckPassed=true when InvokeModel probe succeeds", async () => {
    const mockSend = vi.fn().mockResolvedValue({
      body: new TextEncoder().encode(
        JSON.stringify({
          content: [{ type: "text", text: "ok" }],
          usage: { input_tokens: 1, output_tokens: 1 },
        })
      ),
    });
    vi.mocked(BedrockRuntimeClient).mockImplementation(
      () => ({ send: mockSend }) as unknown as BedrockRuntimeClient
    );

    await checkRegionOnColdStart();
    expect(() => assertRegionAvailable()).not.toThrow();
  });

  it("sets regionCheckPassed=true when probe returns 403 (IAM issue, not region issue)", async () => {
    const mockSend = vi.fn().mockRejectedValue(
      Object.assign(new Error("AccessDenied"), {
        name: "AccessDeniedException",
        $metadata: { httpStatusCode: 403 },
      })
    );
    vi.mocked(BedrockRuntimeClient).mockImplementation(
      () => ({ send: mockSend }) as unknown as BedrockRuntimeClient
    );

    await checkRegionOnColdStart();
    expect(() => assertRegionAvailable()).not.toThrow();
  });

  it("sets regionCheckPassed=false when probe returns 404", async () => {
    const mockSend = vi.fn().mockRejectedValue(
      Object.assign(new Error("NotFound"), {
        name: "ResourceNotFoundException",
        $metadata: { httpStatusCode: 404 },
      })
    );
    vi.mocked(BedrockRuntimeClient).mockImplementation(
      () => ({ send: mockSend }) as unknown as BedrockRuntimeClient
    );

    await checkRegionOnColdStart();
    expect(() => assertRegionAvailable()).toThrow(RegionUnavailableError);
  });

  it("sets regionCheckPassed=true on network errors (fail open)", async () => {
    const mockSend = vi.fn().mockRejectedValue(
      Object.assign(new Error("NetworkError"), { name: "NetworkingError" })
    );
    vi.mocked(BedrockRuntimeClient).mockImplementation(
      () => ({ send: mockSend }) as unknown as BedrockRuntimeClient
    );

    await checkRegionOnColdStart();
    expect(() => assertRegionAvailable()).not.toThrow();
  });
});

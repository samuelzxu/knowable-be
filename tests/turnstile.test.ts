import { describe, it, expect, vi, beforeEach } from "vitest";
import { verifyTurnstileToken } from "../src/lib/turnstile.js";

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("verifyTurnstileToken", () => {
  it("returns {success: true} on successful verification", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        json: async () => ({ success: true }),
      })
    );

    const result = await verifyTurnstileToken("valid-token", "secret");
    expect(result.success).toBe(true);
  });

  it("returns {success: false, errorCodes} on failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        json: async () => ({ success: false, "error-codes": ["invalid-input-response"] }),
      })
    );

    const result = await verifyTurnstileToken("bad-token", "secret");
    expect(result.success).toBe(false);
    expect(result.errorCodes).toContain("invalid-input-response");
  });

  it("retries once on network error and succeeds on second attempt", async () => {
    const mockFetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("Network failure"))
      .mockResolvedValueOnce({
        json: async () => ({ success: true }),
      });
    vi.stubGlobal("fetch", mockFetch);

    const result = await verifyTurnstileToken("token", "secret");
    expect(result.success).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("throws after both attempts fail", async () => {
    const mockFetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("Network failure 1"))
      .mockRejectedValueOnce(new Error("Network failure 2"));
    vi.stubGlobal("fetch", mockFetch);

    await expect(verifyTurnstileToken("token", "secret")).rejects.toThrow("Network failure");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("passes remoteip in the request body when provided", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      json: async () => ({ success: true }),
    });
    vi.stubGlobal("fetch", mockFetch);

    await verifyTurnstileToken("token", "secret", "1.2.3.4");

    const callBody = mockFetch.mock.calls[0]?.[1]?.body as string;
    expect(callBody).toContain("remoteip=1.2.3.4");
  });
});

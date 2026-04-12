import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the DynamoDB client module so we can control send() per test
const mockSend = vi.fn();

vi.mock("@aws-sdk/client-dynamodb", () => {
  const DynamoDBClient = vi.fn().mockImplementation(() => ({ send: mockSend }));
  const UpdateItemCommand = vi.fn().mockImplementation((input: unknown) => input);
  return { DynamoDBClient, UpdateItemCommand };
});

// Import AFTER the mock is registered; also import the reset helper if we had one.
// quota.ts caches the DynamoDBClient singleton — we need to reset it between tests.
// We do this by re-importing the module fresh each time via vi.resetModules().

describe("checkAndIncrementUserDailyQuota", () => {
  beforeEach(() => {
    vi.resetModules();
    mockSend.mockReset();
  });

  it("returns {ok: true} when DynamoDB UpdateItem succeeds", async () => {
    mockSend.mockResolvedValue({});
    const { checkAndIncrementUserDailyQuota } = await import("../src/lib/quota.js");
    const result = await checkAndIncrementUserDailyQuota("user-123");
    expect(result).toEqual({ ok: true });
  });

  it("returns {ok: false, reason: 'user_quota'} on ConditionalCheckFailedException", async () => {
    mockSend.mockRejectedValue(
      Object.assign(new Error("ConditionalCheckFailed"), {
        name: "ConditionalCheckFailedException",
      })
    );
    const { checkAndIncrementUserDailyQuota } = await import("../src/lib/quota.js");
    const result = await checkAndIncrementUserDailyQuota("user-123");
    expect(result).toEqual({ ok: false, reason: "user_quota" });
  });

  it("re-throws on unexpected DynamoDB errors", async () => {
    mockSend.mockRejectedValue(
      Object.assign(new Error("ProvisionedThroughputExceeded"), {
        name: "ProvisionedThroughputExceededException",
      })
    );
    const { checkAndIncrementUserDailyQuota } = await import("../src/lib/quota.js");
    await expect(checkAndIncrementUserDailyQuota("user-123")).rejects.toThrow(
      "ProvisionedThroughputExceeded"
    );
  });
});

describe("checkAndIncrementGlobalDailyQuota", () => {
  beforeEach(() => {
    vi.resetModules();
    mockSend.mockReset();
  });

  it("returns {ok: true} when DynamoDB UpdateItem succeeds", async () => {
    mockSend.mockResolvedValue({});
    const { checkAndIncrementGlobalDailyQuota } = await import("../src/lib/quota.js");
    const result = await checkAndIncrementGlobalDailyQuota();
    expect(result).toEqual({ ok: true });
  });

  it("returns {ok: false, reason: 'global_ceiling'} on ConditionalCheckFailedException", async () => {
    mockSend.mockRejectedValue(
      Object.assign(new Error("ConditionalCheckFailed"), {
        name: "ConditionalCheckFailedException",
      })
    );
    const { checkAndIncrementGlobalDailyQuota } = await import("../src/lib/quota.js");
    const result = await checkAndIncrementGlobalDailyQuota();
    expect(result).toEqual({ ok: false, reason: "global_ceiling" });
  });

  it("uses the GLOBAL partition key", async () => {
    mockSend.mockResolvedValue({});
    const { checkAndIncrementGlobalDailyQuota } = await import("../src/lib/quota.js");
    await checkAndIncrementGlobalDailyQuota();
    expect(mockSend).toHaveBeenCalledOnce();
    const callArg = mockSend.mock.calls[0]?.[0] as { Key?: { userId?: { S?: string } } };
    expect(callArg?.Key?.userId?.S).toBe("knowable-quota#GLOBAL");
  });
});

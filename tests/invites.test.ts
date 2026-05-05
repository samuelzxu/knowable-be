import { describe, it, expect, vi, beforeEach } from "vitest";

// Stub the document client BEFORE importing the lib so the singleton picks
// up our mock. Each test reassigns `mockSend` to script the response stream
// in call order.
let mockSend: ReturnType<typeof vi.fn>;

vi.mock("../src/lib/dynamo.js", async () => {
  return {
    TABLE_EDUCATOR_INVITES: "knowable-educator-invites",
    getDocumentClient: () => ({ send: (cmd: unknown) => mockSend(cmd) }),
  };
});

import {
  consumeInviteCode,
  createInvite,
  formatInviteForDisplay,
  generateInviteCode,
  InviteError,
  normalizeInviteCode,
} from "../src/lib/invites.js";

beforeEach(() => {
  mockSend = vi.fn();
});

// ---- Code generation -------------------------------------------------------

describe("generateInviteCode", () => {
  it("returns a 16-char string", () => {
    const code = generateInviteCode();
    expect(code).toHaveLength(16);
  });

  it("excludes ambiguous chars I, O, 0, 1, L", () => {
    for (let i = 0; i < 200; i++) {
      const code = generateInviteCode();
      // Whitelist: A-H, J, K, M, N, P-Z, 2-9.
      expect(code).toMatch(/^[A-HJKMNP-Z2-9]{16}$/);
    }
  });

  it("uses only uppercase alphanumerics", () => {
    for (let i = 0; i < 50; i++) {
      const code = generateInviteCode();
      expect(code).toMatch(/^[A-Z0-9]+$/);
    }
  });
});

describe("normalizeInviteCode", () => {
  it("strips hyphens, spaces, and uppercases", () => {
    expect(normalizeInviteCode("abcd-efgh-jkmn-pqrs")).toBe("ABCDEFGHJKMNPQRS");
    expect(normalizeInviteCode(" ABCD EFGH JKMN PQRS ")).toBe("ABCDEFGHJKMNPQRS");
    expect(normalizeInviteCode("ABCDEFGHJKMNPQRS")).toBe("ABCDEFGHJKMNPQRS");
  });
});

describe("formatInviteForDisplay", () => {
  it("inserts hyphens every 4 chars", () => {
    expect(formatInviteForDisplay("ABCDEFGHJKMNPQRS")).toBe(
      "ABCD-EFGH-JKMN-PQRS"
    );
  });

  it("normalizes input first (re-formats already-hyphenated codes)", () => {
    expect(formatInviteForDisplay("abcd-efgh-jkmn-pqrs")).toBe(
      "ABCD-EFGH-JKMN-PQRS"
    );
  });
});

// ---- consumeInviteCode -----------------------------------------------------

describe("consumeInviteCode — happy path", () => {
  it("returns the post-increment record on success", async () => {
    mockSend = vi.fn().mockResolvedValueOnce({
      Attributes: {
        code: "ABCDEFGHJKMNPQRS",
        maxUses: 5,
        usedCount: 1,
        createdAt: "2026-04-01T00:00:00.000Z",
      },
    });

    const result = await consumeInviteCode("ABCD-EFGH-JKMN-PQRS");
    expect(result.code).toBe("ABCDEFGHJKMNPQRS");
    expect(result.usedCount).toBe(1);
    expect(result.maxUses).toBe(5);
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it("normalizes the input code before lookup (lowercase + spaces)", async () => {
    mockSend = vi.fn().mockResolvedValueOnce({
      Attributes: {
        code: "ABCDEFGHJKMNPQRS",
        maxUses: 3,
        usedCount: 1,
        createdAt: "2026-04-01T00:00:00.000Z",
      },
    });
    const result = await consumeInviteCode("  abcd efgh jkmn pqrs  ");
    expect(result.usedCount).toBe(1);
  });
});

// ---- consumeInviteCode — failure paths ------------------------------------

describe("consumeInviteCode — not_found", () => {
  it("maps a missing row (post-failure GET returns no Item) to InviteError(not_found)", async () => {
    // 1st send: UpdateCommand throws ConditionalCheckFailedException
    // 2nd send: GetCommand returns no Item
    mockSend = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("conditional check failed"), {
          name: "ConditionalCheckFailedException",
        })
      )
      .mockResolvedValueOnce({ Item: undefined });

    await expect(consumeInviteCode("NONEXISTENTCODE0")).rejects.toMatchObject({
      name: "InviteError",
      kind: "not_found",
    });
  });

  it("maps an empty/whitespace-only code without a DDB call", async () => {
    mockSend = vi.fn();
    await expect(consumeInviteCode("   ---   ")).rejects.toMatchObject({
      kind: "not_found",
    });
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe("consumeInviteCode — expired", () => {
  it("maps an expired code (expiresAt <= now) to InviteError(expired)", async () => {
    mockSend = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("conditional check failed"), {
          name: "ConditionalCheckFailedException",
        })
      )
      .mockResolvedValueOnce({
        Item: {
          code: "EXPIREDCODEXXXXX",
          maxUses: 5,
          usedCount: 0,
          createdAt: "2026-01-01T00:00:00.000Z",
          expiresAt: "2026-01-02T00:00:00.000Z",
        },
      });

    await expect(consumeInviteCode("EXPIRED-CODE-XXXX")).rejects.toMatchObject({
      kind: "expired",
    });
  });
});

describe("consumeInviteCode — exhausted", () => {
  it("maps an at-cap code (usedCount === maxUses) to InviteError(exhausted)", async () => {
    mockSend = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("conditional check failed"), {
          name: "ConditionalCheckFailedException",
        })
      )
      .mockResolvedValueOnce({
        Item: {
          code: "EXHAUSTEDXXXXXXX",
          maxUses: 3,
          usedCount: 3,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      });

    await expect(consumeInviteCode("EXHAUSTED-XXXX")).rejects.toMatchObject({
      kind: "exhausted",
    });
  });
});

describe("consumeInviteCode — at-cap edge", () => {
  it("succeeds when maxUses=5 and usedCount becomes 5 on this redemption", async () => {
    // Last slot — DDB ran the conditional `usedCount < maxUses` against
    // pre-state (4 < 5) and then atomically bumped to 5. ALL_NEW returns
    // post-state (usedCount=5).
    mockSend = vi.fn().mockResolvedValueOnce({
      Attributes: {
        code: "LASTSLOTCODEXXXX",
        maxUses: 5,
        usedCount: 5,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    });

    const result = await consumeInviteCode("LASTSLOT-CODE-XXXX");
    expect(result.usedCount).toBe(5);
    expect(result.maxUses).toBe(5);
  });

  it("fails when a second caller arrives at the same time and finds usedCount=maxUses", async () => {
    // Imagine two concurrent calls when only one slot remains. The first
    // succeeds (covered by the previous test). The second sees the
    // conditional fail; the follow-up GET returns the post-state of the
    // winner: usedCount=5, maxUses=5.
    mockSend = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("conditional check failed"), {
          name: "ConditionalCheckFailedException",
        })
      )
      .mockResolvedValueOnce({
        Item: {
          code: "LASTSLOTCODEXXXX",
          maxUses: 5,
          usedCount: 5,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      });

    await expect(consumeInviteCode("LASTSLOT-CODE-XXXX")).rejects.toMatchObject({
      kind: "exhausted",
    });
  });
});

describe("consumeInviteCode — non-conditional errors propagate", () => {
  it("throws unmodified when the underlying error is not a conditional-check", async () => {
    const unrelated = Object.assign(new Error("throttled"), {
      name: "ProvisionedThroughputExceededException",
    });
    mockSend = vi.fn().mockRejectedValueOnce(unrelated);

    await expect(consumeInviteCode("ABCDEFGHJKMNPQRS")).rejects.toBe(unrelated);
  });
});

// ---- createInvite ----------------------------------------------------------

describe("createInvite", () => {
  it("writes a fresh row with usedCount=0 and returns it", async () => {
    mockSend = vi.fn().mockResolvedValueOnce({});
    const result = await createInvite({
      maxUses: 5,
      note: "pilot",
    });
    expect(result.usedCount).toBe(0);
    expect(result.maxUses).toBe(5);
    expect(result.note).toBe("pilot");
    expect(result.code).toMatch(/^[A-HJKMNP-Z2-9]{16}$/);
    expect(result.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // Optional expiresAt should not be set when not passed.
    expect(result.expiresAt).toBeUndefined();
  });

  it("throws on InviteError instances having the right `kind` discriminator", () => {
    const e = new InviteError("expired", "invite_expired");
    expect(e).toBeInstanceOf(InviteError);
    expect(e.kind).toBe("expired");
    expect(e.name).toBe("InviteError");
  });
});

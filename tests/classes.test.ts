import { describe, it, expect, vi, beforeEach } from "vitest";

// Stub the document client BEFORE importing the lib so the singleton picks
// up our mock. Each test reassigns `mockSend` to script the response stream
// in call order.
let mockSend: ReturnType<typeof vi.fn>;

vi.mock("../src/lib/dynamo.js", async () => {
  return {
    TABLE_CLASSES: "knowable-classes",
    TABLE_CLASS_MEMBERS: "knowable-class-members",
    TABLE_ROLES: "knowable-roles",
    getDocumentClient: () => ({ send: (cmd: unknown) => mockSend(cmd) }),
  };
});

import {
  generateClassCode,
  joinClass,
  JoinError,
  getStudentMembership,
} from "../src/lib/classes.js";

beforeEach(() => {
  mockSend = vi.fn();
});

describe("generateClassCode", () => {
  it("returns a 6-char string", () => {
    const code = generateClassCode();
    expect(code).toHaveLength(6);
  });

  it("excludes ambiguous chars I, O, 0, 1", () => {
    // Sample many to have high confidence of coverage.
    for (let i = 0; i < 200; i++) {
      const code = generateClassCode();
      expect(code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
    }
  });

  it("uses only uppercase alphanumerics", () => {
    for (let i = 0; i < 50; i++) {
      const code = generateClassCode();
      expect(code).toMatch(/^[A-Z0-9]+$/);
    }
  });
});

describe("joinClass", () => {
  it("happy path: writes membership and returns class info", async () => {
    // 1. code-index Query (find class by code)
    // 2. student-index Query (caller has no existing membership)
    // 3. PutCommand (insert membership) — return value unused
    // 4. GetCommand on roles (educator display name)
    mockSend = vi
      .fn()
      .mockResolvedValueOnce({
        Items: [
          {
            classId: "class-1",
            educatorId: "edu-1",
            name: "AP Calc",
            code: "ABCDEF",
            createdAt: new Date().toISOString(),
            codeExpiresAt: new Date(Date.now() + 86400_000).toISOString(),
          },
        ],
      })
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Item: { displayName: "Ms. Smith" } });

    const result = await joinClass("student-1", "ABCDEF", "Sam");
    expect(result).toEqual({
      classId: "class-1",
      className: "AP Calc",
      educatorDisplayName: "Ms. Smith",
      sharingTier: "off",
    });
    expect(mockSend).toHaveBeenCalledTimes(4);
  });

  it("throws class_not_found when code returns no rows", async () => {
    mockSend = vi.fn().mockResolvedValueOnce({ Items: [] });
    await expect(joinClass("student-1", "ZZZZZZ", "Sam")).rejects.toMatchObject({
      code: "class_not_found",
    });
  });

  it("throws code_expired when codeExpiresAt is in the past", async () => {
    mockSend = vi.fn().mockResolvedValueOnce({
      Items: [
        {
          classId: "class-1",
          educatorId: "edu-1",
          name: "Old Class",
          code: "ABCDEF",
          createdAt: new Date(Date.now() - 100 * 86400_000).toISOString(),
          codeExpiresAt: new Date(Date.now() - 1000).toISOString(),
        },
      ],
    });
    await expect(joinClass("student-1", "ABCDEF", "Sam")).rejects.toMatchObject({
      code: "code_expired",
    });
  });

  it("throws educators_cannot_join when caller is the class owner", async () => {
    mockSend = vi.fn().mockResolvedValueOnce({
      Items: [
        {
          classId: "class-1",
          educatorId: "edu-1",
          name: "AP Calc",
          code: "ABCDEF",
          createdAt: new Date().toISOString(),
          codeExpiresAt: new Date(Date.now() + 86400_000).toISOString(),
        },
      ],
    });
    await expect(joinClass("edu-1", "ABCDEF", "Self")).rejects.toMatchObject({
      code: "educators_cannot_join",
    });
  });

  it("throws already_in_class with currentClass attribute when student is in a different class", async () => {
    mockSend = vi
      .fn()
      // code-index → class
      .mockResolvedValueOnce({
        Items: [
          {
            classId: "class-2",
            educatorId: "edu-2",
            name: "AP Calc",
            code: "ABCDEF",
            createdAt: new Date().toISOString(),
            codeExpiresAt: new Date(Date.now() + 86400_000).toISOString(),
          },
        ],
      })
      // student-index → existing membership (different class)
      .mockResolvedValueOnce({
        Items: [
          {
            classId: "class-other",
            studentUserId: "student-1",
            joinedAt: new Date().toISOString(),
            displayName: "Sam",
            sharingTier: "off",
          },
        ],
      })
      // GetCommand on the OTHER class for its name
      .mockResolvedValueOnce({ Item: { name: "Bio 101" } });

    let err: unknown;
    try {
      await joinClass("student-1", "ABCDEF", "Sam");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(JoinError);
    expect((err as JoinError).code).toBe("already_in_class");
    expect((err as JoinError).extra).toEqual({ currentClass: "Bio 101" });
  });

  it("returns idempotent success when student is already in the same class", async () => {
    mockSend = vi
      .fn()
      .mockResolvedValueOnce({
        Items: [
          {
            classId: "class-1",
            educatorId: "edu-1",
            name: "AP Calc",
            code: "ABCDEF",
            createdAt: new Date().toISOString(),
            codeExpiresAt: new Date(Date.now() + 86400_000).toISOString(),
          },
        ],
      })
      .mockResolvedValueOnce({
        Items: [
          {
            classId: "class-1",
            studentUserId: "student-1",
            joinedAt: new Date().toISOString(),
            displayName: "Sam",
            sharingTier: "off",
          },
        ],
      })
      .mockResolvedValueOnce({ Item: { displayName: "Ms. Smith" } });

    const result = await joinClass("student-1", "ABCDEF", "Sam");
    expect(result.classId).toBe("class-1");
    expect(result.educatorDisplayName).toBe("Ms. Smith");
  });
});

describe("getStudentMembership", () => {
  it("returns null when student has no row in student-index", async () => {
    mockSend = vi.fn().mockResolvedValueOnce({ Items: [] });
    const result = await getStudentMembership("student-1");
    expect(result).toBeNull();
  });

  it("returns the membership row when present", async () => {
    mockSend = vi.fn().mockResolvedValueOnce({
      Items: [
        {
          classId: "class-1",
          studentUserId: "student-1",
          joinedAt: "2026-05-04T00:00:00.000Z",
          displayName: "Sam",
          sharingTier: "off",
        },
      ],
    });
    const result = await getStudentMembership("student-1");
    expect(result?.classId).toBe("class-1");
    expect(result?.sharingTier).toBe("off");
  });
});

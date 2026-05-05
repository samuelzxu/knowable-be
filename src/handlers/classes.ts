// Lambda entry point for /classes/* routes.
// See .omc/design/educator-tools/02-architecture.md §2.

import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { z } from "zod";
import { verifyJwt, extractBearerToken } from "../lib/auth.js";
import { isEducator } from "../lib/roles.js";
import {
  createClass,
  listClasses,
  getClassWithMembers,
  joinClass,
  getStudentMembership,
  leaveClass,
  JoinError,
} from "../lib/classes.js";

function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

interface AuthedClaims {
  sub: string;
  email: string | undefined;
}

async function authenticate(event: APIGatewayProxyEventV2): Promise<AuthedClaims | null> {
  const token = extractBearerToken(event.headers?.["authorization"]);
  if (!token) return null;
  try {
    const claims = await verifyJwt(token);
    return { sub: claims.sub, email: claims.email };
  } catch {
    return null;
  }
}

const CreateClassSchema = z.object({
  name: z.string().trim().min(1).max(120),
});

const JoinSchema = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]{6}$/, "code must be 6 uppercase alphanumeric chars"),
  displayName: z.string().trim().min(1).max(80),
});

export const handler = async (
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> => {
  const auth = await authenticate(event);
  if (!auth) return json(401, { error: "unauthorized" });
  const userId = auth.sub;

  const routeKey = event.routeKey ?? "";
  const pathParams = event.pathParameters ?? {};

  let body: Record<string, unknown> = {};
  if (event.body) {
    try {
      body = JSON.parse(event.body) as Record<string, unknown>;
    } catch {
      return json(400, { error: "invalid_json" });
    }
  }

  // ---- POST /classes — educator creates a class ----
  if (routeKey === "POST /classes") {
    if (!(await isEducator(userId))) return json(403, { error: "forbidden" });
    const parsed = CreateClassSchema.safeParse(body);
    if (!parsed.success) {
      return json(400, { error: "invalid_body", issues: parsed.error.issues });
    }
    const cls = await createClass(userId, parsed.data.name);
    return json(201, cls);
  }

  // ---- GET /classes — educator lists their classes ----
  if (routeKey === "GET /classes") {
    if (!(await isEducator(userId))) return json(403, { error: "forbidden" });
    const classes = await listClasses(userId);
    return json(200, { classes });
  }

  // ---- GET /classes/membership — caller's own class (student-facing) ----
  if (routeKey === "GET /classes/membership") {
    const membership = await getStudentMembership(userId);
    return json(200, { membership });
  }

  // ---- POST /classes/join — student joins via code ----
  if (routeKey === "POST /classes/join") {
    const parsed = JoinSchema.safeParse(body);
    if (!parsed.success) {
      return json(400, { error: "invalid_body", issues: parsed.error.issues });
    }
    try {
      const result = await joinClass(
        userId,
        parsed.data.code,
        parsed.data.displayName
      );
      return json(200, result);
    } catch (e) {
      if (e instanceof JoinError) {
        switch (e.code) {
          case "class_not_found":
            return json(404, { error: "class_not_found" });
          case "code_expired":
            return json(410, { error: "code_expired" });
          case "already_in_class":
            return json(409, { error: "already_in_class", ...e.extra });
          case "educators_cannot_join":
            return json(400, { error: "educators_cannot_join" });
        }
      }
      throw e;
    }
  }

  // ---- GET /classes/{id} — educator dashboard for a single class ----
  if (routeKey === "GET /classes/{id}") {
    if (!(await isEducator(userId))) return json(403, { error: "forbidden" });
    const classId = pathParams["id"];
    if (!classId) return json(400, { error: "missing_class_id" });
    const result = await getClassWithMembers(classId);
    if (!result) return json(404, { error: "class_not_found" });
    if (result.class.educatorId !== userId) return json(403, { error: "forbidden" });
    return json(200, result);
  }

  // ---- DELETE /classes/{id}/members/{studentId} — educator removes student ----
  if (routeKey === "DELETE /classes/{id}/members/{studentId}") {
    if (!(await isEducator(userId))) return json(403, { error: "forbidden" });
    const classId = pathParams["id"];
    const studentId = pathParams["studentId"];
    if (!classId || !studentId) return json(400, { error: "missing_path_params" });
    const cls = await getClassWithMembers(classId);
    if (!cls) return json(404, { error: "class_not_found" });
    if (cls.class.educatorId !== userId) return json(403, { error: "forbidden" });
    await leaveClass(classId, studentId);
    return json(204, null);
  }

  return json(405, { error: "method_not_allowed", routeKey });
};

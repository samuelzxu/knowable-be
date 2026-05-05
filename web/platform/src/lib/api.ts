// Typed client for the Knowable platform API.
// Wraps `fetch()` with the educator's bearer JWT pulled from cognito.ts.
//
// Response shapes mirror knowable-be/src/handlers/{classes,educator}.ts —
// keep them in sync if the backend changes.

import { getCurrentSession } from "./cognito";

const API_BASE_URL = import.meta.env.PUBLIC_API_BASE_URL ?? "";

// ---- Types matching backend response shapes ----------------------------------

export interface Class {
  classId: string;
  educatorId: string;
  name: string;
  code: string;
  createdAt: string;
  codeExpiresAt: string;
}

export type SharingTier = "off" | "stats" | "stats+activity";

export interface ClassMember {
  classId: string;
  studentUserId: string;
  joinedAt: string;
  displayName: string;
  sharingTier: SharingTier;
}

export interface ClassDetail {
  class: Class;
  members: ClassMember[];
}

export interface NumericInsights {
  sessionsThisWeek: number;
  totalMinutes: number;
  hintsPerSession: number;
  avgSolveTimeMs: number;
}

export interface DashboardMember {
  studentUserId: string;
  displayName: string;
  sharingTier: SharingTier;
  insights: NumericInsights | null;
}

export interface DashboardResponse {
  class: Class;
  members: DashboardMember[];
}

export interface AnalysisEvidence {
  claim: string;
  sessionId: string;
  ts: string;
  excerpt: string;
}

export interface AnalysisResponse {
  strengths: string[];
  struggles: string[];
  patterns: string[];
  recommendations: string[];
  evidence: AnalysisEvidence[];
  /** ISO8601 timestamp the analysis was actually produced — survives the
   *  24h cache so a re-fetch can show "Generated 4h ago" honestly. */
  generatedAt: string;
}

// ---- Error handling ----------------------------------------------------------

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string | undefined,
    public body: unknown
  ) {
    super(`API ${status}: ${code ?? "unknown"}`);
    this.name = "ApiError";
  }
}

// ---- Core fetch wrapper ------------------------------------------------------

async function authedFetch<T>(
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const session = await getCurrentSession();
  if (!session) {
    throw new ApiError(401, "no_session", null);
  }
  const url = `${API_BASE_URL}${path}`;
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${session.idToken}`);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(url, { ...init, headers });
  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!response.ok) {
    const code =
      (body && typeof body === "object" && "error" in body
        ? String((body as { error: unknown }).error)
        : undefined) ?? undefined;
    throw new ApiError(response.status, code, body);
  }
  return body as T;
}

// ---- Endpoints ---------------------------------------------------------------

export async function listClasses(): Promise<Class[]> {
  const result = await authedFetch<{ classes: Class[] }>("/classes");
  return result.classes;
}

export async function createClass(name: string): Promise<Class> {
  return authedFetch<Class>("/classes", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

export async function getClass(id: string): Promise<ClassDetail> {
  return authedFetch<ClassDetail>(`/classes/${encodeURIComponent(id)}`);
}

export async function getDashboard(classId: string): Promise<DashboardResponse> {
  return authedFetch<DashboardResponse>(
    `/educator/dashboard/${encodeURIComponent(classId)}`
  );
}

export async function analyze(
  studentUserId: string,
  classId: string,
  windowDays: number = 7
): Promise<AnalysisResponse> {
  return authedFetch<AnalysisResponse>("/educator/analyze", {
    method: "POST",
    body: JSON.stringify({ studentUserId, classId, windowDays }),
  });
}

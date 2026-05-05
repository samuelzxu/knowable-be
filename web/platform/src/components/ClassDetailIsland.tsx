import { useEffect, useState } from "react";
import { ClassDetail } from "./ClassDetail";

/**
 * Reads the classId from `window.location.pathname` at runtime, so a single
 * static `class/[id]/index.html` (built with the placeholder `_` id) can
 * serve every real class URL when CloudFront routes `/class/*` to it.
 */
export function ClassDetailIsland() {
  const [classId, setClassId] = useState<string | null>(null);

  useEffect(() => {
    const path = window.location.pathname;
    // Matches /class/<id> and /class/<id>/, with optional query/hash already stripped by pathname.
    const match = path.match(/\/class\/([^/]+)\/?/);
    const raw = match?.[1];
    if (!raw || raw === "_") {
      // Build-time placeholder hit at runtime — usually means the user typed
      // `/class/` directly. Send them back to the dashboard.
      window.location.replace("/dashboard");
      return;
    }
    setClassId(decodeURIComponent(raw));
  }, []);

  if (!classId) {
    return (
      <div className="text-knowable-muted text-center py-24">Loading…</div>
    );
  }
  return <ClassDetail classId={classId} />;
}

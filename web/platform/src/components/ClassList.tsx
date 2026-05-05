import { useCallback, useEffect, useState } from "react";
import { AuthProvider, useAuth } from "./AuthProvider";
import { CreateClassModal } from "./CreateClassModal";
import { listClasses, ApiError, type Class } from "../lib/api";

function ClassCard({ cls }: { cls: Class }) {
  return (
    <a
      href={`/class/${cls.classId}`}
      className="group flex flex-col rounded-2xl border border-knowable-border bg-knowable-card p-6 hover:border-knowable-orange/60 hover:shadow-lg hover:shadow-knowable-orange/5 transition-all"
    >
      <h3 className="font-serif text-xl text-knowable-primary group-hover:text-knowable-orange transition-colors">
        {cls.name}
      </h3>
      <div className="mt-3 flex items-center gap-2 text-sm">
        <span className="text-knowable-muted">Code</span>
        <span className="font-mono font-medium tracking-widest text-knowable-primary">
          {cls.code}
        </span>
      </div>
      <div className="mt-4 text-xs text-knowable-muted">
        Created {new Date(cls.createdAt).toLocaleDateString()}
      </div>
      <div className="mt-6 flex items-center justify-between">
        <span className="text-sm text-knowable-muted">
          Click to view roster
        </span>
        <span className="text-knowable-orange font-medium text-sm group-hover:translate-x-0.5 transition-transform">
          Open →
        </span>
      </div>
    </a>
  );
}

function ClassListInner() {
  const { session, loading, signOut } = useAuth();
  const [classes, setClasses] = useState<Class[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [redirecting, setRedirecting] = useState(false);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const result = await listClasses();
      result.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      setClasses(result);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        // Session expired between mount and fetch; the redirect effect handles it.
        return;
      }
      setError(
        err instanceof ApiError
          ? `Couldn't load classes (${err.status}).`
          : "Couldn't load classes."
      );
    }
  }, []);

  useEffect(() => {
    if (!loading && !session && !redirecting) {
      setRedirecting(true);
      window.location.href = "/";
    }
  }, [loading, session, redirecting]);

  useEffect(() => {
    if (session) {
      void refresh();
    }
  }, [session, refresh]);

  if (loading || (!session && !redirecting)) {
    return (
      <div className="text-knowable-muted text-center py-24">Loading…</div>
    );
  }

  if (!session) return null;

  return (
    <div className="w-full max-w-6xl mx-auto px-6 py-12">
      <header className="flex items-center justify-between mb-10">
        <div>
          <h1 className="font-serif text-4xl text-knowable-primary">Classes</h1>
          <p className="mt-1 text-sm text-knowable-muted">
            Signed in as {session.email ?? "educator"}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => {
              signOut();
              window.location.href = "/";
            }}
            className="text-sm text-knowable-muted hover:text-knowable-primary transition-colors"
          >
            Sign out
          </button>
          <button
            type="button"
            onClick={() => setModalOpen(true)}
            className="inline-flex items-center gap-2 rounded-xl bg-knowable-orange hover:bg-knowable-orange-hover px-5 py-2.5 text-sm font-semibold text-white shadow-md shadow-knowable-orange/20 transition-colors"
          >
            <span aria-hidden="true">+</span>
            New class
          </button>
        </div>
      </header>

      {error && (
        <div className="mb-6 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {classes === null ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-44 rounded-2xl border border-knowable-border bg-knowable-card animate-pulse"
            />
          ))}
        </div>
      ) : classes.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-knowable-border bg-knowable-card/60 px-8 py-16 text-center">
          <h2 className="font-serif text-2xl text-knowable-primary mb-2">
            No classes yet
          </h2>
          <p className="text-knowable-muted max-w-md mx-auto">
            You haven't created any classes yet. Create one to share a join
            code with your students.
          </p>
          <button
            type="button"
            onClick={() => setModalOpen(true)}
            className="mt-6 inline-flex items-center gap-2 rounded-xl bg-knowable-orange hover:bg-knowable-orange-hover px-5 py-2.5 text-sm font-semibold text-white transition-colors"
          >
            <span aria-hidden="true">+</span>
            Create your first class
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {classes.map((cls) => (
            <ClassCard key={cls.classId} cls={cls} />
          ))}
        </div>
      )}

      <CreateClassModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onCreated={(cls) => {
          // Optimistically prepend the new class so the dashboard shows it
          // immediately even before the post-create dismiss.
          setClasses((prev) => (prev ? [cls, ...prev] : [cls]));
        }}
      />
    </div>
  );
}

export function ClassList() {
  return (
    <AuthProvider>
      <ClassListInner />
    </AuthProvider>
  );
}

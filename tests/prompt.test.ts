import { describe, it, expect } from "vitest";
import {
  buildPassiveHintPrompt,
  buildActiveQueryPrompt,
  NO_ANSWER_GUARDRAIL,
} from "../src/lib/prompt.js";

describe("buildPassiveHintPrompt", () => {
  const base = {
    problem_text: "Solve for x: 2x + 5 = 13",
    transcript: "hmm I don't know where to start",
    hint_history: [],
  };

  it("includes NO_ANSWER_GUARDRAIL", () => {
    const messages = buildPassiveHintPrompt(base);
    const content = messages.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");
    expect(content).toContain(NO_ANSWER_GUARDRAIL);
  });

  it('starts with "Milo here." in system context', () => {
    const messages = buildPassiveHintPrompt(base);
    const content = messages.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");
    expect(content).toContain("Milo here.");
  });

  it("embeds problem_text", () => {
    const messages = buildPassiveHintPrompt(base);
    const content = messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
    expect(content).toContain("Solve for x: 2x + 5 = 13");
  });

  it("embeds transcript", () => {
    const messages = buildPassiveHintPrompt(base);
    const content = messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
    expect(content).toContain("hmm I don't know where to start");
  });

  it("embeds hint_history when present", () => {
    const messages = buildPassiveHintPrompt({
      ...base,
      hint_history: ["First hint: isolate x", "Second hint: subtract 5"],
    });
    const content = messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
    expect(content).toContain("First hint: isolate x");
    expect(content).toContain("Second hint: subtract 5");
  });

  it("returns messages array with role=user", () => {
    const messages = buildPassiveHintPrompt(base);
    expect(messages.length).toBeGreaterThan(0);
    expect(messages[0]?.role).toBe("user");
  });
});

describe("buildActiveQueryPrompt", () => {
  const base = {
    problem_text: "Find the derivative of f(x) = x^3 + 2x",
    user_query: "what rule do I use here?",
    hint_history: [],
  };

  it("includes NO_ANSWER_GUARDRAIL", () => {
    const messages = buildActiveQueryPrompt(base);
    const content = messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
    expect(content).toContain(NO_ANSWER_GUARDRAIL);
  });

  it('starts with "Milo here." in system context', () => {
    const messages = buildActiveQueryPrompt(base);
    const content = messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
    expect(content).toContain("Milo here.");
  });

  it("embeds user_query verbatim", () => {
    const messages = buildActiveQueryPrompt(base);
    const content = messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
    expect(content).toContain("what rule do I use here?");
  });

  it("embeds problem_text", () => {
    const messages = buildActiveQueryPrompt(base);
    const content = messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
    expect(content).toContain("Find the derivative of f(x) = x^3 + 2x");
  });

  it("embeds hint_history when present", () => {
    const messages = buildActiveQueryPrompt({
      ...base,
      hint_history: ["Power rule applies here"],
    });
    const content = messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
    expect(content).toContain("Power rule applies here");
  });

  it("returns messages array with role=user", () => {
    const messages = buildActiveQueryPrompt(base);
    expect(messages.length).toBeGreaterThan(0);
    expect(messages[0]?.role).toBe("user");
  });
});

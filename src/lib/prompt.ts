import type { AnthropicMessage } from "./bedrock.js";

export const NO_ANSWER_GUARDRAIL =
  "You must never reveal the direct final answer or solve the problem for the student. " +
  "Your role is Socratic: guide with questions, hints, and conceptual nudges only. " +
  "If the student explicitly asks for the answer, redirect with a probing question instead.";

const SYSTEM_PROMPT = `You are Milo, an AI math and physics coach for high school students. ${NO_ANSWER_GUARDRAIL}

Key behaviors:
- Start every response with "Milo here."
- Keep hints brief (2-4 sentences max) and age-appropriate
- Ask one guiding question to move the student forward
- Reference specific parts of their work when possible
- Never give away the answer, even if the student explicitly asks`;

export interface PassiveHintInput {
  problem_text: string;
  transcript: string;
  hint_history: string[];
}

export interface ActiveQueryInput {
  problem_text: string;
  user_query: string;
  hint_history: string[];
}

export function buildPassiveHintPrompt(input: PassiveHintInput): AnthropicMessage[] {
  const { problem_text, transcript, hint_history } = input;

  const hintHistoryText =
    hint_history.length > 0
      ? `\nPrevious hints given:\n${hint_history.map((h, i) => `${i + 1}. ${h}`).join("\n")}`
      : "";

  const userMessage = `${SYSTEM_PROMPT}

Problem:
${problem_text}

Student's recent speech (last ~30 seconds):
${transcript || "(none)"}
${hintHistoryText}

The student appears stuck. Provide a gentle Socratic hint to get them moving again. Remember: ${NO_ANSWER_GUARDRAIL}`;

  return [
    {
      role: "user",
      content: userMessage,
    },
  ];
}

export function buildActiveQueryPrompt(input: ActiveQueryInput): AnthropicMessage[] {
  const { problem_text, user_query, hint_history } = input;

  const hintHistoryText =
    hint_history.length > 0
      ? `\nPrevious hints given:\n${hint_history.map((h, i) => `${i + 1}. ${h}`).join("\n")}`
      : "";

  const userMessage = `${SYSTEM_PROMPT}

Problem:
${problem_text}

Student's question: "${user_query}"
${hintHistoryText}

Respond to the student's specific question with a Socratic hint. Remember: ${NO_ANSWER_GUARDRAIL}`;

  return [
    {
      role: "user",
      content: userMessage,
    },
  ];
}

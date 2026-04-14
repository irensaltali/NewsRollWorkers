import test from "node:test";
import assert from "node:assert/strict";

import { renderPromptTemplate, buildPromptInput } from "../src/prompt-config.mjs";

// ── renderPromptTemplate ────────────────────────────────────────────

test("renderPromptTemplate replaces {{variable}} placeholders", () => {
  const result = renderPromptTemplate("Hello {{name}}, welcome to {{place}}.", { name: "Alice", place: "Wonderland" });
  assert.equal(result, "Hello Alice, welcome to Wonderland.");
});

test("renderPromptTemplate replaces ${variable} placeholders", () => {
  const result = renderPromptTemplate('Create art for "${title}". Context: ${sourceText}', { title: "Test Title", sourceText: "Some text" });
  assert.equal(result, 'Create art for "Test Title". Context: Some text');
});

test("renderPromptTemplate replaces mixed {{}} and ${} placeholders", () => {
  const result = renderPromptTemplate("{{title}} and ${sourceText}", { title: "T", sourceText: "S" });
  assert.equal(result, "T and S");
});

test("renderPromptTemplate replaces missing variables with empty string", () => {
  const result = renderPromptTemplate("Hello {{name}}!", {});
  assert.equal(result, "Hello !");
});

test("renderPromptTemplate handles empty template", () => {
  const result = renderPromptTemplate("", { name: "Alice" });
  assert.equal(result, "");
});

// ── buildPromptInput ────────────────────────────────────────────────

test("buildPromptInput substitutes and clips prompt", () => {
  const result = buildPromptInput('Illustration for "{{title}}". {{sourceText}}', { title: "Test", sourceText: "Body" });
  assert.equal(result, 'Illustration for "Test". Body');
});

test("buildPromptInput works with ${} syntax from DB templates", () => {
  const result = buildPromptInput('Blueprint for "${title}". Source: ${sourceText}', { title: "Measles Article", sourceText: "Article body" });
  assert.equal(result, 'Blueprint for "Measles Article". Source: Article body');
});

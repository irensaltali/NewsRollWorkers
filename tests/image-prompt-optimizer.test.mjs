import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_IMAGE_PROMPT_OPTIMIZER_CONFIG,
  buildImagePromptOptimizerInput,
  buildImagePromptOptimizerUserPrompt
} from "../src/image-prompt-optimizer.mjs";

test("buildImagePromptOptimizerInput normalizes article metadata", () => {
  const input = buildImagePromptOptimizerInput({
    title: "  Example Title  ",
    headline: "  Example headline.  ",
    summary: "  Example summary.  ",
    topics: [" ai ", "", "agents"],
    language: " EN "
  });

  assert.deepEqual(input, {
    title: "Example Title",
    headline: "Example headline.",
    summary: "Example summary.",
    topics: ["ai", "agents"],
    language: "en"
  });
});

test("buildImagePromptOptimizerUserPrompt renders the doc_v1 template", () => {
  const prompt = buildImagePromptOptimizerUserPrompt(DEFAULT_IMAGE_PROMPT_OPTIMIZER_CONFIG, {
    title: "Launch",
    headline: "New AI launch.",
    summary: "A product summary.",
    topics: ["ai", "products"],
    language: "en"
  });

  assert.match(prompt, /Title: Launch/);
  assert.match(prompt, /Headline: New AI launch\./);
  assert.match(prompt, /Summary: A product summary\./);
  assert.match(prompt, /Topics: ai, products/);
  assert.match(prompt, /Language: en/);
});

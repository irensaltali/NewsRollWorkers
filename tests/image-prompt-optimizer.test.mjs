import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_IMAGE_PROMPT_OPTIMIZER_CONFIG,
  buildImagePromptOptimizerInput,
  buildImagePromptOptimizerUserPrompt,
  selectImagePromptOptimizerConfig
} from "../src/image-prompt-optimizer.mjs";

test("buildImagePromptOptimizerInput normalizes article metadata", () => {
  const input = buildImagePromptOptimizerInput({
    title: "  Example Title  ",
    headline: "  Example headline.  ",
    summary: "  Example summary.  ",
    topics: [" ai ", "", "agents"],
    language: " EN ",
    markdown: "  Body excerpt.  "
  });

  assert.deepEqual(input, {
    title: "Example Title",
    headline: "Example headline.",
    summary: "Example summary.",
    topics: ["ai", "agents"],
    language: "en",
    markdown: "Body excerpt."
  });
});

test("buildImagePromptOptimizerUserPrompt renders the enhanced template", () => {
  const prompt = buildImagePromptOptimizerUserPrompt(DEFAULT_IMAGE_PROMPT_OPTIMIZER_CONFIG, {
    title: "Launch",
    headline: "New AI launch.",
    summary: "A product summary.",
    topics: ["ai", "products"],
    language: "en",
    markdown: "Body copy"
  });

  assert.match(prompt, /thumbnail-first image prompt/);
  assert.match(prompt, /Title: Launch/);
  assert.match(prompt, /Headline: New AI launch\./);
  assert.match(prompt, /Summary: A product summary\./);
  assert.match(prompt, /Topics: ai, products/);
  assert.match(prompt, /Language: en/);
  assert.match(prompt, /Article Markdown or Body Excerpt: Body copy/);
});

test("selectImagePromptOptimizerConfig chooses topic-matched config before fallback", () => {
  const selection = selectImagePromptOptimizerConfig([
    {
      ...DEFAULT_IMAGE_PROMPT_OPTIMIZER_CONFIG,
      id: 1,
      version: "v1.1-a",
      topicMatchers: ["technology"],
      routingPriority: 100,
      fallback: true
    },
    {
      ...DEFAULT_IMAGE_PROMPT_OPTIMIZER_CONFIG,
      id: 2,
      version: "v1.1-b",
      topicMatchers: ["policy", "finance"],
      keywordMatchers: ["regulation"],
      routingPriority: 20,
      fallback: false
    },
    {
      ...DEFAULT_IMAGE_PROMPT_OPTIMIZER_CONFIG,
      id: 3,
      version: "v1.1-c",
      topicMatchers: ["politics"],
      keywordMatchers: ["vote"],
      routingPriority: 10,
      fallback: false
    }
  ], {
    title: "City vote on new transit policy",
    headline: "Council vote is expected today",
    summary: "The policy decision could reshape local transit funding.",
    topics: ["politics", "policy"],
    language: "en"
  });

  assert.equal(selection.config.id, 3);
  assert.deepEqual(selection.matchedTopics, ["politics"]);
  assert.deepEqual(selection.matchedKeywords, ["vote"]);
  assert.equal(selection.fallbackReason, null);
});

test("selectImagePromptOptimizerConfig falls back to the fallback config when nothing matches", () => {
  const selection = selectImagePromptOptimizerConfig([
    {
      ...DEFAULT_IMAGE_PROMPT_OPTIMIZER_CONFIG,
      id: 1,
      version: "v1.1-a",
      topicMatchers: ["technology"],
      routingPriority: 100,
      fallback: true
    },
    {
      ...DEFAULT_IMAGE_PROMPT_OPTIMIZER_CONFIG,
      id: 2,
      version: "v1.1-b",
      topicMatchers: ["policy"],
      routingPriority: 20,
      fallback: false
    }
  ], {
    title: "Tennis finals this weekend",
    headline: "Fans prepare for a close match",
    summary: "A major tournament concludes on Sunday.",
    topics: ["sports"],
    language: "en"
  });

  assert.equal(selection.config.id, 1);
  assert.deepEqual(selection.matchedTopics, []);
  assert.equal(selection.fallbackReason, "no_topic_match");
});

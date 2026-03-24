// ── JSON Schemas for Structured Outputs ─────────────────────────────

const SUMMARY_SCHEMA = Object.freeze({
  name: "summary_response",
  strict: true,
  schema: {
    type: "object",
    properties: {
      bullets: {
        type: "array",
        description: "3-5 concise bullet points summarizing the article",
        items: { type: "string" },
        minItems: 1,
        maxItems: 5
      }
    },
    required: ["bullets"],
    additionalProperties: false
  }
});

const TRANSLATION_SCHEMA = Object.freeze({
  name: "translation_response",
  strict: true,
  schema: {
    type: "object",
    properties: {
      story: {
        type: "object",
        description: "Translated story fields",
        properties: {
          title: { type: "string", description: "Translated story title" },
          text: { type: "string", description: "Translated story text/body" }
        },
        required: ["title", "text"],
        additionalProperties: false
      },
      comments: {
        type: "array",
        description: "Translated comments preserving original IDs",
        items: {
          type: "object",
          properties: {
            id: { type: "integer", description: "Original comment ID — do not change" },
            text: { type: "string", description: "Translated comment text" }
          },
          required: ["id", "text"],
          additionalProperties: false
        }
      }
    },
    required: ["story", "comments"],
    additionalProperties: false
  }
});

const THREAD_INTELLIGENCE_SCHEMA = Object.freeze({
  name: "thread_intelligence_response",
  strict: true,
  schema: {
    type: "object",
    properties: {
      summary: {
        type: "string",
        description: "A concise summary of the overall comment thread"
      },
      keyInsights: {
        type: "array",
        description: "Three to five notable insights surfaced from the discussion",
        items: { type: "string" }
      },
      discussionShape: {
        type: "string",
        description: "Overall shape of the discussion",
        enum: ["heated", "consensus", "mixed"]
      }
    },
    required: ["summary", "keyInsights", "discussionShape"],
    additionalProperties: false
  }
});

const EXPLAIN_SCHEMA = Object.freeze({
  name: "explain_response",
  strict: true,
  schema: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "A short heading for the explanation"
      },
      sections: {
        type: "array",
        description: "Two to four explanation sections",
        items: {
          type: "object",
          properties: {
            heading: { type: "string" },
            body: { type: "string" }
          },
          required: ["heading", "body"],
          additionalProperties: false
        }
      },
      followUps: {
        type: "array",
        description: "Short follow-up questions or directions for further reading",
        items: { type: "string" }
      },
      level: {
        type: "string",
        description: "The explanation depth used for this response",
        enum: ["simple", "technical"]
      }
    },
    required: ["title", "sections", "followUps", "level"],
    additionalProperties: false
  }
});

// ── Action Definitions ──────────────────────────────────────────────

export const AI_ACTIONS = Object.freeze({
  headline: Object.freeze({
    key: "headline",
    cost: 0,
    model: "o4-mini",
    maxTokens: 150
  }),
  topic_extraction: Object.freeze({
    key: "topic_extraction",
    cost: 0,
    model: "o4-mini",
    maxTokens: 1000
  }),
  summary: Object.freeze({
    key: "summary",
    cost: 1,
    model: "o4-mini",
    maxTokens: 2000,
    schema: SUMMARY_SCHEMA
  }),
  translation: Object.freeze({
    key: "translation",
    cost: 1,
    model: "o1-mini",
    maxTokens: 4000,
    cacheTtlMs: 3 * 24 * 60 * 60 * 1000,
    schema: TRANSLATION_SCHEMA
  }),
  structured_translation: Object.freeze({
    key: "structured_translation",
    cost: 1,
    model: "o1-mini",
    maxTokens: 16000,
    cacheTtlMs: 3 * 24 * 60 * 60 * 1000
  }),
  thread_intelligence: Object.freeze({
    key: "thread_intelligence",
    cost: 8,
    model: "o4-mini",
    maxTokens: 3000,
    cacheTtlMs: 3 * 24 * 60 * 60 * 1000,
    schema: THREAD_INTELLIGENCE_SCHEMA
  }),
  explain_simple: Object.freeze({
    key: "explain_simple",
    cost: 6,
    model: "o4-mini",
    maxTokens: 4000,
    cacheTtlMs: 3 * 24 * 60 * 60 * 1000,
    schema: EXPLAIN_SCHEMA
  }),
  explain_technical: Object.freeze({
    key: "explain_technical",
    cost: 10,
    model: "o4-mini",
    maxTokens: 4000,
    cacheTtlMs: 3 * 24 * 60 * 60 * 1000,
    schema: EXPLAIN_SCHEMA
  })
});

export const CREDIT_COSTS = Object.freeze(
  Object.fromEntries(
    Object.values(AI_ACTIONS)
      .map((action) => [action.key, action.cost])
  )
);

import {
  pgTable,
  text,
  timestamp,
  boolean,
  integer,
  bigint,
  jsonb,
  real,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

/**
 * NEXA ownership model (Phase 16).
 *
 * Every user-owned row carries `userId` with a real foreign key to `users.id`.
 * Ownership queries enforce `id = requestedId AND userId = currentUser.id` at
 * the data-access layer. Cascade is used only where a child row has no meaning
 * without its parent (messages, chunks, sessions, tool history). Conventional
 * joins (conversations -> projects, documents -> projects) are soft references
 * validated at the API layer so a user cannot link another user's project.
 */

export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    name: text("name"),
    passwordHash: text("password_hash").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("users_email_unique").on(t.email)]
);

export const sessions = pgTable(
  "sessions",
  {
    // Primary key is a SHA-256 hash of the session token. The raw token only
    // ever lives inside the HttpOnly session cookie.
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("sessions_user_id_idx").on(t.userId),
    index("sessions_expires_at_idx").on(t.expiresAt),
  ]
);

export const passwordResetTokens = pgTable(
  "password_reset_tokens",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("password_reset_tokens_user_id_idx").on(t.userId),
    index("password_reset_tokens_token_hash_idx").on(t.tokenHash),
    index("password_reset_tokens_expires_at_idx").on(t.expiresAt),
  ]
);

export const conversations = pgTable(
  "conversations",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
  model: text("model").notNull().default("llama3.2:latest"),
  profile: text("profile").notNull().default("BALANCED"),
  systemPrompt: text("system_prompt"),
  isArchived: boolean("is_archived").notNull().default(false),
  isPinned: boolean("is_pinned").notNull().default(false),
  projectId: text("project_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
},
(t) => [
  index("conversations_user_id_idx").on(t.userId),
  index("conversations_updated_at_idx").on(t.updatedAt),
]
);

export const messages = pgTable(
  "messages",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id")
    .notNull()
    .references(() => conversations.id, { onDelete: "cascade" }),
  role: text("role").notNull(), // 'user' | 'assistant' | 'system' | 'tool'
  content: text("content").notNull(),
  reasoningContent: text("reasoning_content"),
  citations: jsonb("citations").$type<Array<{
    title: string;
    url?: string;
    snippet: string;
    sourceType: "file" | "web" | "memory";
    chunkIndex?: number;
    score?: number;
  }>>(),
  toolCalls: jsonb("tool_calls").$type<Array<{
    id: string;
    name: string;
    input: Record<string, unknown>;
    output?: unknown;
    status: "pending" | "success" | "failed" | "denied";
  }>>(),
  attachments: jsonb("attachments").$type<Array<{
    id: string;
    name: string;
    size: number;
    mimeType: string;
    url?: string;
  }>>(),
  modelUsed: text("model_used"),
  latencyMs: integer("latency_ms"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
},
(t) => [index("messages_conversation_id_idx").on(t.conversationId)]
);

export const projects = pgTable(
  "projects",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
  description: text("description"),
  instructions: text("instructions"),
      modelPreference: text("model_preference").default("BALANCED"),
      createdAt: timestamp("created_at").notNull().defaultNow(),
      updatedAt: timestamp("updated_at").notNull().defaultNow(),
    },
    (t) => [index("projects_user_id_idx").on(t.userId)]
  );

  export const documents = pgTable(
    "documents",
    {
      id: text("id").primaryKey(),
      userId: text("user_id")
        .notNull()
        .references(() => users.id, { onDelete: "cascade" }),
      name: text("name").notNull(),
  mimeType: text("mime_type").notNull(),
  size: integer("size").notNull(),
  characterCount: integer("character_count").notNull().default(0),
  chunkCount: integer("chunk_count").notNull().default(0),
  status: text("status").notNull().default("indexed"), // 'pending' | 'indexed' | 'failed'
  projectId: text("project_id"),
      rawContent: text("raw_content"),
      createdAt: timestamp("created_at").notNull().defaultNow(),
    },
    (t) => [
      index("documents_user_id_idx").on(t.userId),
      index("documents_project_id_idx").on(t.projectId),
    ]
  );

  export const documentChunks = pgTable(
    "document_chunks",
    {
      id: text("id").primaryKey(),
      documentId: text("document_id")
        .notNull()
        .references(() => documents.id, { onDelete: "cascade" }),
      chunkIndex: integer("chunk_index").notNull(),
      content: text("content").notNull(),
  embedding: jsonb("embedding").$type<number[]>(),
  metadata: jsonb("metadata").$type<{
    documentName: string;
    pageNumber?: number;
    tokens?: number;
    charStart?: number;
    charEnd?: number;
  }>(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
},
(t) => [index("document_chunks_document_id_idx").on(t.documentId)]
);

export const memories = pgTable(
  "memories",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    content: text("content").notNull(),
  category: text("category").notNull().default("preference"), // 'preference' | 'fact' | 'instruction'
  source: text("source").notNull().default("explicit"), // 'explicit' | 'inferred'
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
},
(t) => [
  index("memories_user_id_idx").on(t.userId),
  index("memories_is_active_idx").on(t.isActive),
]
);

export const toolCalls = pgTable(
  "tool_calls",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id"),
  toolName: text("tool_name").notNull(),
  input: jsonb("input"),
  output: jsonb("output"),
  status: text("status").notNull().default("success"), // 'success' | 'failed' | 'denied'
  riskLevel: text("risk_level").notNull().default("low"), // 'low' | 'medium' | 'high'
  durationMs: integer("duration_ms").default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
},
(t) => [
  index("tool_calls_user_id_idx").on(t.userId),
  index("tool_calls_conversation_id_idx").on(t.conversationId),
]
);

export const modelConfigs = pgTable(
  "model_configs",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(), // 'ollama' | 'openai_compatible' | 'vllm' | 'custom' | 'demo'
  baseUrl: text("base_url").notNull().default("http://localhost:11434"),
  modelName: text("model_name").notNull().default("llama3.2:latest"),
  apiKey: text("api_key"),
  temperature: real("temperature").default(0.7),
  topP: real("top_p").default(0.9),
  maxTokens: integer("max_tokens").default(4096),
  contextWindow: integer("context_window").default(8192),
  systemPrompt: text("system_prompt"),
  isDefault: boolean("is_default").notNull().default(true),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
},
(t) => [index("model_configs_user_id_idx").on(t.userId)]
);

export const agentRuns = pgTable(
  "agent_runs",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    goal: text("goal").notNull(),
  status: text("status").notNull().default("running"), // 'running' | 'completed' | 'failed' | 'cancelled'
  steps: jsonb("steps").$type<Array<{
    step: number;
    thought: string;
    action?: string;
    toolInput?: Record<string, unknown>;
    toolOutput?: unknown;
    status: "running" | "completed" | "failed";
  }>>(),
  result: text("result"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  completedAt: timestamp("completed_at"),
},
(t) => [index("agent_runs_user_id_idx").on(t.userId)]
);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: text("id").primaryKey(),
    userId: text("user_id"),
    action: text("action").notNull(),
    details: jsonb("details"),
    ip: text("ip"),
    status: text("status").notNull().default("success"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("audit_logs_user_id_idx").on(t.userId)]
);

/* ------------------------------------------------------------------ */
/* NEXA AI Gateway (Phase 17)                                          */
/* ------------------------------------------------------------------ */

/**
 * NEXA API keys for the public OpenAI-compatible `/v1/*` surface.
 *
 * Only a hash of the key is stored. The plaintext key is returned exactly once,
 * at creation, and is never recoverable — the same rule the session table
 * follows. `keyPrefix` exists so a user can recognise a key in a list without
 * the secret being present anywhere.
 */
export const apiKeys = pgTable(
  "api_keys",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull().default("NEXA API key"),
    /** SHA-256 (peppered) of the raw key, hex encoded. */
    keyHash: text("key_hash").notNull(),
    /** Display-only fragment, e.g. `nexa_sk_a1b2c3…`. */
    keyPrefix: text("key_prefix").notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    requestCount: integer("request_count").notNull().default(0),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("api_keys_key_hash_unique").on(t.keyHash),
    index("api_keys_user_id_idx").on(t.userId),
  ]
);

/**
 * Last observed health of a provider or of one provider model.
 *
 * Durable so a cold serverless instance does not treat a known-bad provider as
 * healthy. `status` uses the gateway vocabulary (healthy / unavailable /
 * rate_limited / timeout / authentication_error / provider_error). A row is
 * only ever written from a real observation.
 */
export const providerHealth = pgTable(
  "provider_health",
  {
    /** `${providerId}::${modelId ?? "*"}` */
    id: text("id").primaryKey(),
    providerId: text("provider_id").notNull(),
    /** null = provider-level observation. */
    modelId: text("model_id"),
    status: text("status").notNull(),
    ok: boolean("ok").notNull().default(false),
    latencyMs: integer("latency_ms"),
    errorCategory: text("error_category"),
    message: text("message"),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("provider_health_provider_id_idx").on(t.providerId),
    index("provider_health_status_idx").on(t.status),
    index("provider_health_checked_at_idx").on(t.checkedAt),
  ]
);

/**
 * Distributed rate-limit buckets.
 *
 * PostgreSQL is the rate-limit store because it is the one datastore NEXA
 * already requires in production, and it is shared by every serverless
 * instance. An in-process `Map` is not: each instance would enforce its own
 * quota, so the effective limit would scale with the instance count.
 *
 * The window is a fixed bucket identified by `bucketKey` + `windowStart`. The
 * increment and the window reset happen in ONE statement (see
 * `lib/gateway/rate-limit.ts`), so concurrent requests cannot both read a
 * count and then write count+1 and slip past the limit.
 *
 * `windowStart` is epoch milliseconds rather than a timestamp: a rate limiter
 * compares windows arithmetically, and epoch ms is unambiguous about the
 * timezone and the clock the value came from.
 *
 * Rows are opportunistic garbage: each one is rewritten on the next request in
 * its own window, and `pruneRateLimitBuckets` removes anything stale.
 */
export const rateLimitBuckets = pgTable(
  "rate_limit_buckets",
  {
    /** e.g. `v1:key:a1b2…` or `v1:ip:203.0.113.7`. Never a raw API key. */
    bucketKey: text("bucket_key").primaryKey(),
    /** Start of the fixed window this counter belongs to, in epoch ms. */
    windowStart: bigint("window_start", { mode: "number" }).notNull(),
    /** Requests seen in the current window. */
    count: integer("count").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("rate_limit_buckets_updated_at_idx").on(t.updatedAt)]
);

/* ------------------------------------------------------------------ */
/* Relations — static validation aid for the ownership graph.         */
/* ------------------------------------------------------------------ */

export const usersRelations = relations(users, ({ many, one }) => ({
  sessions: many(sessions),
  passwordResetTokens: many(passwordResetTokens),
  conversations: many(conversations),
  projects: many(projects),
  documents: many(documents),
  memories: many(memories),
  modelConfigs: many(modelConfigs),
  toolCalls: many(toolCalls),
  agentRuns: many(agentRuns),
  apiKeys: many(apiKeys),
}));

export const apiKeysRelations = relations(apiKeys, ({ one }) => ({
  user: one(users, { fields: [apiKeys.userId], references: [users.id] }),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, { fields: [sessions.userId], references: [users.id] }),
}));

export const passwordResetTokensRelations = relations(passwordResetTokens, ({ one }) => ({
  user: one(users, { fields: [passwordResetTokens.userId], references: [users.id] }),
}));

export const conversationsRelations = relations(conversations, ({ one, many }) => ({
  user: one(users, { fields: [conversations.userId], references: [users.id] }),
  messages: many(messages),
}));

export const messagesRelations = relations(messages, ({ one }) => ({
  conversation: one(conversations, {
    fields: [messages.conversationId],
    references: [conversations.id],
  }),
}));

export const projectsRelations = relations(projects, ({ one, many }) => ({
  user: one(users, { fields: [projects.userId], references: [users.id] }),
  documents: many(documents),
}));

export const documentsRelations = relations(documents, ({ one, many }) => ({
  user: one(users, { fields: [documents.userId], references: [users.id] }),
  chunks: many(documentChunks),
}));

export const documentChunksRelations = relations(documentChunks, ({ one }) => ({
  document: one(documents, {
    fields: [documentChunks.documentId],
    references: [documents.id],
  }),
}));

export const memoriesRelations = relations(memories, ({ one }) => ({
  user: one(users, { fields: [memories.userId], references: [users.id] }),
}));

export const modelConfigsRelations = relations(modelConfigs, ({ one }) => ({
  user: one(users, { fields: [modelConfigs.userId], references: [users.id] }),
}));

export const toolCallsRelations = relations(toolCalls, ({ one }) => ({
  user: one(users, { fields: [toolCalls.userId], references: [users.id] }),
}));

export const agentRunsRelations = relations(agentRuns, ({ one }) => ({
  user: one(users, { fields: [agentRuns.userId], references: [users.id] }),
}));

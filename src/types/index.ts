export type ModelProfile =
  | "FAST"
  | "BALANCED"
  | "REASONING"
  | "CODING"
  | "VISION"
  | "LONG_CONTEXT";

export type ProviderType =
  | "ollama"
  | "openai_compatible"
  | "vllm"
  /** FreeLLMAPI: an external OpenAI-compatible gateway. First-class provider. */
  | "freellmapi"
  | "custom"
  | "demo";

export interface ModelDescriptor {
  id: string;
  name: string;
  provider: ProviderType;
  profile: ModelProfile;
  contextWindow: number;
  description: string;
  supportsStreaming: boolean;
  supportsTools: boolean;
  supportsVision: boolean;
  recommendedFor: string;
  isLocal: boolean;
}

export interface Citation {
  title: string;
  url?: string;
  snippet: string;
  sourceType: "file" | "web" | "memory";
  chunkIndex?: number;
  score?: number;
}

export interface Attachment {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  url?: string;
  content?: string;
}

export interface ToolCallItem {
  id: string;
  name: string;
  input: Record<string, unknown>;
  output?: unknown;
  status: "pending" | "success" | "failed" | "denied";
}

export interface Message {
  id: string;
  conversationId: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  reasoningContent?: string;
  citations?: Citation[];
  toolCalls?: ToolCallItem[];
  attachments?: Attachment[];
  modelUsed?: string;
  latencyMs?: number;
  createdAt: string;
}

export interface Conversation {
  id: string;
  title: string;
  model: string;
  profile: ModelProfile;
  systemPrompt?: string | null;
  isArchived: boolean;
  isPinned: boolean;
  projectId?: string | null;
  createdAt: string;
  updatedAt: string;
  messageCount?: number;
}

export interface Project {
  id: string;
  name: string;
  description?: string | null;
  instructions?: string | null;
  modelPreference?: string | null;
  createdAt: string;
  updatedAt: string;
  fileCount?: number;
}

export interface DocumentItem {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  characterCount: number;
  chunkCount: number;
  status: "pending" | "indexed" | "failed";
  projectId?: string | null;
  createdAt: string;
}

export interface DocumentChunkItem {
  id: string;
  documentId: string;
  chunkIndex: number;
  content: string;
  metadata?: {
    documentName: string;
    pageNumber?: number;
    tokens?: number;
    charStart?: number;
    charEnd?: number;
  };
  score?: number;
}

export interface MemoryItem {
  id: string;
  content: string;
  category: "preference" | "fact" | "instruction";
  source: "explicit" | "inferred";
  isActive: boolean;
  createdAt: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  riskLevel: "low" | "medium" | "high";
  requiresConfirmation?: boolean;
  enabled: boolean;
}

export interface ModelConfigRecord {
  id: string;
  provider: ProviderType;
  baseUrl: string;
  modelName: string;
  apiKey?: string | null;
  temperature: number;
  topP: number;
  maxTokens: number;
  contextWindow: number;
  systemPrompt?: string | null;
  isDefault: boolean;
  isActive: boolean;
}

export interface AgentStep {
  step: number;
  thought: string;
  action?: string;
  toolInput?: Record<string, unknown>;
  toolOutput?: unknown;
  status: "running" | "completed" | "failed";
}

export interface AgentRunItem {
  id: string;
  goal: string;
  status: "running" | "completed" | "failed" | "cancelled";
  steps: AgentStep[];
  result?: string | null;
  createdAt: string;
  completedAt?: string | null;
}

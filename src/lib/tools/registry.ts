import { ToolDefinition } from "@/types";

export const BUILTIN_TOOLS: Record<string, ToolDefinition> = {
  calculator: {
    name: "calculator",
    description: "Evaluates mathematical expressions safely using an isolated math parser.",
    inputSchema: {
      type: "object",
      properties: {
        expression: {
          type: "string",
          description: "Math expression to evaluate, e.g. '(15 * 4.2) / (12 + 3)' or 'sqrt(144) + 2^4'",
        },
      },
      required: ["expression"],
    },
    riskLevel: "low",
    requiresConfirmation: false,
    enabled: true,
  },
  datetime: {
    name: "datetime",
    description: "Returns the current date, time, day of the week, UTC timestamp, and timezone.",
    inputSchema: {
      type: "object",
      properties: {
        timezone: {
          type: "string",
          description: "Optional IANA timezone name (e.g. 'UTC', 'America/New_York', 'Europe/London')",
        },
      },
    },
    riskLevel: "low",
    requiresConfirmation: false,
    enabled: true,
  },
  file_search: {
    name: "file_search",
    description: "Searches uploaded documents, codebases, and notes by filename or keyword.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search keyword or filename substring",
        },
        projectId: {
          type: "string",
          description: "Optional project ID to scope the search",
        },
      },
      required: ["query"],
    },
    riskLevel: "low",
    requiresConfirmation: false,
    enabled: true,
  },
  document_reader: {
    name: "document_reader",
    description: "Reads raw content or a specific chunk from an indexed document by ID.",
    inputSchema: {
      type: "object",
      properties: {
        documentId: {
          type: "string",
          description: "The unique ID of the document to inspect",
        },
        chunkIndex: {
          type: "number",
          description: "Optional chunk index to inspect a specific slice",
        },
      },
      required: ["documentId"],
    },
    riskLevel: "low",
    requiresConfirmation: false,
    enabled: true,
  },
  web_search: {
    name: "web_search",
    description: "Queries configured search engine (SearXNG/Brave/Tavily) for recent real-world information.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The search query to send to the search engine",
        },
        limit: {
          type: "number",
          description: "Number of search results to return (default 4)",
        },
      },
      required: ["query"],
    },
    riskLevel: "medium",
    requiresConfirmation: false,
    enabled: true,
  },
  json_parser: {
    name: "json_parser",
    description: "Parses, formats, validates, or extracts specific keys from a JSON payload.",
    inputSchema: {
      type: "object",
      properties: {
        jsonText: {
          type: "string",
          description: "The raw JSON string to parse",
        },
        keyPath: {
          type: "string",
          description: "Optional dot-notation path to extract, e.g. 'data.user.email'",
        },
      },
      required: ["jsonText"],
    },
    riskLevel: "low",
    requiresConfirmation: false,
    enabled: true,
  },
  code_formatter: {
    name: "code_formatter",
    description: "Cleans, indents, and structures source code for TypeScript, JavaScript, SQL, or HTML.",
    inputSchema: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description: "The source code string",
        },
        language: {
          type: "string",
          description: "Language identifier (typescript, javascript, sql, json, html, css)",
        },
      },
      required: ["code", "language"],
    },
    riskLevel: "low",
    requiresConfirmation: false,
    enabled: true,
  },
  text_extraction: {
    name: "text_extraction",
    description: "Extracts structured metadata, word count, character count, links, and keywords from raw text.",
    inputSchema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "Raw text to analyze",
        },
      },
      required: ["text"],
    },
    riskLevel: "low",
    requiresConfirmation: false,
    enabled: true,
  },
};

export class ToolRegistry {
  private static tools: Map<string, ToolDefinition> = new Map(
    Object.entries(BUILTIN_TOOLS)
  );

  public static getAll(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  public static get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  public static setEnabled(name: string, enabled: boolean): void {
    const tool = this.tools.get(name);
    if (tool) {
      tool.enabled = enabled;
    }
  }

  public static isAllowed(name: string): boolean {
    const tool = this.tools.get(name);
    return tool ? tool.enabled : false;
  }
}

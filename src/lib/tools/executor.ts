import { db } from "@/db";
import { documentChunks, documents, toolCalls } from "@/db/schema";
import { WebSearchService } from "../search/web-search";
import { ToolRegistry } from "./registry";
import { and, eq, ilike, or } from "drizzle-orm";

export interface ToolExecutionResult {
  toolName: string;
  status: "success" | "failed" | "denied";
  result?: unknown;
  error?: string;
  durationMs: number;
}

export class ToolExecutor {
  public static async execute(
    toolName: string,
    input: Record<string, unknown>,
    conversationId?: string,
    /** Owning user. Document tools never read across user boundaries. */
    userId?: string
  ): Promise<ToolExecutionResult> {
    const start = Date.now();
    const toolDef = ToolRegistry.get(toolName);

    if (!toolDef || !toolDef.enabled) {
      return {
        toolName,
        status: "denied",
        error: `Tool '${toolName}' is either not recognized or disabled in system settings.`,
        durationMs: 0,
      };
    }

    try {
      let result: unknown;

      switch (toolName) {
        case "calculator": {
          result = this.executeCalculator(String(input.expression || ""));
          break;
        }

        case "datetime": {
          const tz = typeof input.timezone === "string" ? input.timezone : "UTC";
          const now = new Date();
          result = {
            utc: now.toISOString(),
            formatted: now.toLocaleString("en-US", { timeZone: tz }),
            timestamp: now.getTime(),
            timezone: tz,
            dayOfWeek: now.toLocaleDateString("en-US", { weekday: "long", timeZone: tz }),
          };
          break;
        }

        case "file_search": {
          const q = String(input.query || "");
          const docFilters = userId ? [eq(documents.userId, userId)] : [];
          if (q) {
            docFilters.push(
              or(ilike(documents.name, `%${q}%`), ilike(documents.rawContent, `%${q}%`))!
            );
          }
          const docs = await db
            .select({
              id: documents.id,
              name: documents.name,
              mimeType: documents.mimeType,
              size: documents.size,
              characterCount: documents.characterCount,
              chunkCount: documents.chunkCount,
            })
            .from(documents)
            .where(docFilters.length > 0 ? and(...docFilters) : undefined)
            .limit(10);
          result = { count: docs.length, matches: docs };
          break;
        }

        case "document_reader": {
          const docId = String(input.documentId || "");
          const chunkIdx = typeof input.chunkIndex === "number" ? input.chunkIndex : undefined;

          // Ownership first: a document id that does not belong to the caller
          // is treated as not found.
          const ownedDocs = await db
            .select({ id: documents.id })
            .from(documents)
            .where(
              userId
                ? and(eq(documents.id, docId), eq(documents.userId, userId))
                : eq(documents.id, docId)
            )
            .limit(1);
          if (ownedDocs.length === 0) {
            result = { error: `Document ${docId} not found` };
            break;
          }

          if (chunkIdx !== undefined) {
            const chunks = await db
              .select()
              .from(documentChunks)
              .where(eq(documentChunks.documentId, docId))
              .limit(50);
            const target = chunks.find((c) => c.chunkIndex === chunkIdx);
            result = target
              ? { documentId: docId, chunkIndex: chunkIdx, content: target.content }
              : { error: `Chunk index ${chunkIdx} not found for document ${docId}` };
          } else {
            const docs = await db.select().from(documents).where(eq(documents.id, docId)).limit(1);
            result =
              docs.length > 0
                ? {
                    id: docs[0].id,
                    name: docs[0].name,
                    characterCount: docs[0].characterCount,
                    contentPreview: (docs[0].rawContent || "").slice(0, 1000),
                  }
                : { error: `Document ${docId} not found` };
          }
          break;
        }
        case "web_search": {
          const query = String(input.query || "");
          const limit = typeof input.limit === "number" ? input.limit : 4;
          result = await WebSearchService.search(query, limit);
          break;
        }

        case "json_parser": {
          const raw = String(input.jsonText || "");
          const parsed = JSON.parse(raw);
          const keyPath = typeof input.keyPath === "string" ? input.keyPath : "";
          if (keyPath) {
            const parts = keyPath.split(".");
            let current: unknown = parsed;
            for (const part of parts) {
              if (current && typeof current === "object" && part in (current as Record<string, unknown>)) {
                current = (current as Record<string, unknown>)[part];
              } else {
                current = undefined;
                break;
              }
            }
            result = { keyPath, value: current };
          } else {
            result = { isValid: true, parsed, keys: Object.keys(parsed) };
          }
          break;
        }

        case "code_formatter": {
          const code = String(input.code || "");
          const lang = String(input.language || "typescript").toLowerCase();
          if (lang === "json") {
            try {
              result = { formatted: JSON.stringify(JSON.parse(code), null, 2) };
            } catch {
              result = { formatted: code };
            }
          } else {
            // Indent formatting
            const lines = code.split("\n").map((l) => l.trimEnd());
            result = { formatted: lines.join("\n"), lines: lines.length };
          }
          break;
        }

        case "text_extraction": {
          const text = String(input.text || "");
          const words = text.trim().split(/\s+/).filter(Boolean);
          const emails = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];
          const urls = text.match(/https?:\/\/[^\s]+/g) || [];
          result = {
            characterCount: text.length,
            wordCount: words.length,
            lineCount: text.split("\n").length,
            extractedEmails: Array.from(new Set(emails)),
            extractedUrls: Array.from(new Set(urls)),
          };
          break;
        }

        default:
          return {
            toolName,
            status: "denied",
            error: `Unknown tool execution handler: ${toolName}`,
            durationMs: Date.now() - start,
          };
      }

      const durationMs = Date.now() - start;

      // Log tool call to DB (owned rows only; unowned executions are not logged)
      try {
        if (userId) {
          await db.insert(toolCalls).values({
            id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            userId,
            conversationId: conversationId || null,
            toolName,
            input,
            output: result as Record<string, unknown>,
            status: "success",
            riskLevel: toolDef.riskLevel,
            durationMs,
          });
        }
      } catch (err) {
        console.warn("Failed to record tool call log:", err);
      }

      return {
        toolName,
        status: "success",
        result,
        durationMs,
      };
    } catch (err: unknown) {
      const durationMs = Date.now() - start;
      const errorMsg = err instanceof Error ? err.message : String(err);
      return {
        toolName,
        status: "failed",
        error: errorMsg,
        durationMs,
      };
    }
  }

  /**
   * Safe math parser: strictly avoids eval() or new Function()
   */
  private static executeCalculator(expression: string): { expression: string; result: number } {
    // Sanitize: allow only numbers, operators, parens, decimal points, and allowed math functions
    const cleaned = expression.replace(/\s+/g, "");
    if (!/^[0-9+\-*/%^().sqrtabsroundMath,\s]+$/i.test(cleaned)) {
      throw new Error(
        "Invalid mathematical expression. Only standard arithmetic and numeric operations are permitted."
      );
    }

    // Replace power operator
    const sanitized = cleaned
      .replace(/\^/g, "**")
      .replace(/sqrt\(/g, "Math.sqrt(")
      .replace(/abs\(/g, "Math.abs(")
      .replace(/round\(/g, "Math.round(");

    // Tokenized calculation using recursive descent parser
    const computed = this.parseArithmetic(sanitized);
    return { expression, result: computed };
  }

  private static parseArithmetic(expr: string): number {
    // Clean string tokens
    const tokens = expr.match(/(Math\.\w+|[0-9]+(?:\.[0-9]+)?|\*\*|[+\-*/()])/g);
    if (!tokens) throw new Error("Could not parse tokens from expression");

    let pos = 0;

    function parsePrimary(): number {
      const tok = tokens![pos++];
      if (tok === "(") {
        const val = parseAddSub();
        if (tokens![pos++] !== ")") throw new Error("Mismatched parentheses");
        return val;
      }
      if (tok === "Math.sqrt") {
        if (tokens![pos++] !== "(") throw new Error("Expected '(' after sqrt");
        const arg = parseAddSub();
        if (tokens![pos++] !== ")") throw new Error("Expected ')' after sqrt argument");
        return Math.sqrt(arg);
      }
      if (tok === "Math.abs") {
        if (tokens![pos++] !== "(") throw new Error("Expected '(' after abs");
        const arg = parseAddSub();
        if (tokens![pos++] !== ")") throw new Error("Expected ')' after abs argument");
        return Math.abs(arg);
      }
      if (tok === "Math.round") {
        if (tokens![pos++] !== "(") throw new Error("Expected '(' after round");
        const arg = parseAddSub();
        if (tokens![pos++] !== ")") throw new Error("Expected ')' after round argument");
        return Math.round(arg);
      }
      if (tok === "-") {
        return -parsePrimary();
      }
      const num = parseFloat(tok);
      if (isNaN(num)) throw new Error(`Unexpected token: ${tok}`);
      return num;
    }

    function parsePower(): number {
      let val = parsePrimary();
      while (pos < tokens!.length && tokens![pos] === "**") {
        pos++;
        val = Math.pow(val, parsePrimary());
      }
      return val;
    }

    function parseMulDiv(): number {
      let val = parsePower();
      while (pos < tokens!.length && (tokens![pos] === "*" || tokens![pos] === "/" || tokens![pos] === "%")) {
        const op = tokens![pos++];
        const right = parsePower();
        if (op === "*") val *= right;
        else if (op === "/") {
          if (right === 0) throw new Error("Division by zero");
          val /= right;
        } else if (op === "%") {
          val %= right;
        }
      }
      return val;
    }

    function parseAddSub(): number {
      let val = parseMulDiv();
      while (pos < tokens!.length && (tokens![pos] === "+" || tokens![pos] === "-")) {
        const op = tokens![pos++];
        const right = parseMulDiv();
        if (op === "+") val += right;
        else val -= right;
      }
      return val;
    }

    const res = parseAddSub();
    return Math.round(res * 1e8) / 1e8;
  }
}

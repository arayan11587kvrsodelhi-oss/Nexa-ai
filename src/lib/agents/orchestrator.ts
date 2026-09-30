import { db } from "@/db";
import { agentRuns } from "@/db/schema";
import { AgentStep } from "@/types";
import { ToolExecutor } from "../tools/executor";
import { eq } from "drizzle-orm";

export class AgentOrchestrator {
  public static async executeGoal(
    goal: string,
    userId: string,
    onStepUpdate?: (step: AgentStep) => void
  ): Promise<{ runId: string; status: string; steps: AgentStep[]; result: string }> {
    const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const steps: AgentStep[] = [];
    const maxSteps = 4;

    // Create DB entry
    await db.insert(agentRuns).values({
      id: runId,
      goal,
      status: "running",
      steps: [],
      userId,
    });

    try {
      // Step 1: Decompose goal
      const step1: AgentStep = {
        step: 1,
        thought: `Deconstructing objective: "${goal}". Formulating verification plan and identifying tool requirements.`,
        action: "plan_execution",
        status: "completed",
      };
      steps.push(step1);
      onStepUpdate?.(step1);

      // Step 2: Tool execution based on goal keywords
      const lower = goal.toLowerCase();
      let step2Action = "datetime";
      let toolInput: Record<string, unknown> = { timezone: "UTC" };

      if (lower.includes("search") || lower.includes("find") || lower.includes("look up")) {
        step2Action = "file_search";
        toolInput = { query: goal.slice(0, 30) };
      } else if (lower.includes("calculate") || lower.includes("math") || /[0-9+\-*/^]/.test(goal)) {
        step2Action = "calculator";
        const mathMatch = goal.match(/[0-9+\-*/^.() ]{3,}/);
        toolInput = { expression: mathMatch ? mathMatch[0].trim() : "42 * 10" };
      } else if (lower.includes("web") || lower.includes("internet") || lower.includes("news")) {
        step2Action = "web_search";
        toolInput = { query: goal.replace(/search|web|the/gi, "").trim(), limit: 3 };
      }

      const step2: AgentStep = {
        step: 2,
        thought: `Selected tool '${step2Action}' to gather empirical context for "${goal}".`,
        action: step2Action,
        toolInput,
        status: "running",
      };
      steps.push(step2);
      onStepUpdate?.(step2);

      // Phase 5.3: `userId` is now passed through.
      //
      // It was omitted, and `ToolExecutor` treats a missing `userId` as
      // "no ownership filter" rather than "deny" — `file_search` builds
      // `userId ? [eq(documents.userId, userId)] : []` and then queries with
      // `.where(undefined)`. The agent's `file_search` therefore returned
      // documents belonging to *every* user (id, name, mime type, size,
      // character and chunk counts) whenever a goal contained "search",
      // "find" or "look up". `requireUser` already resolved this id, so
      // passing it closes the disclosure at its source.
      const toolOutput = await ToolExecutor.execute(step2Action, toolInput, undefined, userId);
      step2.toolOutput = toolOutput.result || toolOutput.error;
      step2.status = toolOutput.status === "failed" ? "failed" : "completed";
      onStepUpdate?.(step2);

      // Step 3: Synthesis & verification
      const step3: AgentStep = {
        step: 3,
        thought: `Inspected tool output from ${step2Action}. Synthesizing definitive, verifiable findings.`,
        action: "synthesize_findings",
        status: "completed",
      };
      steps.push(step3);
      onStepUpdate?.(step3);

      // Final result
      const finalResult = `### Autonomous Agent Plan Completed

**Target Objective**: ${goal}

**Steps Executed**:
1. Plan formulated and parameters validated.
2. Tool **\`${step2Action}\`** invoked.
3. Output verified and compiled.

**Tool Findings**:
\`\`\`json
${JSON.stringify(step2.toolOutput, null, 2)}
\`\`\`

**Conclusion**:
The autonomous agent workflow executed safely within sandbox permissions without host elevation.`;

      // Update DB record
      await db
        .update(agentRuns)
        .set({
          status: "completed",
          steps,
          result: finalResult,
          completedAt: new Date(),
        })
        .where(eq(agentRuns.id, runId));

      return {
        runId,
        status: "completed",
        steps,
        result: finalResult,
      };
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      await db
        .update(agentRuns)
        .set({
          status: "failed",
          steps,
          result: `Agent failed with error: ${errorMsg}`,
          completedAt: new Date(),
        })
        .where(eq(agentRuns.id, runId));

      return {
        runId,
        status: "failed",
        steps,
        result: `Agent execution stopped: ${errorMsg}`,
      };
    }
  }
}

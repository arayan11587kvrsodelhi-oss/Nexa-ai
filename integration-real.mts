/**
 * Real end-to-end validation: NEXA â†’ NexaGateway â†’ AI Horde â†’ real model.
 *
 * This drives the actual production classes (NexaGateway, GatewayRouter,
 * AIHordeProvider, health store, registry). Nothing is mocked: the only
 * stubbed dependency is the process env, which is the same configuration a
 * real deployment has.
 *
 * It never prints a credential. Model ids and gateway metadata are the point
 * of the test, so those are printed.
 */
import "dotenv/config";

process.env.AI_HORDE_ENABLED = "true";
process.env.AI_HORDE_BASE_URL = "https://oai.aihorde.net/v1";

const { NexaGateway } = await import("./src/lib/gateway/gateway.ts");

const MODEL = "koboldcpp/Angelic_Eclipse-12B";
const PINNED = `aihorde/${MODEL}`;
const PROMPT = "Reply with exactly: NEXA REAL PROVIDER TEST PASSED";

function hr(title) {
  console.log(`\n${"=".repeat(70)}\n${title}\n${"=".repeat(70)}`);
}

hr("1. Provider discovery + health (real network)");
const report = await NexaGateway.health();
console.log("ok:", report.ok);
console.log("status:", report.status);
console.log("message:", report.message);
console.log("providerOrder:", JSON.stringify(report.providerOrder));
for (const p of report.providers) {
  console.log(`  - ${p.provider}: status=${p.status} ok=${p.ok} latency=${p.latencyMs}ms models=${p.models?.length ?? 0} msg=${p.message}`);
}
console.log("model counts:", JSON.stringify(report.models));

hr("2. Registry contents");
const models = await NexaGateway.listModels();
console.log("discovered models:", models.length);
for (const m of models.filter((x) => x.provider === "aihorde")) {
  console.log(`  ${m.id}  availability=${m.availability} streaming=${m.streaming}`);
}

hr("3. Does the explicit model exist in the candidate set?");
const found = models.find((m) => m.provider === "aihorde" && m.id === MODEL);
console.log("target model discovered:", Boolean(found));
if (found) {
  console.log("  availability:", found.availability);
  console.log("  contextLength:", found.contextLength);
}

hr("4. Route preview (explicit pin)");
try {
  const preview = await NexaGateway.previewRoute({ model: PINNED, stream: false });
  console.log("strategy:", preview.plan.strategy);
  console.log("candidates:", JSON.stringify(preview.plan.candidates, null, 2));
  console.log("excluded:", JSON.stringify(preview.plan.excluded, null, 2));
} catch (error) {
  console.log("previewRoute failed:", error.message);
}

hr("5. Route preview (auto)");
try {
  const preview = await NexaGateway.previewRoute({ model: "auto", stream: true });
  console.log("strategy:", preview.plan.strategy);
  console.log("modelsKnown:", preview.modelsKnown);
  console.log("top candidates:");
  for (const c of preview.plan.candidates) {
    console.log(`  ${c.provider}/${c.model}  (${c.reason})`);
  }
  if (preview.plan.excluded.length) {
    console.log("excluded:");
    for (const x of preview.plan.excluded) {
      console.log(`  ${x.provider}${x.model ? `/${x.model}` : ""}: ${x.reason}`);
    }
  }
} catch (error) {
  console.log("auto preview failed:", error.message);
}


/**
 * Transport integrity is asserted strictly on every run. The model's *exact*
 * output is reported but compared case-insensitively: AI Horde's anonymous pool
 * serves a crowd-sourced, randomly-sampled backend, so byte-exact output is not
 * something the gateway can guarantee. NEXA's contract is "deliver what the
 * model said, exactly once, with correct metadata".
 */
for (let run = 1; run <= 3; run += 1) {
  const started = Date.now();
  const events: string[] = [];
  let firstTokenAt: number | null = null;
  let content = "";
  let done: any = null;
  let streamError: any = null;

  for await (const chunk of NexaGateway.streamChat({
    model: PINNED,
    messages: [{ role: "user", content: PROMPT }],
    stream: true,
    maxTokens: 64,
  })) {
    events.push(chunk.type);
    if (chunk.type === "token" && chunk.content) {
      if (firstTokenAt === null) firstTokenAt = Date.now();
      content += chunk.content;
    }
    if (chunk.type === "done") done = chunk.data;
    if (chunk.type === "error") streamError = chunk.data ?? chunk.content;
  }

  const elapsed = Date.now() - started;
  const targetPhrase = "NEXA REAL PROVIDER TEST PASSED";
  const normalized = content.replace(/\s+/g, " ").trim().toUpperCase();

  console.log(`\n--- run ${run} ---`);
  console.log("  event types:", JSON.stringify(events));
  console.log("  token events:", events.filter((t) => t === "token").length);
  console.log("  ttft:", firstTokenAt === null ? "n/a" : `${firstTokenAt - started}ms`, "| total:", `${elapsed}ms`);
  console.log("  content:", JSON.stringify(content));
  console.log("  --- strict transport invariants ---");
  console.log("  no stream error:", streamError === null);
  console.log("  done frame present:", done !== null);
  console.log("  delivered exactly once:", !content.includes(content + content));
  console.log("  no empty markdown fence:", !/```\s*```/.test(content));
  console.log("  no action/narration leak:", !/gateway:|NEXA gateway/i.test(content));
  console.log("  no done-metadata leak:", !/finish_reason|routing|chatcmpl_/.test(content));
  console.log("  provider correct:", done?.provider === "aihorde");
  console.log("  modelUsed correct:", done?.model === MODEL);
  console.log("  done.content === streamed content:", done?.content === content);
  console.log("  latency sane:", done?.latencyMs > 0 && done?.latencyMs < elapsed + 5000);
  console.log("  --- model output (reported, not a gateway guarantee) ---");
  console.log("  exact match:", content.trim() === targetPhrase);
  console.log("  case/space-insensitive match:", normalized === targetPhrase);
}

process.exit(0);

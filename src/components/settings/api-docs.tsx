"use client";

/**
 * "Using the NEXA API" reference.
 *
 * Every example uses obvious placeholders. There is deliberately no real key,
 * no real host, and no account-specific value anywhere in this file — it ships
 * to the browser.
 *
 * The model reference format shown here (`provider/model`) is the one the
 * router actually parses: `GatewayModelRegistry.parseModelRef` consumes the
 * leading segment only when it matches a known provider id, so a model id that
 * itself contains slashes stays intact.
 */
import { useState } from "react";
import { Check, Copy, Terminal } from "lucide-react";

interface Endpoint {
  method: string;
  path: string;
  purpose: string;
}

const ENDPOINTS: Endpoint[] = [
  {
    method: "POST",
    path: "/v1/chat/completions",
    purpose: "Chat completions. Set \"stream\": true for incremental SSE output.",
  },
  {
    method: "GET",
    path: "/v1/models",
    purpose: "Models the gateway can currently route to, as an OpenAI model list.",
  },
  {
    method: "GET",
    path: "/v1/health",
    purpose: "Whether this instance can serve a request, and which providers are up.",
  },
];

const CURL_CHAT = `curl https://YOUR-NEXA-DOMAIN/v1/chat/completions \\
  -H "Authorization: Bearer YOUR_NEXA_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "aihorde/koboldcpp/Angelic_Eclipse-12B",
    "messages": [
      {
        "role": "user",
        "content": "Hello from NEXA"
      }
    ],
    "stream": true
  }'`;

const CURL_MODELS = `curl https://YOUR-NEXA-DOMAIN/v1/models \\
  -H "Authorization: Bearer YOUR_NEXA_API_KEY"`;

export function ApiDocsSection() {
  const [copied, setCopied] = useState<string | null>(null);

  const copy = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(id);
      setTimeout(() => setCopied((c) => (c === id ? null : c)), 2000);
    } catch {
      setCopied(null);
    }
  };

  return (
    <section
      className="rounded-panel border px-4 py-4"
      style={{ borderColor: "var(--nexa-border)" }}
      aria-labelledby="api-docs-heading"
    >
      <div className="flex items-center gap-2">
        <Terminal className="size-4 nexa-muted" aria-hidden />
        <h2 id="api-docs-heading" className="text-sm font-semibold nexa-text">
          Using the NEXA API
        </h2>
      </div>

      <p className="mt-1.5 text-xs leading-relaxed nexa-muted">
        NEXA exposes an OpenAI-compatible surface, so an existing OpenAI client
        only needs a different base URL and key. Authentication is{" "}
        <code className="font-mono">Authorization: Bearer …</code> and nothing
        else — a browser session is never accepted on{" "}
        <code className="font-mono">/v1</code>.
      </p>

      <dl className="mt-3 flex flex-col gap-1.5 text-xs">
        {ENDPOINTS.map((endpoint) => (
          <div key={endpoint.path} className="flex flex-wrap items-baseline gap-x-2">
            <dt className="font-mono text-[11px] nexa-accent-text">
              {endpoint.method} {endpoint.path}
            </dt>
            <dd className="text-[11px] nexa-muted">{endpoint.purpose}</dd>
          </div>
        ))}
      </dl>

      <CodeBlock
        id="chat"
        title="Chat completions"
        code={CURL_CHAT}
        copied={copied === "chat"}
        onCopy={() => void copy("chat", CURL_CHAT)}
      />

      <CodeBlock
        id="models"
        title="List models"
        code={CURL_MODELS}
        copied={copied === "models"}
        onCopy={() => void copy("models", CURL_MODELS)}
      />

      <p className="mt-3 text-[11px] leading-relaxed nexa-muted">
        Reference a model as{" "}
        <code className="font-mono">provider/model</code> to pin it to one
        provider, or use <code className="font-mono">auto</code> to let NEXA
        choose. A pinned model is never routed through a different provider.
      </p>
    </section>
  );
}

function CodeBlock({
  id,
  title,
  code,
  copied,
  onCopy,
}: {
  id: string;
  title: string;
  code: string;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div className="mt-3">
      <div className="flex items-center justify-between gap-2">
        <span id={`${id}-label`} className="text-[11px] nexa-muted">
          {title}
        </span>
        <button
          type="button"
          onClick={onCopy}
          aria-label={`Copy the ${title.toLowerCase()} example`}
          className="inline-flex items-center gap-1 rounded-control px-1.5 py-0.5 text-[11px] nexa-muted transition-colors hover:text-ink-100"
        >
          {copied ? (
            <Check className="size-3" aria-hidden />
          ) : (
            <Copy className="size-3" aria-hidden />
          )}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre
        aria-labelledby={`${id}-label`}
        className="nexa-raised mt-1 overflow-x-auto rounded-control border p-2.5 font-mono text-[11px] leading-relaxed nexa-text"
        style={{ borderColor: "var(--nexa-border)" }}
      >
        <code>{code}</code>
      </pre>
    </div>
  );
}

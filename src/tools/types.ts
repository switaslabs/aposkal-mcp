import type { Risk } from "../risk.js";

export type JsonSchema = Record<string, unknown>;

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema & { type: "object" };
  risk: Risk;
  /** Alttaki çağrının HTTP metodu (hassas GET'lerin ayrımı için). */
  method: string;
  handler: (args: Record<string, unknown>) => Promise<string>;
  /** MCP açıklama ipuçlarını geçersiz kılar (ör. genel çağrı aracı asla salt-okuma değildir). */
  hints?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean };
}

export function annotations(t: ToolDef) {
  return {
    title: t.title,
    readOnlyHint: t.risk === "read",
    destructiveHint: t.risk === "destructive" || t.risk === "external" || t.risk === "sensitive",
    idempotentHint: t.method === "GET" || t.method === "PUT",
    openWorldHint: true,
    ...t.hints,
  };
}

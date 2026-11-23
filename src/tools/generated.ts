/**
 * Paketle gelen OpenAPI tanımından üretilen, her Aposkal API operasyonu için bir MCP aracı.
 * aposkal-mcp · Switas Consultancy (https://switas.com)
 */
import type { Config } from "../config.js";
import { execute, type ExecContext } from "../executor.js";
import { decide } from "../policy.js";
import { RISK_DESCRIPTIONS, RISK_LABELS } from "../risk.js";
import type { Operation, Spec } from "../spec.js";
import type { JsonSchema, ToolDef } from "./types.js";

/** Gövde şemalarını yalnızca küçük kaldıkça satır içine al; aksi halde describe_endpoint'e yönlendir. */
const MAX_INLINE_BODY_SCHEMA = 6_000;

export function inputSchemaFor(op: Operation, spec: Spec, cfg: Pick<Config, "defaultCompanyId" | "mode" | "allowExternal" | "allowSensitive">): JsonSchema & { type: "object" } {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];

  if (op.hasCompanyId) {
    properties.companyId = {
      type: "integer",
      description: "Aposkal firma ID'si (bkz. aposkal_list_companies)." + (cfg.defaultCompanyId ? ` Varsayılan: ${cfg.defaultCompanyId}.` : ""),
    };
    if (!cfg.defaultCompanyId) required.push("companyId");
  }
  for (const p of op.params) {
    const s: JsonSchema = { ...p.schema };
    if (p.description && !s.description) s.description = p.description;
    properties[p.name] = s;
    if (p.required) required.push(p.name);
  }
  if (op.body) {
    if (op.body.contentType === "json") {
      const inlined = spec.deref(op.body.rawSchema, 2);
      const fits = JSON.stringify(inlined).length <= MAX_INLINE_BODY_SCHEMA;
      properties.body = fits
        ? { ...inlined, description: `İstek gövdesi${op.body.schemaRef ? ` (${op.body.schemaRef})` : ""}.` }
        : {
            type: ["object", "array"],
            description: `İstek gövdesi (${op.body.schemaRef ?? "JSON"}). Tam şema için aposkal_describe_endpoint aracını "${op.operationId}" ile çağırın.`,
          };
    } else {
      properties.body = {
        type: "object",
        description:
          `multipart/form-data alanları.${op.body.fileFields.length ? ` Dosya alanları (${op.body.fileFields.join(", ")}) APOSKAL_UPLOAD_DIR içindeki bir dosya yolu alır.` : ""}`,
      };
    }
    if (op.body.required && op.body.contentType === "json") required.push("body");
  }
  if (decide(op.risk, op.method, cfg).requiresConfirm) {
    properties.confirm = {
      type: "boolean",
      description: "true olmalıdır. Yalnızca kullanıcı tam olarak bu işlemi açıkça onayladıktan sonra gönderin.",
    };
    required.push("confirm");
  }
  return { type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false };
}

export function describeOp(op: Operation): string {
  const parts = [
    `${op.summary}.`,
    `[${op.method} ${op.path} · ${op.tag} · risk: ${RISK_LABELS[op.risk]}]`,
    op.risk !== "read" ? RISK_DESCRIPTIONS[op.risk] : "",
    op.bearerOnly ? "Not: Tanımda yalnızca bearer kimlik doğrulaması belirtiliyor; API anahtarıyla da çalıştığı görüldü." : "",
    op.deprecated ? "Kullanımdan kaldırılıyor." : "",
    op.description ? op.description.slice(0, 600) : "",
  ];
  return parts.filter(Boolean).join(" ");
}

export function generatedTool(op: Operation, spec: Spec, ctx: ExecContext): ToolDef {
  return {
    name: op.toolName,
    title: op.summary,
    description: describeOp(op),
    inputSchema: inputSchemaFor(op, spec, ctx.cfg),
    risk: op.risk,
    method: op.method,
    handler: (args) => execute(op, args, ctx),
  };
}

/** APOSKAL_TOOLSETS değerine göre hangi operasyonların kendi aracını alacağını belirler. */
export function selectOperations(spec: Spec, toolsets: string[]): Operation[] {
  if (toolsets.length === 0) return [];
  if (toolsets.includes("all")) return spec.operations;
  const wanted = new Set(toolsets);
  return spec.operations.filter((o) => wanted.has(o.toolset));
}

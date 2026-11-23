/**
 * Paketle gelen Aposkal OpenAPI tanımını yükler, Türkçe metinleri uygular ve
 * operasyon kataloğuna dönüştürür.
 * aposkal-mcp · Switas Consultancy (https://switas.com)
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { classify, type Risk } from "./risk.js";

type JsonSchema = Record<string, unknown>;

interface OpenApiDoc {
  info: { title: string; version: string; description?: string };
  paths: Record<string, Record<string, OpenApiOperation>>;
  components: { schemas: Record<string, JsonSchema> };
}
interface OpenApiParam {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  required?: boolean;
  description?: string;
  schema?: JsonSchema;
}
interface OpenApiOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: OpenApiParam[];
  requestBody?: { required?: boolean; content?: Record<string, { schema?: JsonSchema }> };
  responses?: Record<string, { description?: string; content?: Record<string, unknown> }>;
  security?: Array<Record<string, unknown>>;
  deprecated?: boolean;
}

/** i18n/aposkal-tr.json biçimi. */
export interface TurkishTexts {
  tags?: Record<string, string>;
  operations: Record<string, { summary: string; description?: string; params?: Record<string, string> }>;
  schemaProperties?: Record<string, string>;
}

export interface ParamDef {
  /** Modele gösterilen ad (operasyon içinde tekil). */
  name: string;
  /** API'ye gönderilen ad. */
  apiName: string;
  in: "path" | "query";
  required: boolean;
  description?: string;
  schema: JsonSchema;
}

export interface Operation {
  operationId: string;
  toolName: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  /** Türkçe grup adı. */
  tag: string;
  /** Grup kısaltması (değişmez tanımlayıcı, ör. "document"). */
  toolset: string;
  summary: string;
  description: string;
  /** Arama için ek metin (orijinal İngilizce özet dahil; kullanıcıya gösterilmez). */
  searchText: string;
  risk: Risk;
  deprecated: boolean;
  /** Tanım yalnızca bearer kimlik doğrulaması belirtiyor (API anahtarıyla da çalıştığı görüldü). */
  bearerOnly: boolean;
  hasCompanyId: boolean;
  params: ParamDef[];
  body?: {
    contentType: "json" | "multipart";
    required: boolean;
    schemaRef?: string;
    rawSchema: JsonSchema;
    /** format=binary olan multipart alanları (dosya yükleme). */
    fileFields: string[];
  };
  redirectsToFile: boolean;
}

const METHODS = ["get", "post", "put", "patch", "delete"] as const;

function dedent(text: string): string {
  const lines = text.replace(/\r/g, "").split("\n");
  const indents = lines.filter((l) => l.trim()).map((l) => /^\s*/.exec(l)![0].length);
  const min = indents.length ? Math.min(...indents) : 0;
  return lines.map((l) => l.slice(min)).join("\n").trim();
}

export function slugify(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function toToolName(operationId: string): string {
  const snake = operationId
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  return `aposkal_${snake}`.slice(0, 64);
}

export class Spec {
  readonly doc: OpenApiDoc;
  readonly operations: Operation[];
  private readonly byKey = new Map<string, Operation>();

  /** Orijinal (İngilizce) özetler; yalnızca aramada eşleşme için tutulur. */
  private readonly originalSummaries = new Map<string, string>();
  private readonly tagNames: Record<string, string> = {};

  constructor(doc: OpenApiDoc, tr?: TurkishTexts) {
    this.doc = doc;
    if (tr) this.applyTurkish(tr);
    this.operations = this.buildOperations();
    // Farklı operationId'ler aynı araç adına dönüşebilir ("transferBulkProduct" ve
    // "transfer-bulk-product" gibi): araç adlarını belirlenimci biçimde tekilleştir.
    const taken = new Set<string>();
    for (const op of this.operations) {
      let name = op.toolName;
      for (let i = 2; taken.has(name); i++) name = `${op.toolName.slice(0, 60)}_${i}`;
      op.toolName = name;
      taken.add(name);
    }
    for (const op of this.operations) {
      this.byKey.set(op.operationId.toLowerCase(), op);
      this.byKey.set(op.toolName, op);
      this.byKey.set(`${op.method} ${op.path}`.toLowerCase(), op);
    }
  }

  static loadBundled(): Spec {
    const here = dirname(fileURLToPath(import.meta.url));
    // hem src/ (testler) hem dist/ (çalışma zamanı) altından çalışır
    const root = join(here, "..");
    const doc = JSON.parse(readFileSync(join(root, "openapi", "aposkal-openapi.json"), "utf8")) as OpenApiDoc;
    const tr = JSON.parse(readFileSync(join(root, "i18n", "aposkal-tr.json"), "utf8")) as TurkishTexts;
    return new Spec(doc, tr);
  }

  /**
   * Türkçe özet ve açıklamaları bellekteki tanıma uygular. Türkçesi olan her
   * İngilizce metin kaldırılır; dosyadaki orijinal tanım değişmez.
   */
  private applyTurkish(tr: TurkishTexts): void {
    Object.assign(this.tagNames, tr.tags ?? {});
    for (const item of Object.values(this.doc.paths)) {
      for (const m of METHODS) {
        const o = item[m];
        if (!o?.operationId) continue;
        const t = tr.operations[o.operationId];
        if (!t) continue;
        if (o.summary) this.originalSummaries.set(o.operationId, o.summary);
        o.summary = t.summary;
        if (t.description) o.description = t.description;
        if (t.params) {
          for (const p of o.parameters ?? []) {
            const d = t.params[p.name];
            if (d) p.description = d;
          }
        }
      }
    }
    for (const [key, text] of Object.entries(tr.schemaProperties ?? {})) {
      const [schemaName, prop] = key.split(".");
      const props = this.doc.components.schemas[schemaName ?? ""]?.properties as Record<string, JsonSchema> | undefined;
      if (prop && props?.[prop]) props[prop] = { ...props[prop], description: text };
    }
  }

  /** operationId, araç adı ya da "METHOD /yol" ile arar. */
  find(key: string): Operation | undefined {
    const k = key.trim();
    return this.byKey.get(k.toLowerCase()) ?? this.byKey.get(k.replace(/\s+/, " ").toLowerCase());
  }

  /** Yerel bir $ref'i çözümler. */
  ref(ref: string): JsonSchema | undefined {
    const m = /^#\/components\/schemas\/(.+)$/.exec(ref);
    return m ? this.doc.components.schemas[m[1]!] : undefined;
  }

  /**
   * $ref'leri `depth` seviyesine kadar açar. Daha derindekiler kısa bir yer
   * tutucuya dönüşür; böylece şemalar küçük kalır ve özyinelemeli tipler sonlanır.
   */
  deref(schema: unknown, depth = 3, seen: string[] = []): JsonSchema {
    if (!schema || typeof schema !== "object") return schema as JsonSchema;
    if (Array.isArray(schema)) return schema.map((s) => this.deref(s, depth, seen)) as unknown as JsonSchema;
    const s = schema as JsonSchema;
    if (typeof s.$ref === "string") {
      const name = s.$ref.split("/").pop()!;
      const target = this.ref(s.$ref);
      if (!target || depth <= 0 || seen.includes(name)) {
        return { type: "object", description: `${name} (tam şema için aposkal_describe_endpoint aracını kullanın)` };
      }
      return this.deref(target, depth - 1, [...seen, name]);
    }
    const out: JsonSchema = {};
    for (const [k, v] of Object.entries(s)) {
      if (k === "xml" || k === "example" || k === "examples") continue;
      out[k] = v && typeof v === "object" ? this.deref(v, depth, seen) : v;
    }
    return out;
  }

  private buildOperations(): Operation[] {
    const ops: Operation[] = [];
    for (const [path, item] of Object.entries(this.doc.paths)) {
      for (const m of METHODS) {
        const o = item[m];
        if (!o) continue;
        const operationId = o.operationId ?? `${m}_${path}`;
        const rawTag = o.tags?.[0] ?? "Diğer";
        const tag = this.tagNames[rawTag] ?? rawTag;
        const method = m.toUpperCase() as Operation["method"];
        const params = this.buildParams(o.parameters ?? []);
        const body = this.buildBody(o);
        ops.push({
          operationId,
          toolName: toToolName(operationId),
          method,
          path,
          tag,
          toolset: slugify(rawTag),
          summary: o.summary ?? operationId,
          description: dedent(o.description ?? ""),
          searchText: `${operationId} ${rawTag} ${this.originalSummaries.get(operationId) ?? ""}`,
          risk: classify(method, operationId),
          deprecated: Boolean(o.deprecated),
          bearerOnly: Boolean(o.security?.some((s) => "bearerAuth" in s) && !o.security?.some((s) => "apiKeyAuth" in s)),
          hasCompanyId: path.includes("{companyId}"),
          params,
          body,
          redirectsToFile: Boolean(o.responses?.["302"]) || /\/download$/.test(path),
        });
      }
    }
    return ops;
  }

  /** Yol ve sorgu parametreleri; nesne tipindeki sorgu parametreleri (Spring `pageable`, `request`) düzleştirilir. */
  private buildParams(raw: OpenApiParam[]): ParamDef[] {
    const out: ParamDef[] = [];
    // her araçta kullanılan ayrılmış argüman adları
    const used = new Set<string>(["companyId", "confirm", "body"]);
    const add = (p: ParamDef) => {
      let name = p.name;
      for (let i = 2; used.has(name); i++) name = `${p.name}_${i}`;
      used.add(name);
      out.push({ ...p, name });
    };
    for (const p of raw) {
      if (p.in !== "path" && p.in !== "query") continue;
      if (p.name === "companyId" && p.in === "path") continue; // genel olarak ele alınır
      const schema = (p.schema ?? { type: "string" }) as JsonSchema;
      const resolved = typeof schema.$ref === "string" ? this.ref(schema.$ref) : schema;
      if (p.in === "query" && resolved && resolved.type === "object" && resolved.properties) {
        for (const [prop, ps] of Object.entries(resolved.properties as Record<string, JsonSchema>)) {
          add({
            name: prop,
            apiName: prop,
            in: "query",
            required: false,
            description: (ps.description as string | undefined) ?? undefined,
            schema: this.deref(ps, 1),
          });
        }
        continue;
      }
      add({
        name: p.name,
        apiName: p.name,
        in: p.in,
        required: p.in === "path" ? true : Boolean(p.required),
        description: p.description,
        schema: this.deref(schema, 1),
      });
    }
    return out;
  }

  private buildBody(o: OpenApiOperation): Operation["body"] {
    const content = o.requestBody?.content;
    if (!content) return undefined;
    const json = content["application/json"] ?? content["application/vnd.api+json"];
    if (json) {
      const schema = (json.schema ?? { type: "object" }) as JsonSchema;
      return {
        contentType: "json",
        required: Boolean(o.requestBody?.required),
        schemaRef: typeof schema.$ref === "string" ? schema.$ref.split("/").pop() : undefined,
        rawSchema: schema,
        fileFields: [],
      };
    }
    const mp = content["multipart/form-data"];
    if (mp) {
      const schema = (mp.schema ?? { type: "object" }) as JsonSchema;
      const resolved = (typeof schema.$ref === "string" ? this.ref(schema.$ref) : schema) ?? {};
      const props = (resolved.properties ?? {}) as Record<string, JsonSchema>;
      const fileFields = Object.entries(props)
        .filter(([, v]) => v.format === "binary" || (v.type === "array" && (v.items as JsonSchema | undefined)?.format === "binary"))
        .map(([k]) => k);
      return {
        contentType: "multipart",
        required: Boolean(o.requestBody?.required),
        schemaRef: typeof schema.$ref === "string" ? schema.$ref.split("/").pop() : undefined,
        rawSchema: schema,
        fileFields,
      };
    }
    return undefined;
  }
}

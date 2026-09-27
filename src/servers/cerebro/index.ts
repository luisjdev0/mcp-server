import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { LocalMcpEntry } from "../../registry/types.js";
import { logger } from "../../logger.js";

/**
 * Integra el ecosistema cerebro (https://github.com/luisjdev0/cerebro, privado) --
 * memoria persistente self-hosted (`cerebro-memory`, Postgres+pgvector detrás de una
 * API FastAPI) y, desde que ese repo pasó a ser un monorepo de 7 paquetes, también un
 * repositorio de documentos Markdown (`cerebro-docs`), un motor de procesos/checklists
 * (`cerebro-flows`) y gestión de identidades/tokens (`cerebro-auth`) -- las 4 son APIs
 * FastAPI hermanas, misma arquitectura. El monorepo trae su propio cliente MCP
 * (`cerebro-mcp`), pero es stdio-only y no debe modificarse desde aquí, así que esta
 * carpeta es una reimplementación delgada de los mismos tools (mismo contrato, mismos
 * endpoints) hablando HTTP directo con las APIs ya desplegadas -- no hay lógica de
 * negocio propia, igual que el original (`cerebro-mcp/server.py` es en sí mismo un
 * adaptador delgado sobre `cerebro_clients`).
 *
 * Prefijos `memory_*` / `docs_*` / `flow_*` / `auth_*`, igual que upstream: las
 * `memory_*` son un port 1:1 de las 10 tools originales de `cerebro-memory` (mismos
 * nombres/schemas), y `docs_*`/`flow_*`/`auth_*` son las tools de los 3 servicios
 * añadidos después. Cada uno de esos 3 es un servicio separado (propia URL, propio
 * contrato) que puede no estar desplegado todavía -- si su variable `CEREBRO_*_URL` no
 * está definida, ese grupo de tools simplemente no se registra y el resto del MCP
 * sigue funcionando igual (mismo patrón que ya existía para `docs_*` antes de esto).
 */
const MEMORY_TYPES = ["semantic", "episodic", "procedural", "decision"] as const;
const RELATIONS = ["relates_to", "caused_by", "part_of", "contradicts", "follows"] as const;
const SECTION_OPERATIONS = ["replace", "append", "insert_after", "insert_before", "delete"] as const;

interface MemoryConfig {
  baseUrl: string;
  token: string;
  agentName: string;
}

interface DocsConfig {
  baseUrl: string;
  token: string;
  agentName: string;
}

interface FlowsConfig {
  baseUrl: string;
  token: string;
  agentName: string;
}

interface AuthConfig {
  baseUrl: string;
  token: string;
  agentName: string;
}

// Precedencia igual a `cerebro_clients.config` (SS4/SS13 del ecosistema): las
// variables CEREBRO_* son las nuevas, KNOWLEDGEOS_* es el fallback de compatibilidad
// que ya estaba desplegado antes del monorepo -- solo aplica a memory, cerebro-docs
// es un servicio nuevo sin variables legadas que preservar.
function loadMemoryConfig(): MemoryConfig | null {
  const baseUrl = process.env.CEREBRO_MEMORY_URL || process.env.KNOWLEDGEOS_API_URL;
  const token = process.env.CEREBRO_TOKEN || process.env.KNOWLEDGEOS_API_TOKEN;
  const agentName = process.env.CEREBRO_AGENT_NAME || process.env.KNOWLEDGEOS_AGENT_NAME || "mcp-gateway";

  if (!baseUrl || !z.string().url().safeParse(baseUrl).success) {
    logger.warn(
      'MCP "cerebro" deshabilitado: define CEREBRO_MEMORY_URL (o KNOWLEDGEOS_API_URL) y ' +
        "CEREBRO_TOKEN (o KNOWLEDGEOS_API_TOKEN) para activarlo.",
    );
    return null;
  }
  if (!token) {
    logger.warn(
      'MCP "cerebro" deshabilitado: define CEREBRO_TOKEN (o KNOWLEDGEOS_API_TOKEN) para activarlo.',
    );
    return null;
  }
  return { baseUrl, token, agentName };
}

function loadDocsConfig(agentName: string): DocsConfig | null {
  const baseUrl = process.env.CEREBRO_DOCS_URL;
  const token = process.env.CEREBRO_TOKEN;

  if (!baseUrl || !z.string().url().safeParse(baseUrl).success) {
    logger.info('Tools "docs_*" de cerebro deshabilitadas: define CEREBRO_DOCS_URL para activarlas.');
    return null;
  }
  if (!token) {
    logger.warn(
      'Tools "docs_*" de cerebro deshabilitadas: CEREBRO_DOCS_URL está definido pero falta CEREBRO_TOKEN.',
    );
    return null;
  }
  return { baseUrl, token, agentName };
}

function loadFlowsConfig(agentName: string): FlowsConfig | null {
  const baseUrl = process.env.CEREBRO_FLOWS_URL;
  const token = process.env.CEREBRO_TOKEN;

  if (!baseUrl || !z.string().url().safeParse(baseUrl).success) {
    logger.info('Tools "flow_*" de cerebro deshabilitadas: define CEREBRO_FLOWS_URL para activarlas.');
    return null;
  }
  if (!token) {
    logger.warn(
      'Tools "flow_*" de cerebro deshabilitadas: CEREBRO_FLOWS_URL está definido pero falta CEREBRO_TOKEN.',
    );
    return null;
  }
  return { baseUrl, token, agentName };
}

function loadAuthConfig(agentName: string): AuthConfig | null {
  const baseUrl = process.env.CEREBRO_AUTH_URL;
  const token = process.env.CEREBRO_TOKEN;

  if (!baseUrl || !z.string().url().safeParse(baseUrl).success) {
    logger.info('Tools "auth_*" de cerebro deshabilitadas: define CEREBRO_AUTH_URL para activarlas.');
    return null;
  }
  if (!token) {
    logger.warn(
      'Tools "auth_*" de cerebro deshabilitadas: CEREBRO_AUTH_URL está definido pero falta CEREBRO_TOKEN.',
    );
    return null;
  }
  return { baseUrl, token, agentName };
}

function textResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

// fetch()'s Response.json() types as Promise<unknown> under this project's lib config;
// every caller here already handles arbitrary JSON shapes from the cerebro APIs.
function readJson(res: Response): Promise<any> {
  return res.json();
}

function connectionErrorMessage(service: string, apiUrl: string, exc: unknown): string {
  return `No se pudo conectar con la API de ${service} en ${apiUrl}: ${String(exc)}.`;
}

function authErrorMessage(service: string, tokenVar: string): string {
  return `La API de ${service} rechazó la autenticación (401). Verifica ${tokenVar}.`;
}

async function httpErrorMessage(service: string, res: Response): Promise<string> {
  let detail: unknown;
  try {
    detail = (await readJson(res))?.detail ?? (await res.text());
  } catch {
    detail = res.statusText;
  }
  return `La API de ${service} devolvió ${res.status}: ${JSON.stringify(detail)}`;
}

export function createCerebroServer(
  memory: MemoryConfig,
  docs: DocsConfig | null,
  flows: FlowsConfig | null,
  auth: AuthConfig | null,
): McpServer {
  const server = new McpServer({ name: "cerebro", version: "2.0.0" });

  // Estado de proceso por sesión MCP (una instancia de McpServer por sesión, ver
  // registry/types.ts): último `disambiguation_id` sin resolver, igual al
  // "process-memory slot" del server.py original -- ver docstring de memory_search
  // más abajo para el comportamiento de auto-resolve que habilita.
  let lastDisambiguationId: string | null = null;

  async function memoryFetch(path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`${memory.baseUrl}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${memory.token}`,
        "X-Agent-Name": memory.agentName,
        ...init.headers,
      },
    });
  }

  async function docsFetch(path: string, init: RequestInit = {}): Promise<Response> {
    if (!docs) throw new Error('Tools "docs_*" deshabilitadas: define CEREBRO_DOCS_URL y CEREBRO_TOKEN.');
    return fetch(`${docs.baseUrl}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${docs.token}`,
        "X-Agent-Name": docs.agentName,
        ...init.headers,
      },
    });
  }

  async function flowsFetch(path: string, init: RequestInit = {}): Promise<Response> {
    if (!flows) throw new Error('Tools "flow_*" deshabilitadas: define CEREBRO_FLOWS_URL y CEREBRO_TOKEN.');
    return fetch(`${flows.baseUrl}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${flows.token}`,
        "X-Agent-Name": flows.agentName,
        ...init.headers,
      },
    });
  }

  async function authFetch(path: string, init: RequestInit = {}): Promise<Response> {
    if (!auth) throw new Error('Tools "auth_*" deshabilitadas: define CEREBRO_AUTH_URL y CEREBRO_TOKEN.');
    return fetch(`${auth.baseUrl}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${auth.token}`,
        "X-Agent-Name": auth.agentName,
        ...init.headers,
      },
    });
  }

  async function getContexts(): Promise<any[]> {
    const res = await memoryFetch("/contexts");
    if (!res.ok) throw new Error(await httpErrorMessage("cerebro-memory", res));
    return readJson(res);
  }

  async function getCategories(): Promise<any[]> {
    const res = await docsFetch("/categories");
    if (!res.ok) throw new Error(await httpErrorMessage("cerebro-docs", res));
    return readJson(res);
  }

  async function getFlowCategories(): Promise<any[]> {
    const res = await flowsFetch("/categories");
    if (!res.ok) throw new Error(await httpErrorMessage("cerebro-flows", res));
    return readJson(res);
  }

  function formatContextList(contexts: any[]): string {
    if (contexts.length === 0) {
      return "(no hay contextos creados todavía; usa memory_create_context para crear el primero)";
    }
    return contexts
      .map((c) => `- ${c.slug} (${c.kind}): ${c.description || "sin descripción"}`)
      .join("\n");
  }

  function formatCategoryList(categories: any[]): string {
    if (categories.length === 0) {
      return "(no hay categorías creadas todavía; usa docs_create_category para crear la primera)";
    }
    return categories.map((c) => `- ${c.slug}: ${c.description || c.name}`).join("\n");
  }

  function formatAmbiguousMessage(scopeDecision: any): string {
    const candidates = scopeDecision.candidates ?? [];
    const resultsByCandidate = scopeDecision.results_by_candidate ?? {};
    const lines = ["La consulta es ambigua entre estos contextos:"];
    for (const c of candidates) {
      const pct = `${Math.round((c.score ?? 0) * 100)}%`;
      const desc = c.description || c.name || c.slug;
      lines.push(`- ${c.slug} (${pct}): ${desc}`);
      for (const r of resultsByCandidate[c.slug] ?? []) {
        lines.push(`    · ${r.title}`);
      }
    }
    lines.push(
      "Elige llamando memory_search con context=<slug>, o pregunta al usuario cuál corresponde.",
    );
    return lines.join("\n");
  }

  // =============================================================================== memory_*

  server.registerTool(
    "memory_search",
    {
      title: "Buscar memorias",
      description:
        "Busca memorias guardadas por contenido (retrieval híbrido: vector + texto completo). " +
        "Úsala antes de responder cualquier pregunta que pueda depender de algo que el usuario " +
        "ya contó antes. Si no pasas `context`, la API decide el scope automáticamente " +
        "(Context Engine): si es ambiguo, `results` viene vacío y en su lugar recibes " +
        "`candidates`/`results_by_candidate`/`message` para decidir o preguntar al usuario, y " +
        "repites la llamada con `context=<slug>`. Esta sesión recuerda la última ambigüedad sin " +
        "resolver: si tu SIGUIENTE llamada pasa `context` explícito, se resuelve automáticamente " +
        "(alimenta el aprendizaje de `context_preferences`). Con `expand=true`, agrega un bloque " +
        "`related` (vecinos a 1 salto de los primeros resultados).",
      inputSchema: {
        query: z.string().describe("La pregunta o texto a buscar, en lenguaje natural"),
        context: z.string().optional().describe("Slug de un contexto para acotar la búsqueda"),
        type: z.enum(MEMORY_TYPES).optional().describe("Filtra por tipo de memoria"),
        limit: z.number().int().positive().default(5).describe("Máximo de resultados"),
        expand: z.boolean().default(false).describe("Si true, incluye el bloque `related`"),
      },
    },
    async ({ query, context, type, limit, expand }) => {
      const params = new URLSearchParams({ q: query, limit: String(limit) });
      if (context) params.set("context", context);
      if (type) params.set("type", type);
      if (expand) params.set("expand", "true");

      let res: Response;
      try {
        res = await memoryFetch(`/memories/search?${params}`);
      } catch (exc) {
        return textResult({ error: connectionErrorMessage("cerebro-memory", memory.baseUrl, exc) });
      }
      if (res.status === 401) return textResult({ error: authErrorMessage("cerebro-memory", "CEREBRO_TOKEN") });
      if (!res.ok) return textResult({ error: await httpErrorMessage("cerebro-memory", res) });

      const data = await readJson(res);
      const results = data.results ?? [];
      const scopeDecision = data.scope_decision ?? {};
      const related = data.related;
      const mode = scopeDecision.mode;

      const pendingId = lastDisambiguationId;
      lastDisambiguationId = null;

      let note: string | null = null;
      if (context && pendingId) {
        try {
          const resolveRes = await memoryFetch(`/disambiguations/${pendingId}/resolve`, {
            method: "POST",
            body: JSON.stringify({ context }),
          });
          if (resolveRes.ok) {
            note = `Aprendido: se registró que esta consulta corresponde a '${context}' -- preguntas similares se inclinarán hacia este contexto en el futuro.`;
          }
        } catch {
          // best-effort: no perdemos el resultado de la búsqueda por esto
        }
      }

      if (mode === "ambiguous") {
        lastDisambiguationId = scopeDecision.disambiguation_id ?? null;
        const out: Record<string, unknown> = {
          results,
          scope_decision: scopeDecision,
          ambiguous: true,
          message: formatAmbiguousMessage(scopeDecision),
          note,
        };
        if (expand) out.related = related;
        return textResult(out);
      }

      const out: Record<string, unknown> = { results, scope_decision: scopeDecision, ambiguous: false, note };
      if (expand) out.related = related;
      return textResult(out);
    },
  );

  server.registerTool(
    "memory_remember",
    {
      title: "Guardar memoria",
      description:
        "Guarda una memoria nueva de forma persistente (sobrevive entre sesiones). `context` y " +
        "`type` son obligatorios -- si no sabes qué contexto usar, llama primero a " +
        "memory_contexts(). Nunca pases secretos reales en `content`: la API los rechaza y pide " +
        "una referencia `secret://entorno/nombre`.",
      inputSchema: {
        content: z.string().describe("Texto de la memoria, 1-3 frases"),
        context: z.string().describe("Slug de un contexto existente (obligatorio)"),
        type: z.enum(MEMORY_TYPES).describe("Tipo de memoria (obligatorio)"),
        title: z.string().optional().describe("Título corto opcional"),
        importance: z.number().min(0).max(1).optional().describe("0.0-1.0, default 0.5"),
      },
    },
    async ({ content, context, type, title, importance }) => {
      const body: Record<string, unknown> = { content, context, type };
      if (title) body.title = title;
      if (importance !== undefined) body.importance = importance;

      let res: Response;
      try {
        res = await memoryFetch("/memories", { method: "POST", body: JSON.stringify(body) });
      } catch (exc) {
        return textResult({ error: connectionErrorMessage("cerebro-memory", memory.baseUrl, exc) });
      }
      if (res.status === 401) return textResult({ error: authErrorMessage("cerebro-memory", "CEREBRO_TOKEN") });
      if (res.status === 422) {
        const body422 = await readJson(res).catch(() => ({}));
        const detail = body422.detail ?? "";
        if (String(detail).includes("unknown context")) {
          const contexts = await getContexts().catch(() => []);
          return textResult({
            error:
              `El contexto '${context}' no existe. Contextos disponibles:\n` +
              `${formatContextList(contexts)}\n\n` +
              `Elige uno de estos, o créalo primero con memory_create_context(slug='${context}', ...).`,
          });
        }
        return textResult({ error: `cerebro-memory rechazó la memoria (422): ${JSON.stringify(detail)}` });
      }
      if (!res.ok) return textResult({ error: await httpErrorMessage("cerebro-memory", res) });

      return textResult({ memory: await readJson(res) });
    },
  );

  server.registerTool(
    "memory_update",
    {
      title: "Actualizar memoria",
      description:
        "Actualiza el contenido de una memoria existente. cerebro-memory nunca edita in-place: crea " +
        "una versión nueva y marca la anterior como 'superseded', preservando el historial.",
      inputSchema: {
        memory_id: z.string().describe("UUID de la memoria activa a reemplazar"),
        content: z.string().describe("El contenido nuevo y correcto"),
      },
    },
    async ({ memory_id, content }) => {
      let res: Response;
      try {
        res = await memoryFetch(`/memories/${memory_id}`, { method: "PATCH", body: JSON.stringify({ content }) });
      } catch (exc) {
        return textResult({ error: connectionErrorMessage("cerebro-memory", memory.baseUrl, exc) });
      }
      if (res.status === 401) return textResult({ error: authErrorMessage("cerebro-memory", "CEREBRO_TOKEN") });
      if (res.status === 404) return textResult({ error: `No existe ninguna memoria con id '${memory_id}'.` });
      if (res.status === 409) {
        const detail = (await readJson(res).catch(() => ({}))).detail ?? "";
        return textResult({ error: `No se pudo actualizar: ${detail}` });
      }
      if (!res.ok) return textResult({ error: await httpErrorMessage("cerebro-memory", res) });

      return textResult({ memory: await readJson(res) });
    },
  );

  server.registerTool(
    "memory_forget",
    {
      title: "Olvidar memoria",
      description:
        "Elimina una memoria: por defecto la archiva (recuperable), opcionalmente la borra en " +
        "duro (`hard=true`, irreversible -- úsalo solo si el usuario lo pide explícitamente).",
      inputSchema: {
        memory_id: z.string().describe("UUID de la memoria a olvidar"),
        hard: z.boolean().default(false).describe("Si true, borra en duro (irreversible)"),
      },
    },
    async ({ memory_id, hard }) => {
      let res: Response;
      try {
        res = await memoryFetch(`/memories/${memory_id}?hard=${hard}`, { method: "DELETE" });
      } catch (exc) {
        return textResult({ error: connectionErrorMessage("cerebro-memory", memory.baseUrl, exc) });
      }
      if (res.status === 401) return textResult({ error: authErrorMessage("cerebro-memory", "CEREBRO_TOKEN") });
      if (res.status === 404) return textResult({ error: `No existe ninguna memoria con id '${memory_id}'.` });
      if (!res.ok) return textResult({ error: await httpErrorMessage("cerebro-memory", res) });

      return textResult(await readJson(res));
    },
  );

  server.registerTool(
    "memory_link",
    {
      title: "Enlazar memorias",
      description:
        "Crea una relación explícita y dirigida entre dos memorias existentes (grafo ligero). " +
        "Vocabulario cerrado: 'relates_to' (asociación genérica), 'caused_by' (from fue causado " +
        "por to), 'part_of' (from es parte de to), 'contradicts' (from contradice a to, si es " +
        "una supersedencia clara usa memory_update en vez de esto), 'follows' (from ocurrió " +
        "después de / como consecuencia de to).",
      inputSchema: {
        from_memory_id: z.string().describe("UUID de la memoria de origen"),
        to_memory_id: z.string().describe("UUID de la memoria de destino, distinta de from_memory_id"),
        relation: z.enum(RELATIONS).describe("Tipo de relación"),
        note: z.string().optional().describe("Comentario opcional explicando la relación"),
      },
    },
    async ({ from_memory_id, to_memory_id, relation, note }) => {
      let res: Response;
      try {
        res = await memoryFetch(`/memories/${from_memory_id}/edges`, {
          method: "POST",
          body: JSON.stringify({ to_memory: to_memory_id, relation, note: note ?? null }),
        });
      } catch (exc) {
        return textResult({ error: connectionErrorMessage("cerebro-memory", memory.baseUrl, exc) });
      }
      if (res.status === 401) return textResult({ error: authErrorMessage("cerebro-memory", "CEREBRO_TOKEN") });
      if (res.status === 404) {
        const detail = (await readJson(res).catch(() => ({}))).detail;
        return textResult({ error: `cerebro-memory no encontró alguna de las dos memorias: ${detail}` });
      }
      if (res.status === 409) {
        const detail = (await readJson(res).catch(() => ({}))).detail;
        return textResult({ error: `Esa relación ya existe: ${detail}` });
      }
      if (res.status === 422) {
        const detail = (await readJson(res).catch(() => ({}))).detail;
        return textResult({ error: `Datos inválidos: ${detail}` });
      }
      if (!res.ok) return textResult({ error: await httpErrorMessage("cerebro-memory", res) });

      return textResult({ edge: await readJson(res) });
    },
  );

  server.registerTool(
    "memory_related",
    {
      title: "Vecinos de una memoria",
      description:
        "Lista los vecinos a 1 salto de una memoria: relaciones explícitas (memory_link) + la " +
        "cadena de supersedencia (relation 'supersedes') si esa memoria fue reemplazada o " +
        "reemplazó a otra.",
      inputSchema: {
        memory_id: z.string().describe("UUID de la memoria cuyos vecinos quieres ver"),
        relation: z
          .enum([...RELATIONS, "supersedes"])
          .optional()
          .describe("Filtra a un solo tipo de relación"),
      },
    },
    async ({ memory_id, relation }) => {
      const params = new URLSearchParams();
      if (relation) params.set("relation", relation);

      let res: Response;
      try {
        res = await memoryFetch(`/memories/${memory_id}/related?${params}`);
      } catch (exc) {
        return textResult({ error: connectionErrorMessage("cerebro-memory", memory.baseUrl, exc) });
      }
      if (res.status === 401) return textResult({ error: authErrorMessage("cerebro-memory", "CEREBRO_TOKEN") });
      if (res.status === 404) return textResult({ error: `No existe ninguna memoria con id '${memory_id}'.` });
      if (res.status === 422) {
        const detail = (await readJson(res).catch(() => ({}))).detail;
        return textResult({ error: `relation inválida: ${detail}` });
      }
      if (!res.ok) return textResult({ error: await httpErrorMessage("cerebro-memory", res) });

      const data = await readJson(res);
      return textResult({ related: data.related ?? [] });
    },
  );

  server.registerTool(
    "memory_timeline",
    {
      title: "Línea de tiempo",
      description:
        "Devuelve una línea de tiempo de eventos ('episodic') y decisiones ('decision'), la más " +
        "reciente primero, ordenada por fecha efectiva.",
      inputSchema: {
        context: z.string().optional().describe("Slug de un contexto para acotar la línea de tiempo"),
        from_date: z.string().optional().describe("Fecha/hora ISO 8601, límite inferior"),
        to_date: z.string().optional().describe("Fecha/hora ISO 8601, límite superior"),
        limit: z.number().int().positive().default(50).describe("Máximo de items"),
      },
    },
    async ({ context, from_date, to_date, limit }) => {
      const params = new URLSearchParams({ limit: String(limit) });
      if (context) params.set("context", context);
      if (from_date) params.set("from", from_date);
      if (to_date) params.set("to", to_date);

      let res: Response;
      try {
        res = await memoryFetch(`/timeline?${params}`);
      } catch (exc) {
        return textResult({ error: connectionErrorMessage("cerebro-memory", memory.baseUrl, exc) });
      }
      if (res.status === 401) return textResult({ error: authErrorMessage("cerebro-memory", "CEREBRO_TOKEN") });
      if (res.status === 422) {
        const detail = (await readJson(res).catch(() => ({}))).detail;
        return textResult({ error: `cerebro-memory rechazó la consulta: ${detail}` });
      }
      if (!res.ok) return textResult({ error: await httpErrorMessage("cerebro-memory", res) });

      const data = await readJson(res);
      return textResult({ items: data.items ?? [] });
    },
  );

  server.registerTool(
    "memory_contexts",
    {
      title: "Listar contextos",
      description:
        "Lista todos los contextos existentes, con su tipo (`kind`) y descripción. Llámala antes " +
        "de memory_remember si no sabes en qué contexto debe ir algo nuevo.",
      inputSchema: {},
    },
    async () => {
      let res: Response;
      try {
        res = await memoryFetch("/contexts");
      } catch (exc) {
        return textResult({ error: connectionErrorMessage("cerebro-memory", memory.baseUrl, exc) });
      }
      if (res.status === 401) return textResult({ error: authErrorMessage("cerebro-memory", "CEREBRO_TOKEN") });
      if (!res.ok) return textResult({ error: await httpErrorMessage("cerebro-memory", res) });

      return textResult({ contexts: await readJson(res) });
    },
  );

  server.registerTool(
    "memory_create_context",
    {
      title: "Crear contexto",
      description:
        "Crea un contexto nuevo (proyecto, cliente o dominio de vida) para organizar memorias. " +
        "Revisa primero con memory_contexts si ya existe algo equivalente.",
      inputSchema: {
        slug: z.string().describe("Identificador corto y estable en minúsculas con guiones, único"),
        name: z.string().describe("Nombre legible para humanos"),
        kind: z.string().describe("Tipo de contexto, p.ej. 'proyecto', 'cliente' o 'dominio'"),
        description: z.string().optional().describe("Descripción breve de qué va en este contexto"),
      },
    },
    async ({ slug, name, kind, description }) => {
      const body: Record<string, unknown> = { slug, name, kind };
      if (description !== undefined) body.description = description;

      let res: Response;
      try {
        res = await memoryFetch("/contexts", { method: "POST", body: JSON.stringify(body) });
      } catch (exc) {
        return textResult({ error: connectionErrorMessage("cerebro-memory", memory.baseUrl, exc) });
      }
      if (res.status === 401) return textResult({ error: authErrorMessage("cerebro-memory", "CEREBRO_TOKEN") });
      if (res.status === 409) return textResult({ error: `Ya existe un contexto con slug '${slug}'.` });
      if (!res.ok) return textResult({ error: await httpErrorMessage("cerebro-memory", res) });

      return textResult({ context: await readJson(res) });
    },
  );

  server.registerTool(
    "memory_stats",
    {
      title: "Estadísticas",
      description:
        "Muestra estadísticas del sistema: memorias por contexto/estado, desambiguaciones " +
        "(total/auto/agente/usuario) y preferencias aprendidas por el Context Engine.",
      inputSchema: {},
    },
    async () => {
      let res: Response;
      try {
        res = await memoryFetch("/stats");
      } catch (exc) {
        return textResult({ error: connectionErrorMessage("cerebro-memory", memory.baseUrl, exc) });
      }
      if (res.status === 401) return textResult({ error: authErrorMessage("cerebro-memory", "CEREBRO_TOKEN") });
      if (!res.ok) return textResult({ error: await httpErrorMessage("cerebro-memory", res) });

      return textResult({ stats: await readJson(res) });
    },
  );

  // =============================================================================== docs_*
  // Solo se registran si CEREBRO_DOCS_URL/CEREBRO_TOKEN están configurados -- ver
  // loadDocsConfig(). Mismo contrato que packages/cerebro-mcp/src/cerebro_mcp/server.py.

  if (docs) {
    server.registerTool(
      "docs_create_category",
      {
        title: "Crear categoría de documentos",
        description:
          "Crea una categoría nueva para organizar documentos Markdown completos. Igual flujo que " +
          "memory_create_context: cerebro-docs organiza documentos en categorías (tabla formal, no " +
          "texto libre) para poder redistribuirlas después sin tocar los documentos que contienen. " +
          "Necesaria antes de docs_save si ninguna categoría existente encaja. `hidden=true` la " +
          "excluye de docs_categories/docs_list/docs_search sin filtro explícito (sigue accesible " +
          "creando/leyendo documentos con su slug exacto) -- útil para categorías de referencia " +
          "interna. Si además pasas `locked=true`, queda oculta PARA SIEMPRE (no hay tool para " +
          "revertirlo), así que solo tiene sentido para categorías que por diseño nunca deben ser " +
          "navegables. `locked=true` sin `hidden=true` es inválido.",
        inputSchema: {
          slug: z.string().describe("Identificador corto y estable en minúsculas con guiones, único"),
          name: z.string().describe("Nombre legible para humanos"),
          description: z.string().optional().describe("Descripción breve de qué documentos van en esta categoría"),
          hidden: z.boolean().default(false).describe("Si true, no aparece en los listados (default false)"),
          locked: z.boolean().default(false).describe("Si true, `hidden` queda fijo para siempre (default false; requiere hidden=true)"),
        },
      },
      async ({ slug, name, description, hidden, locked }) => {
        const body: Record<string, unknown> = { slug, name, hidden, locked };
        if (description !== undefined) body.description = description;

        let res: Response;
        try {
          res = await docsFetch("/categories", { method: "POST", body: JSON.stringify(body) });
        } catch (exc) {
          return textResult({ error: connectionErrorMessage("cerebro-docs", docs.baseUrl, exc) });
        }
        if (res.status === 401) return textResult({ error: authErrorMessage("cerebro-docs", "CEREBRO_TOKEN") });
        if (res.status === 409) return textResult({ error: `Ya existe una categoría con slug '${slug}'.` });
        if (res.status === 422) return textResult({ error: String((await readJson(res).catch(() => ({}))).detail) });
        if (!res.ok) return textResult({ error: await httpErrorMessage("cerebro-docs", res) });

        return textResult({ category: await readJson(res) });
      },
    );

    server.registerTool(
      "docs_categories",
      {
        title: "Listar categorías de documentos",
        description:
          "Lista todas las categorías de documentos existentes, con su descripción. Llámala antes " +
          "de docs_save si no sabes en qué categoría debe ir un documento nuevo.",
        inputSchema: {},
      },
      async () => {
        let res: Response;
        try {
          res = await docsFetch("/categories");
        } catch (exc) {
          return textResult({ error: connectionErrorMessage("cerebro-docs", docs.baseUrl, exc) });
        }
        if (res.status === 401) return textResult({ error: authErrorMessage("cerebro-docs", "CEREBRO_TOKEN") });
        if (!res.ok) return textResult({ error: await httpErrorMessage("cerebro-docs", res) });

        return textResult({ categories: await readJson(res) });
      },
    );

    server.registerTool(
      "docs_save",
      {
        title: "Guardar documento",
        description:
          "Guarda un documento Markdown COMPLETO nuevo (sin destilar ni truncar). A diferencia de " +
          "memory_remember (que guarda hechos/decisiones destilados de 1-3 frases), docs_save guarda " +
          "el documento íntegro tal cual. `category` es OBLIGATORIA y debe existir -- revisa con " +
          "docs_categories() y créala con docs_create_category si no existe ninguna adecuada. Si el " +
          "slug ya existe en esa categoría, falla con un error explícito (nunca auto-sufija ni " +
          "sobrescribe en silencio) -- usa docs_update para editar el existente.",
        inputSchema: {
          title: z.string().describe("Título del documento"),
          content: z.string().describe("El Markdown completo, sin truncar"),
          category: z.string().describe("Slug de una categoría existente (obligatorio)"),
          slug: z.string().optional().describe("Identificador corto opcional; si se omite, se autogenera del título"),
        },
      },
      async ({ title, content, category, slug }) => {
        const body: Record<string, unknown> = { title, content, category };
        if (slug !== undefined) body.slug = slug;

        let res: Response;
        try {
          res = await docsFetch("/documents", { method: "POST", body: JSON.stringify(body) });
        } catch (exc) {
          return textResult({ error: connectionErrorMessage("cerebro-docs", docs.baseUrl, exc) });
        }
        if (res.status === 401) return textResult({ error: authErrorMessage("cerebro-docs", "CEREBRO_TOKEN") });
        if (res.status === 404) {
          const categories = await getCategories().catch(() => []);
          return textResult({
            error:
              `La categoría '${category}' no existe. Categorías disponibles:\n` +
              `${formatCategoryList(categories)}\n\n` +
              `Elige una de estas, o créala primero con docs_create_category(slug='${category}', ...).`,
          });
        }
        if (res.status === 409) {
          const detail = (await readJson(res).catch(() => ({}))).detail;
          return textResult({ error: String(detail) });
        }
        if (!res.ok) return textResult({ error: await httpErrorMessage("cerebro-docs", res) });

        return textResult({ document: await readJson(res) });
      },
    );

    server.registerTool(
      "docs_get",
      {
        title: "Leer documento",
        description:
          "Lee un documento completo por su ruta exacta `/{category}/{slug}`. Úsala cuando ya sabes " +
          "exactamente qué documento quieres. Si solo tienes una referencia imprecisa, usa docs_search. " +
          "Si la ruta pedida fue renombrada (el documento o su categoría cambiaron de slug), el " +
          "resultado igual trae el documento (vía redirect interno) pero con un `alert` al inicio " +
          "pidiendo dejar de usar la ruta vieja y corregirla donde la tuvieras guardada -- trátalo " +
          "como instrucción, no solo como aviso informativo.",
        inputSchema: {
          category: z.string().describe("Slug de la categoría del documento"),
          slug: z.string().describe("Slug del documento dentro de esa categoría"),
        },
      },
      async ({ category, slug }) => {
        let res: Response;
        try {
          res = await docsFetch(`/documents/${encodeURIComponent(category)}/${encodeURIComponent(slug)}`);
        } catch (exc) {
          return textResult({ error: connectionErrorMessage("cerebro-docs", docs.baseUrl, exc) });
        }
        if (res.status === 401) return textResult({ error: authErrorMessage("cerebro-docs", "CEREBRO_TOKEN") });
        if (res.status === 404) return textResult({ error: `No existe ningún documento en '${category}/${slug}'.` });
        if (!res.ok) return textResult({ error: await httpErrorMessage("cerebro-docs", res) });

        const document = await readJson(res);
        if (document?.redirected_from) {
          return textResult({
            alert:
              `AVISO: la ruta '${category}/${slug}' que pediste ya no existe -- este documento se movió a ` +
              `'${document.category}/${document.slug}'. No vuelvas a usar la ruta vieja de aquí en adelante; ` +
              "si la tenías guardada en una memoria o en otro documento, actualízala a la nueva antes de terminar.",
            document,
          });
        }

        return textResult({ document });
      },
    );

    server.registerTool(
      "docs_list_archived",
      {
        title: "Listar documentos archivados",
        description:
          "Lista documentos archivados (docs_list/docs_search nunca los muestran). Útil para " +
          "encontrar algo archivado antes, o decidir si desarchivarlo (docs_unarchive) o borrarlo " +
          "definitivamente (docs_delete).",
        inputSchema: {
          category: z.string().optional().describe("Slug de una categoría para acotar el listado"),
          limit: z.number().int().positive().max(100).default(20).describe("Máximo de resultados por página"),
          offset: z.number().int().nonnegative().default(0).describe("Cuántos resultados saltar, para paginar"),
        },
      },
      async ({ category, limit, offset }) => {
        const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
        if (category) params.set("category", category);

        let res: Response;
        try {
          res = await docsFetch(`/documents/archived?${params}`);
        } catch (exc) {
          return textResult({ error: connectionErrorMessage("cerebro-docs", docs.baseUrl, exc) });
        }
        if (res.status === 401) return textResult({ error: authErrorMessage("cerebro-docs", "CEREBRO_TOKEN") });
        if (res.status === 403) return textResult({ error: `No tienes acceso a la categoría '${category}'.` });
        if (!res.ok) return textResult({ error: await httpErrorMessage("cerebro-docs", res) });

        return textResult({ documents: await readJson(res) });
      },
    );

    server.registerTool(
      "docs_archive",
      {
        title: "Archivar documento",
        description:
          "Archiva un documento (soft-delete): deja de aparecer en docs_list/docs_search, pero sigue " +
          "accesible por su ruta exacta con docs_get y puede revertirse con docs_unarchive. " +
          "Equivalente de memory_forget en cerebro-docs -- prefiérela sobre docs_delete cuando el " +
          "usuario quiere 'sacar algo del medio' sin perderlo.",
        inputSchema: {
          document_id: z.string().describe("UUID del documento a archivar"),
        },
      },
      async ({ document_id }) => {
        let res: Response;
        try {
          res = await docsFetch(`/documents/${document_id}/archive`, { method: "POST" });
        } catch (exc) {
          return textResult({ error: connectionErrorMessage("cerebro-docs", docs.baseUrl, exc) });
        }
        if (res.status === 401) return textResult({ error: authErrorMessage("cerebro-docs", "CEREBRO_TOKEN") });
        if (res.status === 404) return textResult({ error: `No existe ningún documento con id '${document_id}'.` });
        if (!res.ok) return textResult({ error: await httpErrorMessage("cerebro-docs", res) });

        return textResult({ document: await readJson(res) });
      },
    );

    server.registerTool(
      "docs_unarchive",
      {
        title: "Desarchivar documento",
        description: "Revierte un docs_archive: el documento vuelve a aparecer en docs_list/docs_search.",
        inputSchema: {
          document_id: z.string().describe("UUID del documento a desarchivar"),
        },
      },
      async ({ document_id }) => {
        let res: Response;
        try {
          res = await docsFetch(`/documents/${document_id}/unarchive`, { method: "POST" });
        } catch (exc) {
          return textResult({ error: connectionErrorMessage("cerebro-docs", docs.baseUrl, exc) });
        }
        if (res.status === 401) return textResult({ error: authErrorMessage("cerebro-docs", "CEREBRO_TOKEN") });
        if (res.status === 404) return textResult({ error: `No existe ningún documento con id '${document_id}'.` });
        if (!res.ok) return textResult({ error: await httpErrorMessage("cerebro-docs", res) });

        return textResult({ document: await readJson(res) });
      },
    );

    server.registerTool(
      "docs_history",
      {
        title: "Historial de versiones de un documento",
        description:
          "Lista el historial de versiones anteriores de un documento (snapshots guardados " +
          "automáticamente antes de cada docs_update/docs_patch_section). Solo lectura -- no hay " +
          "restore automático; para recuperar contenido de una versión vieja, cópialo del resultado " +
          "y guárdalo con docs_update.",
        inputSchema: {
          document_id: z.string().describe("UUID del documento"),
        },
      },
      async ({ document_id }) => {
        let res: Response;
        try {
          res = await docsFetch(`/documents/${document_id}/versions`);
        } catch (exc) {
          return textResult({ error: connectionErrorMessage("cerebro-docs", docs.baseUrl, exc) });
        }
        if (res.status === 401) return textResult({ error: authErrorMessage("cerebro-docs", "CEREBRO_TOKEN") });
        if (res.status === 404) return textResult({ error: `No existe ningún documento con id '${document_id}'.` });
        if (!res.ok) return textResult({ error: await httpErrorMessage("cerebro-docs", res) });

        return textResult({ versions: await readJson(res) });
      },
    );

    server.registerTool(
      "docs_search",
      {
        title: "Buscar documentos",
        description:
          "Busca documentos por texto (full-text simple, sin embeddings) -- para referencias " +
          "imprecisas ('la guía de despliegue'). Busca en título Y contenido. Si ya sabes la categoría " +
          "y el slug exactos, usa docs_get en vez de esta.",
        inputSchema: {
          query: z.string().describe("Texto a buscar (full-text sobre título + contenido)"),
          category: z.string().optional().describe("Slug de una categoría para acotar la búsqueda"),
          limit: z.number().int().positive().max(100).default(20).describe("Máximo de resultados por página"),
          offset: z.number().int().nonnegative().default(0).describe("Cuántos resultados saltar, para paginar"),
        },
      },
      async ({ query, category, limit, offset }) => {
        const params = new URLSearchParams({ q: query, limit: String(limit), offset: String(offset) });
        if (category) params.set("category", category);

        let res: Response;
        try {
          res = await docsFetch(`/documents?${params}`);
        } catch (exc) {
          return textResult({ error: connectionErrorMessage("cerebro-docs", docs.baseUrl, exc) });
        }
        if (res.status === 401) return textResult({ error: authErrorMessage("cerebro-docs", "CEREBRO_TOKEN") });
        if (res.status === 403) return textResult({ error: `No tienes acceso a la categoría '${category}'.` });
        if (!res.ok) return textResult({ error: await httpErrorMessage("cerebro-docs", res) });

        return textResult({ documents: await readJson(res) });
      },
    );

    server.registerTool(
      "docs_list",
      {
        title: "Listar documentos",
        description:
          "Lista documentos, más recientes primero (sin filtro de texto -- ver docs_search para eso). " +
          "Útil para explorar qué documentos existen en una categoría, o en todo el repositorio si se " +
          "omite `category`.",
        inputSchema: {
          category: z.string().optional().describe("Slug de una categoría para acotar el listado"),
          limit: z.number().int().positive().max(100).default(20).describe("Máximo de resultados por página"),
          offset: z.number().int().nonnegative().default(0).describe("Cuántos resultados saltar, para paginar"),
        },
      },
      async ({ category, limit, offset }) => {
        const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
        if (category) params.set("category", category);

        let res: Response;
        try {
          res = await docsFetch(`/documents?${params}`);
        } catch (exc) {
          return textResult({ error: connectionErrorMessage("cerebro-docs", docs.baseUrl, exc) });
        }
        if (res.status === 401) return textResult({ error: authErrorMessage("cerebro-docs", "CEREBRO_TOKEN") });
        if (res.status === 403) return textResult({ error: `No tienes acceso a la categoría '${category}'.` });
        if (!res.ok) return textResult({ error: await httpErrorMessage("cerebro-docs", res) });

        return textResult({ documents: await readJson(res) });
      },
    );

    server.registerTool(
      "docs_update",
      {
        title: "Reemplazar documento",
        description:
          "Reemplazo COMPLETO de un documento existente (incluye poder moverlo de categoría). " +
          "cerebro-docs archiva un snapshot del contenido anterior en el historial de versiones antes " +
          "de aplicar el reemplazo. Para editar solo una parte del documento, usa docs_patch_section.",
        inputSchema: {
          document_id: z.string().describe("UUID del documento a reemplazar"),
          title: z.string().describe("Título nuevo (reemplaza el anterior)"),
          content: z.string().describe("Contenido Markdown nuevo COMPLETO (reemplaza el anterior entero)"),
          category: z.string().describe("Slug de la categoría destino -- puede ser distinta de la actual para mover el documento (debe existir)"),
          slug: z.string().optional().describe("Slug nuevo opcional; si se omite, conserva el slug actual"),
        },
      },
      async ({ document_id, title, content, category, slug }) => {
        const body: Record<string, unknown> = { title, content, category };
        if (slug !== undefined) body.slug = slug;

        let res: Response;
        try {
          res = await docsFetch(`/documents/${document_id}`, { method: "PATCH", body: JSON.stringify(body) });
        } catch (exc) {
          return textResult({ error: connectionErrorMessage("cerebro-docs", docs.baseUrl, exc) });
        }
        if (res.status === 401) return textResult({ error: authErrorMessage("cerebro-docs", "CEREBRO_TOKEN") });
        if (res.status === 404) {
          const detail = (await readJson(res).catch(() => ({}))).detail;
          return textResult({ error: String(detail) });
        }
        if (res.status === 409) {
          const detail = (await readJson(res).catch(() => ({}))).detail;
          return textResult({ error: String(detail) });
        }
        if (!res.ok) return textResult({ error: await httpErrorMessage("cerebro-docs", res) });

        return textResult({ document: await readJson(res) });
      },
    );

    server.registerTool(
      "docs_patch_section",
      {
        title: "Parchear sección de documento",
        description:
          "Parche PARCIAL de un documento por sección (desde un heading hasta el siguiente del mismo " +
          "nivel o superior). Vocabulario de `operation`: 'replace' (sustituye el cuerpo de la sección " +
          "por `body`), 'append' (agrega `body` al final del cuerpo), 'insert_after'/'insert_before' " +
          "(inserta `body` como bloque hermano antes/después de la sección completa), 'delete' (elimina " +
          "la sección completa, `body` se ignora). El `heading` debe matchear EXACTO el texto de un " +
          "heading del documento (sin los `#`); si aparece más de una vez, esta tool SIEMPRE falla " +
          "(nunca adivina). Si no aparece ninguna vez, falla salvo que pases `create_if_missing=true`.",
        inputSchema: {
          document_id: z.string().describe("UUID del documento a parchear"),
          heading: z.string().describe("Texto exacto del heading objetivo (sin los #)"),
          operation: z.enum(SECTION_OPERATIONS).describe("Una de: replace, append, insert_after, insert_before, delete"),
          body: z.string().default("").describe("Contenido Markdown a insertar/usar según `operation` (ignorado en delete)"),
          create_if_missing: z.boolean().default(false).describe("Si true y el heading no existe, lo crea al final del documento en vez de fallar"),
          new_heading_level: z.number().int().min(1).max(6).default(2).describe("Nivel del heading nuevo (1-6) si create_if_missing lo crea"),
        },
      },
      async ({ document_id, heading, operation, body, create_if_missing, new_heading_level }) => {
        const payload = {
          heading,
          operation,
          body,
          create_if_missing,
          new_heading_level,
        };

        let res: Response;
        try {
          res = await docsFetch(`/documents/${document_id}/section`, {
            method: "PATCH",
            body: JSON.stringify(payload),
          });
        } catch (exc) {
          return textResult({ error: connectionErrorMessage("cerebro-docs", docs.baseUrl, exc) });
        }
        if (res.status === 401) return textResult({ error: authErrorMessage("cerebro-docs", "CEREBRO_TOKEN") });
        if (res.status === 404) {
          const detail = (await readJson(res).catch(() => ({}))).detail;
          return textResult({ error: String(detail) });
        }
        if (res.status === 409) {
          const detail = (await readJson(res).catch(() => ({}))).detail;
          return textResult({ error: String(detail) });
        }
        if (res.status === 422) {
          const detail = (await readJson(res).catch(() => ({}))).detail;
          return textResult({ error: String(detail) });
        }
        if (!res.ok) return textResult({ error: await httpErrorMessage("cerebro-docs", res) });

        return textResult({ document: await readJson(res) });
      },
    );

    server.registerTool(
      "docs_delete",
      {
        title: "Borrar documento",
        description:
          "Borra un documento (y, en cascada, todo su historial de versiones). No hay " +
          "papelera/soft-delete -- es irreversible, a diferencia de memory_forget (que por defecto " +
          "solo archiva). Confirma con el usuario antes de llamar esta tool si hay dudas.",
        inputSchema: {
          document_id: z.string().describe("UUID del documento a borrar"),
        },
      },
      async ({ document_id }) => {
        let res: Response;
        try {
          res = await docsFetch(`/documents/${document_id}`, { method: "DELETE" });
        } catch (exc) {
          return textResult({ error: connectionErrorMessage("cerebro-docs", docs.baseUrl, exc) });
        }
        if (res.status === 401) return textResult({ error: authErrorMessage("cerebro-docs", "CEREBRO_TOKEN") });
        if (res.status === 404) return textResult({ error: `No existe ningún documento con id '${document_id}'.` });
        if (!res.ok) return textResult({ error: await httpErrorMessage("cerebro-docs", res) });

        return textResult(await readJson(res));
      },
    );
  }

  // =============================================================================== flow_*
  // Solo se registran si CEREBRO_FLOWS_URL/CEREBRO_TOKEN están configurados -- ver
  // loadFlowsConfig(). Mismo contrato que packages/cerebro-mcp/src/cerebro_mcp/server.py.

  if (flows) {
    server.registerTool(
      "flow_create_category",
      {
        title: "Crear categoría de flujos",
        description:
          "Crea una categoría de flujos nueva (procesos/checklists de cerebro-flows). No es lo " +
          "mismo que una categoría de cerebro-docs -- son módulos independientes. Aquí una categoría " +
          "también es el prefijo del id secuencial de sus flujos: una categoría con `code='INC'` " +
          "genera flujos 'INC-1', 'INC-2', etc. al guardarlos sin `code` explícito.",
        inputSchema: {
          slug: z.string().describe("Identificador corto y estable en minúsculas con guiones, único"),
          code: z.string().describe("Prefijo corto en mayúsculas para los ids de sus flujos, ej. 'INC'. Único"),
          name: z.string().describe("Nombre legible para humanos"),
          description: z.string().optional().describe("Descripción breve de qué procesos van en esta categoría"),
        },
      },
      async ({ slug, code, name, description }) => {
        const body: Record<string, unknown> = { slug, code, name };
        if (description !== undefined) body.description = description;

        let res: Response;
        try {
          res = await flowsFetch("/categories", { method: "POST", body: JSON.stringify(body) });
        } catch (exc) {
          return textResult({ error: connectionErrorMessage("cerebro-flows", flows.baseUrl, exc) });
        }
        if (res.status === 401) return textResult({ error: authErrorMessage("cerebro-flows", "CEREBRO_TOKEN") });
        if (res.status === 409) return textResult({ error: `Ya existe una categoría con slug '${slug}' o code '${code}'.` });
        if (!res.ok) return textResult({ error: await httpErrorMessage("cerebro-flows", res) });

        return textResult({ category: await readJson(res) });
      },
    );

    server.registerTool(
      "flow_categories",
      {
        title: "Listar categorías de flujos",
        description:
          "Lista todas las categorías de flujos existentes, con su `code` (prefijo de id). Llámala " +
          "antes de flow_save si no sabes en qué categoría debe ir un flujo nuevo, o si necesitas el " +
          "`code` de una categoría para predecir el id que le tocará.",
        inputSchema: {},
      },
      async () => {
        let res: Response;
        try {
          res = await flowsFetch("/categories");
        } catch (exc) {
          return textResult({ error: connectionErrorMessage("cerebro-flows", flows.baseUrl, exc) });
        }
        if (res.status === 401) return textResult({ error: authErrorMessage("cerebro-flows", "CEREBRO_TOKEN") });
        if (!res.ok) return textResult({ error: await httpErrorMessage("cerebro-flows", res) });

        return textResult({ categories: await readJson(res) });
      },
    );

    server.registerTool(
      "flow_validate",
      {
        title: "Validar definición de flujo",
        description:
          "Valida un YAML de definición de flujo SIN guardarlo -- para autoría iterativa. Úsala " +
          "mientras redactas o editas un flujo, antes de confirmarlo con flow_save/flow_update: corre " +
          "exactamente la misma validación que esas dos harían (incluyendo la referencial -- todo " +
          "`next`/`branches`/`checkpoint.on_reject` debe apuntar a un step real que exista en " +
          "`procedure`, cada step debe tener exactamente uno de `next`/`branches`/`terminal: true` " +
          "según su tipo, etc.) y devuelve el error específico (qué step, qué campo) si algo está " +
          "mal, sin tocar la base de datos.",
        inputSchema: {
          yaml_content: z.string().describe("El YAML completo del flujo a validar"),
        },
      },
      async ({ yaml_content }) => {
        let res: Response;
        try {
          res = await flowsFetch("/flows/validate", { method: "POST", body: JSON.stringify({ yaml_content }) });
        } catch (exc) {
          return textResult({ error: connectionErrorMessage("cerebro-flows", flows.baseUrl, exc) });
        }
        if (res.status === 401) return textResult({ error: authErrorMessage("cerebro-flows", "CEREBRO_TOKEN") });
        if (res.status === 422) return textResult({ error: String((await readJson(res).catch(() => ({}))).detail) });
        if (!res.ok) return textResult({ error: await httpErrorMessage("cerebro-flows", res) });

        return textResult({ valid: true });
      },
    );

    server.registerTool(
      "flow_save",
      {
        title: "Guardar flujo nuevo",
        description:
          "Guarda un flujo NUEVO (validado antes de escribir -- mismo chequeo que flow_validate). " +
          "`category` es OBLIGATORIA y debe existir -- revisa con flow_categories() y créala con " +
          "flow_create_category si ninguna existente encaja. Si omites `code`, se autogenera como " +
          "'{code-de-categoría}-{siguiente número}' (ej. 'INC-23').",
        inputSchema: {
          category: z.string().describe("Slug de una categoría existente (obligatorio)"),
          yaml_content: z.string().describe("El YAML completo del flujo (ver flow_validate para el esquema)"),
          code: z.string().optional().describe("Id secuencial explícito opcional; si se omite, se autogenera"),
        },
      },
      async ({ category, yaml_content, code }) => {
        const body: Record<string, unknown> = { category, yaml_content };
        if (code !== undefined) body.code = code;

        let res: Response;
        try {
          res = await flowsFetch("/flows", { method: "POST", body: JSON.stringify(body) });
        } catch (exc) {
          return textResult({ error: connectionErrorMessage("cerebro-flows", flows.baseUrl, exc) });
        }
        if (res.status === 401) return textResult({ error: authErrorMessage("cerebro-flows", "CEREBRO_TOKEN") });
        if (res.status === 404) {
          const categories = await getFlowCategories().catch(() => []);
          return textResult({
            error:
              `La categoría '${category}' no existe. Categorías disponibles:\n` +
              `${formatCategoryList(categories)}\n\n` +
              `Elige una de estas, o créala primero con flow_create_category(slug='${category}', ...).`,
          });
        }
        if (res.status === 409 || res.status === 422) {
          return textResult({ error: String((await readJson(res).catch(() => ({}))).detail) });
        }
        if (!res.ok) return textResult({ error: await httpErrorMessage("cerebro-flows", res) });

        return textResult({ flow: await readJson(res) });
      },
    );

    server.registerTool(
      "flow_get",
      {
        title: "Leer definición de flujo",
        description:
          "Lee la definición completa (YAML incluido) de un flujo por su id secuencial. NO la uses " +
          "para EJECUTAR un flujo (eso es flow_start/flow_next, que revelan un step a la vez) -- es " +
          "para inspeccionar o editar una definición existente.",
        inputSchema: {
          code: z.string().describe("Id secuencial del flujo, ej. 'INC-22'"),
        },
      },
      async ({ code }) => {
        let res: Response;
        try {
          res = await flowsFetch(`/flows/${encodeURIComponent(code)}`);
        } catch (exc) {
          return textResult({ error: connectionErrorMessage("cerebro-flows", flows.baseUrl, exc) });
        }
        if (res.status === 401) return textResult({ error: authErrorMessage("cerebro-flows", "CEREBRO_TOKEN") });
        if (res.status === 404) return textResult({ error: `No existe ningún flujo con code '${code}'.` });
        if (!res.ok) return textResult({ error: await httpErrorMessage("cerebro-flows", res) });

        return textResult({ flow: await readJson(res) });
      },
    );

    server.registerTool(
      "flow_list",
      {
        title: "Listar flujos",
        description: "Lista definiciones de flujos, más recientes primero.",
        inputSchema: {
          category: z.string().optional().describe("Slug de una categoría para acotar el listado"),
          limit: z.number().int().positive().max(100).default(20).describe("Máximo de resultados por página"),
          offset: z.number().int().nonnegative().default(0).describe("Cuántos resultados saltar, para paginar"),
        },
      },
      async ({ category, limit, offset }) => {
        const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
        if (category) params.set("category", category);

        let res: Response;
        try {
          res = await flowsFetch(`/flows?${params}`);
        } catch (exc) {
          return textResult({ error: connectionErrorMessage("cerebro-flows", flows.baseUrl, exc) });
        }
        if (res.status === 401) return textResult({ error: authErrorMessage("cerebro-flows", "CEREBRO_TOKEN") });
        if (res.status === 403) return textResult({ error: `No tienes acceso a la categoría '${category}'.` });
        if (!res.ok) return textResult({ error: await httpErrorMessage("cerebro-flows", res) });

        return textResult({ flows: await readJson(res) });
      },
    );

    server.registerTool(
      "flow_update",
      {
        title: "Reemplazar YAML de un flujo",
        description:
          "Reemplaza el YAML de un flujo existente, creando una versión nueva (nunca sobrescribe en " +
          "silencio -- la versión anterior queda archivada). Una ejecución ya en curso (flow_start " +
          "previo) sigue la versión con la que arrancó, así que editar un flujo nunca cambia el " +
          "comportamiento de una ejecución que ya está corriendo.",
        inputSchema: {
          code: z.string().describe("Id secuencial del flujo a actualizar"),
          yaml_content: z.string().describe("El YAML completo nuevo (reemplaza el anterior entero)"),
        },
      },
      async ({ code, yaml_content }) => {
        let res: Response;
        try {
          res = await flowsFetch(`/flows/${encodeURIComponent(code)}`, {
            method: "PATCH",
            body: JSON.stringify({ yaml_content }),
          });
        } catch (exc) {
          return textResult({ error: connectionErrorMessage("cerebro-flows", flows.baseUrl, exc) });
        }
        if (res.status === 401) return textResult({ error: authErrorMessage("cerebro-flows", "CEREBRO_TOKEN") });
        if (res.status === 404) return textResult({ error: `No existe ningún flujo con code '${code}'.` });
        if (res.status === 422) return textResult({ error: String((await readJson(res).catch(() => ({}))).detail) });
        if (!res.ok) return textResult({ error: await httpErrorMessage("cerebro-flows", res) });

        return textResult({ flow: await readJson(res) });
      },
    );

    server.registerTool(
      "flow_delete",
      {
        title: "Borrar flujo",
        description:
          "Borra una definición de flujo (y, en cascada, su historial de versiones y sus " +
          "ejecuciones registradas). Irreversible -- confirma con el usuario si hay dudas.",
        inputSchema: {
          code: z.string().describe("Id secuencial del flujo a borrar"),
        },
      },
      async ({ code }) => {
        let res: Response;
        try {
          res = await flowsFetch(`/flows/${encodeURIComponent(code)}`, { method: "DELETE" });
        } catch (exc) {
          return textResult({ error: connectionErrorMessage("cerebro-flows", flows.baseUrl, exc) });
        }
        if (res.status === 401) return textResult({ error: authErrorMessage("cerebro-flows", "CEREBRO_TOKEN") });
        if (res.status === 404) return textResult({ error: `No existe ningún flujo con code '${code}'.` });
        if (!res.ok) return textResult({ error: await httpErrorMessage("cerebro-flows", res) });

        return textResult(await readJson(res));
      },
    );

    server.registerTool(
      "flow_start",
      {
        title: "Iniciar ejecución de un flujo",
        description:
          "Inicia una ejecución nueva de un flujo -- el PRIMER paso del protocolo de ejecución. " +
          "NUNCA leas la definición completa con flow_get para 'seguirla' a mano -- el servidor " +
          "revela un step a la vez, y es intencional: no puedes saltarte un checkpoint que no has " +
          "visto todavía.\n\n" +
          "Protocolo completo:\n" +
          "1. flow_start(code) -> {run_id, status, step}. Guarda `run_id`, lo necesitas en TODAS las " +
          "llamadas siguientes.\n" +
          "2. El primer `step` casi siempre es sintético (`id: '__prerequisites__'`) con " +
          "`tools_required`: confirma que tienes esas tools (prueba ToolSearch si alguna está " +
          "diferida) antes de continuar. Si falta alguna de verdad, avisa al usuario y NO continúes.\n" +
          "3. Llama flow_next(run_id) en loop para avanzar. Si el `step` que devuelve es " +
          "`type: 'decision'`, tu SIGUIENTE llamada a flow_next debe incluir `decision` con una de " +
          "las claves de `branches` (el servidor no infiere la condición, tú la reportas).\n" +
          "4. Si un `step` trae `checkpoint`, flow_next se bloquea hasta que llames " +
          "flow_approve_checkpoint o flow_reject_checkpoint.\n" +
          "5. `status: 'completed'` (con `step: null`) marca un fin exitoso. No hace falta reconocer " +
          "ningún texto libre como 'fin del flujo'.",
        inputSchema: {
          code: z.string().describe("Id secuencial del flujo a ejecutar, ej. 'INC-22'"),
        },
      },
      async ({ code }) => {
        let res: Response;
        try {
          res = await flowsFetch(`/flows/${encodeURIComponent(code)}/start`, { method: "POST" });
        } catch (exc) {
          return textResult({ error: connectionErrorMessage("cerebro-flows", flows.baseUrl, exc) });
        }
        if (res.status === 401) return textResult({ error: authErrorMessage("cerebro-flows", "CEREBRO_TOKEN") });
        if (res.status === 404) return textResult({ error: `No existe ningún flujo con code '${code}'.` });
        if (!res.ok) return textResult({ error: await httpErrorMessage("cerebro-flows", res) });

        return textResult(await readJson(res));
      },
    );

    server.registerTool(
      "flow_next",
      {
        title: "Avanzar ejecución de un flujo",
        description:
          "Avanza una ejecución al siguiente step (ver el protocolo completo en flow_start). Si el " +
          "step ACTUAL (el que ya viste) es `type: 'decision'`, pasa `decision` con una de sus " +
          "`branches`. Si el step actual tiene un `checkpoint` sin resolver, esta tool falla (409) " +
          "hasta que llames flow_approve_checkpoint/flow_reject_checkpoint.",
        inputSchema: {
          run_id: z.string().describe("El run_id devuelto por flow_start"),
          decision: z.string().optional().describe("La rama tomada, solo si el step actual es una decisión"),
        },
      },
      async ({ run_id, decision }) => {
        let res: Response;
        try {
          res = await flowsFetch(`/runs/${run_id}/next`, {
            method: "POST",
            body: JSON.stringify({ decision: decision ?? null }),
          });
        } catch (exc) {
          return textResult({ error: connectionErrorMessage("cerebro-flows", flows.baseUrl, exc) });
        }
        if (res.status === 401) return textResult({ error: authErrorMessage("cerebro-flows", "CEREBRO_TOKEN") });
        if (res.status === 404) return textResult({ error: `run_id '${run_id}' no existe o expiró por inactividad.` });
        if (res.status === 409 || res.status === 422) {
          return textResult({ error: String((await readJson(res).catch(() => ({}))).detail) });
        }
        if (!res.ok) return textResult({ error: await httpErrorMessage("cerebro-flows", res) });

        return textResult(await readJson(res));
      },
    );

    server.registerTool(
      "flow_approve_checkpoint",
      {
        title: "Aprobar checkpoint",
        description:
          "Aprueba el checkpoint del step actual -- desbloquea el siguiente flow_next. Una llamada " +
          "DELIBERADA, separada de flow_next a propósito: aprobar un checkpoint es la acción de mayor " +
          "consecuencia en un flujo, nunca un parámetro que se pasa 'por costumbre'. Si no estás " +
          "seguro de que el usuario aprobaría este paso, confírmalo con él ANTES de llamar esta tool.",
        inputSchema: {
          run_id: z.string().describe("El run_id de la ejecución"),
        },
      },
      async ({ run_id }) => {
        let res: Response;
        try {
          res = await flowsFetch(`/runs/${run_id}/approve-checkpoint`, { method: "POST" });
        } catch (exc) {
          return textResult({ error: connectionErrorMessage("cerebro-flows", flows.baseUrl, exc) });
        }
        if (res.status === 401) return textResult({ error: authErrorMessage("cerebro-flows", "CEREBRO_TOKEN") });
        if (res.status === 404) return textResult({ error: `run_id '${run_id}' no existe o expiró por inactividad.` });
        if (res.status === 409) return textResult({ error: String((await readJson(res).catch(() => ({}))).detail) });
        if (!res.ok) return textResult({ error: await httpErrorMessage("cerebro-flows", res) });

        return textResult(await readJson(res));
      },
    );

    server.registerTool(
      "flow_reject_checkpoint",
      {
        title: "Rechazar checkpoint",
        description:
          "Rechaza el checkpoint del step actual -- el flujo salta al step definido en " +
          "`checkpoint.on_reject` en el YAML (ej. volver a revisión o rehacer un paso anterior), no " +
          "solo se detiene.",
        inputSchema: {
          run_id: z.string().describe("El run_id de la ejecución"),
          reason: z.string().describe("Motivo del rechazo (queda en el historial de auditoría de la ejecución)"),
        },
      },
      async ({ run_id, reason }) => {
        let res: Response;
        try {
          res = await flowsFetch(`/runs/${run_id}/reject-checkpoint`, {
            method: "POST",
            body: JSON.stringify({ reason }),
          });
        } catch (exc) {
          return textResult({ error: connectionErrorMessage("cerebro-flows", flows.baseUrl, exc) });
        }
        if (res.status === 401) return textResult({ error: authErrorMessage("cerebro-flows", "CEREBRO_TOKEN") });
        if (res.status === 404) return textResult({ error: `run_id '${run_id}' no existe o expiró por inactividad.` });
        if (res.status === 409) return textResult({ error: String((await readJson(res).catch(() => ({}))).detail) });
        if (!res.ok) return textResult({ error: await httpErrorMessage("cerebro-flows", res) });

        return textResult(await readJson(res));
      },
    );

    server.registerTool(
      "flow_abort",
      {
        title: "Abortar ejecución de un flujo",
        description:
          "Aborta una ejecución en curso -- la marca como `aborted` (irreversible, a diferencia de un " +
          "checkpoint rechazado, que redirige el flujo en vez de terminarlo). Úsala cuando el usuario " +
          "decide explícitamente no continuar con un proceso que ya empezó.",
        inputSchema: {
          run_id: z.string().describe("El run_id de la ejecución a abortar"),
          reason: z.string().optional().describe("Motivo opcional (queda en el historial de auditoría de la ejecución)"),
        },
      },
      async ({ run_id, reason }) => {
        let res: Response;
        try {
          res = await flowsFetch(`/runs/${run_id}/abort`, {
            method: "POST",
            body: JSON.stringify({ reason: reason ?? null }),
          });
        } catch (exc) {
          return textResult({ error: connectionErrorMessage("cerebro-flows", flows.baseUrl, exc) });
        }
        if (res.status === 401) return textResult({ error: authErrorMessage("cerebro-flows", "CEREBRO_TOKEN") });
        if (res.status === 404) return textResult({ error: `run_id '${run_id}' no existe.` });
        if (res.status === 409) return textResult({ error: String((await readJson(res).catch(() => ({}))).detail) });
        if (!res.ok) return textResult({ error: await httpErrorMessage("cerebro-flows", res) });

        return textResult(await readJson(res));
      },
    );
  }

  // =============================================================================== auth_*
  // Solo se registran si CEREBRO_AUTH_URL/CEREBRO_TOKEN están configurados -- ver
  // loadAuthConfig(). Mismo contrato que packages/cerebro-mcp/src/cerebro_mcp/server.py.
  // OJO: estas tools otorgan acceso real a otras identidades (auth_create_token en
  // particular) -- ver el docstring de cada una antes de exponerlas/usarlas.

  if (auth) {
    server.registerTool(
      "auth_create_user",
      {
        title: "Crear usuario",
        description:
          "Crea una identidad nueva (humana o de servicio) en cerebro-auth. Requiere un token nivel " +
          "admin: la API subyacente lo exige y devuelve error si el token que llama esta tool no es " +
          "él mismo nivel admin -- espera ese fallo (no reintentes con otros argumentos) si quien " +
          "llama no es admin, en vez de asumir que algo más salió mal. `access_level` fija el nivel " +
          "de permisos propio de este usuario (ej. 'user', 'owner', 'admin'). Entre otras cosas, es lo " +
          "que hereda por defecto un token creado para este usuario vía auth_create_token cuando esa " +
          "llamada omite su propio `access_level` y en cambio pasa `user=name`. Crear el usuario NO " +
          "otorga por sí solo acceso a ningún módulo -- eso solo ocurre cuando el usuario se agrega a " +
          "un grupo (auth_add_group_member) cuyos scopes se definieron con auth_set_group_scopes.",
        inputSchema: {
          name: z.string().describe("Nombre único identificador para este usuario"),
          email: z.string().optional().describe("Email opcional, típico para un usuario humano (omitir para una identidad de servicio/bot)"),
          access_level: z.string().default("user").describe("Nivel de permisos de este usuario (default 'user')"),
        },
      },
      async ({ name, email, access_level }) => {
        const body: Record<string, unknown> = { name, access_level };
        if (email !== undefined) body.email = email;

        let res: Response;
        try {
          res = await authFetch("/users", { method: "POST", body: JSON.stringify(body) });
        } catch (exc) {
          return textResult({ error: connectionErrorMessage("cerebro-auth", auth.baseUrl, exc) });
        }
        if (res.status === 401) return textResult({ error: authErrorMessage("cerebro-auth", "CEREBRO_TOKEN") });
        if (!res.ok) return textResult({ error: await httpErrorMessage("cerebro-auth", res) });

        return textResult({ user: await readJson(res) });
      },
    );

    server.registerTool(
      "auth_list_users",
      {
        title: "Listar usuarios",
        description:
          "Lista todos los usuarios (identidades) registrados en cerebro-auth. Útil antes de " +
          "auth_add_group_member o auth_create_token(user=...) para confirmar el nombre exacto de un " +
          "usuario existente, o para auditar qué identidades existen y con qué `access_level`.",
        inputSchema: {},
      },
      async () => {
        let res: Response;
        try {
          res = await authFetch("/users");
        } catch (exc) {
          return textResult({ error: connectionErrorMessage("cerebro-auth", auth.baseUrl, exc) });
        }
        if (res.status === 401) return textResult({ error: authErrorMessage("cerebro-auth", "CEREBRO_TOKEN") });
        if (!res.ok) return textResult({ error: await httpErrorMessage("cerebro-auth", res) });

        return textResult({ users: await readJson(res) });
      },
    );

    server.registerTool(
      "auth_create_group",
      {
        title: "Crear grupo",
        description:
          "Crea un grupo nuevo -- la unidad que cerebro-auth usa para otorgar acceso a módulos. Un " +
          "grupo recién creado NO tiene permisos propios: es solo un contenedor con nombre. Usa " +
          "auth_set_group_scopes para definir qué pueden alcanzar sus miembros, y " +
          "auth_add_group_member para efectivamente meter usuarios en él.",
        inputSchema: {
          slug: z.string().describe("Identificador corto y estable en minúsculas con guiones, único"),
          name: z.string().describe("Nombre legible para humanos del grupo"),
        },
      },
      async ({ slug, name }) => {
        let res: Response;
        try {
          res = await authFetch("/groups", { method: "POST", body: JSON.stringify({ slug, name }) });
        } catch (exc) {
          return textResult({ error: connectionErrorMessage("cerebro-auth", auth.baseUrl, exc) });
        }
        if (res.status === 401) return textResult({ error: authErrorMessage("cerebro-auth", "CEREBRO_TOKEN") });
        if (res.status === 409) return textResult({ error: `Ya existe un grupo con slug '${slug}'.` });
        if (!res.ok) return textResult({ error: await httpErrorMessage("cerebro-auth", res) });

        return textResult({ group: await readJson(res) });
      },
    );

    server.registerTool(
      "auth_set_group_scopes",
      {
        title: "Definir scopes de un grupo",
        description:
          "Define qué puede acceder POR DEFECTO cada miembro nivel owner de este grupo. Este es el " +
          "otorgamiento real de permisos del grupo, en dos capas (misma forma que usa " +
          "auth_create_token para un token individual):\n" +
          "- `allowed_modules` es el filtro GRUESO: cuáles de 'memory'/'docs'/'flows' pueden tocar " +
          "los miembros de este grupo, en absoluto. Un módulo que se deja afuera queda totalmente " +
          "inaccesible para ellos, sin importar qué diga `module_scopes` sobre él.\n" +
          "- `module_scopes` es el filtro FINO dentro de cada módulo permitido, ej. " +
          "`{\"memory\": {\"contexts\": [\"proyecto-x\"]}}` restringe el acceso a memory a solo ese " +
          "contexto aunque 'memory' esté en `allowed_modules`.\n\n" +
          "Esta llamada REEMPLAZA los scopes actuales del grupo -- no es aditiva. Todo miembro nivel " +
          "owner adopta los scopes nuevos como su default en el momento en que esta llamada tiene " +
          "éxito (un token ya creado para ellos conserva con lo que fue creado, salvo que se haya " +
          "configurado para heredar por completo -- ver auth_create_token).",
        inputSchema: {
          group_slug: z.string().describe("Slug de un grupo existente"),
          allowed_modules: z.array(z.string()).describe("Lista de módulos que pueden acceder los miembros de este grupo, ej. ['memory', 'docs']"),
          module_scopes: z.record(z.string(), z.any()).optional().describe("Restricción fina opcional por módulo, indexada por nombre de módulo (solo aplica a módulos ya presentes en allowed_modules)"),
        },
      },
      async ({ group_slug, allowed_modules, module_scopes }) => {
        const body: Record<string, unknown> = { allowed_modules };
        if (module_scopes !== undefined) body.module_scopes = module_scopes;

        let res: Response;
        try {
          res = await authFetch(`/groups/${group_slug}/scopes`, { method: "POST", body: JSON.stringify(body) });
        } catch (exc) {
          return textResult({ error: connectionErrorMessage("cerebro-auth", auth.baseUrl, exc) });
        }
        if (res.status === 401) return textResult({ error: authErrorMessage("cerebro-auth", "CEREBRO_TOKEN") });
        if (res.status === 404) return textResult({ error: `No existe ningún grupo con slug '${group_slug}'.` });
        if (res.status === 422) return textResult({ error: `cerebro-auth rechazó los scopes: ${(await readJson(res).catch(() => ({}))).detail}` });
        if (!res.ok) return textResult({ error: await httpErrorMessage("cerebro-auth", res) });

        return textResult({ group: await readJson(res) });
      },
    );

    server.registerTool(
      "auth_add_group_member",
      {
        title: "Agregar miembro a un grupo",
        description:
          "Agrega un usuario existente a un grupo, otorgándole los scopes por defecto de ese grupo. " +
          "Requiere un token nivel admin: la API subyacente lo exige y devuelve error si el token que " +
          "llama esta tool no es él mismo nivel admin -- espera ese fallo (no reintentes con otros " +
          "argumentos) si quien llama no es admin. Una vez agregado, un usuario nivel owner hereda lo " +
          "que auth_set_group_scopes definió para este grupo -- ver auth_create_token para cómo esa " +
          "herencia fluye hacia tokens creados después para este usuario.",
        inputSchema: {
          group_slug: z.string().describe("Slug de un grupo existente"),
          user: z.string().describe("Nombre del usuario existente a agregar"),
        },
      },
      async ({ group_slug, user }) => {
        let res: Response;
        try {
          res = await authFetch(`/groups/${group_slug}/members`, { method: "POST", body: JSON.stringify({ user }) });
        } catch (exc) {
          return textResult({ error: connectionErrorMessage("cerebro-auth", auth.baseUrl, exc) });
        }
        if (res.status === 401) return textResult({ error: authErrorMessage("cerebro-auth", "CEREBRO_TOKEN") });
        if (res.status === 404) return textResult({ error: `El grupo '${group_slug}' o el usuario '${user}' no existen.` });
        if (!res.ok) return textResult({ error: await httpErrorMessage("cerebro-auth", res) });

        return textResult({ group: await readJson(res) });
      },
    );

    server.registerTool(
      "auth_create_token",
      {
        title: "Crear token",
        description:
          "Crea un token de API nuevo -- así es como se entrega acceso real a otra identidad (una " +
          "persona, un agente, un servicio). Lee todo este docstring antes de llamarla, no solo los " +
          "nombres de los argumentos: un token es una credencial viva, y equivocar su alcance " +
          "sub-otorga o sobre-otorga acceso.\n\n" +
          "`access_level` vs. `user` -- se aplica EXACTAMENTE uno de los dos, nunca ambos:\n" +
          "- Pasa `access_level` directamente para crear un token SIN usuario asociado (un token de " +
          "servicio/cuasi-root) -- su nivel de permisos es el que pases aquí.\n" +
          "- Pasa `user` (nombre de un usuario existente, ver auth_list_users) para crear un token " +
          "PARA ese usuario -- su nivel de permisos se hereda del `access_level` propio de ese usuario " +
          "(fijado al crearlo con auth_create_user), no lo elige esta llamada.\n" +
          "- Pasar AMBOS `user` y `access_level` es un error: el nivel siempre viene de exactamente " +
          "uno de los dos, nunca una mezcla.\n\n" +
          "`allowed_modules` / `module_scopes` -- el filtro de dos capas, misma forma que " +
          "auth_set_group_scopes (ver ahí el detalle grueso/fino). Cómo interactúan:\n" +
          "- Para un token SIN `user` (es decir, `access_level` dado directamente), provee " +
          "`allowed_modules` explícitamente -- no hay membresía de grupo de la que heredar, así que " +
          "omitirlo probablemente significa que el token no puede tocar nada.\n" +
          "- Para un token ligado a un `user` nivel owner, `allowed_modules`/`module_scopes` pueden " +
          "OMITIRSE POR COMPLETO para heredar íntegro lo que los grupos de ese usuario otorgan " +
          "actualmente (ver auth_set_group_scopes) -- es el caso común para un token que simplemente " +
          "debe 'ser' ese usuario. También pueden darse explícitamente, pero solo como un ESTRECHAMIENTO " +
          "de lo que ya permiten los grupos del usuario (ej. sus grupos otorgan memory+docs, pero este " +
          "token en particular solo debería tener memory) -- nunca como una AMPLIACIÓN más allá de " +
          "eso; la API rechaza un intento de ampliar en vez de recortarlo en silencio.\n\n" +
          "`scopes` es el otorgamiento a nivel de acción dentro de cerebro-auth mismo (qué operaciones " +
          "puede realizar este token), independiente de los filtros de módulo de arriba.\n\n" +
          "IMPORTANTE: el valor secreto del token se muestra solo UNA VEZ, en la respuesta de esta " +
          "llamada, y nunca puede recuperarse después por nadie, ni siquiera un admin. Si este token " +
          "es para otra persona o cosa, entrégale el valor de inmediato como parte de terminar esta " +
          "tarea -- no asumas que tú o ellos podrán obtenerlo después; el único recurso en ese punto " +
          "es auth_revoke_token + crear uno nuevo.",
        inputSchema: {
          name: z.string().describe("Nombre único identificador para este token"),
          scopes: z.array(z.string()).describe("Lista de scopes a nivel de acción que este token tiene dentro de cerebro-auth"),
          allowed_modules: z.array(z.string()).optional().describe("Filtro grueso -- qué módulos ('memory', 'docs', 'flows') puede tocar este token en absoluto. Ver arriba cuándo puede omitirse"),
          module_scopes: z.record(z.string(), z.any()).optional().describe("Filtro fino dentro de cada módulo permitido, indexado por nombre de módulo. Ver arriba la regla de solo-estrechamiento cuando se pasa `user`"),
          user: z.string().optional().describe("Nombre de un usuario existente al que representa este token. Mutuamente excluyente con access_level"),
          access_level: z.string().optional().describe("Nivel de permisos para un token sin usuario asociado. Mutuamente excluyente con user"),
        },
      },
      async ({ name, scopes, allowed_modules, module_scopes, user, access_level }) => {
        const body: Record<string, unknown> = { name, scopes };
        if (allowed_modules !== undefined) body.allowed_modules = allowed_modules;
        if (module_scopes !== undefined) body.module_scopes = module_scopes;
        if (user !== undefined) body.user = user;
        if (access_level !== undefined) body.access_level = access_level;

        let res: Response;
        try {
          res = await authFetch("/tokens", { method: "POST", body: JSON.stringify(body) });
        } catch (exc) {
          return textResult({ error: connectionErrorMessage("cerebro-auth", auth.baseUrl, exc) });
        }
        if (res.status === 401) return textResult({ error: authErrorMessage("cerebro-auth", "CEREBRO_TOKEN") });
        if (res.status === 404) return textResult({ error: `El usuario '${user}' no existe.` });
        if (res.status === 409) return textResult({ error: `Ya existe un token con nombre '${name}'.` });
        if (res.status === 422) return textResult({ error: `cerebro-auth rechazó el token: ${(await readJson(res).catch(() => ({}))).detail}` });
        if (!res.ok) return textResult({ error: await httpErrorMessage("cerebro-auth", res) });

        return textResult({ token: await readJson(res) });
      },
    );

    server.registerTool(
      "auth_list_tokens",
      {
        title: "Listar tokens",
        description:
          "Lista tokens visibles para quien llama (solo metadata -- nunca el valor secreto). El " +
          "`value` de un token se muestra solo una vez, al momento de auth_create_token -- este " +
          "listado permite auditar qué acceso existe hoy (qué scopes, allowed_modules, module_scopes y " +
          "usuario/access_level asociado tiene cada uno) antes de decidir si revocar (auth_revoke_token) " +
          "algo viejo o sobre-privilegiado, pero nunca puede recuperar un valor de token perdido.",
        inputSchema: {},
      },
      async () => {
        let res: Response;
        try {
          res = await authFetch("/tokens");
        } catch (exc) {
          return textResult({ error: connectionErrorMessage("cerebro-auth", auth.baseUrl, exc) });
        }
        if (res.status === 401) return textResult({ error: authErrorMessage("cerebro-auth", "CEREBRO_TOKEN") });
        if (!res.ok) return textResult({ error: await httpErrorMessage("cerebro-auth", res) });

        return textResult({ tokens: await readJson(res) });
      },
    );

    server.registerTool(
      "auth_revoke_token",
      {
        title: "Revocar token",
        description:
          "Revoca un token por nombre -- inmediato e irreversible: quien lo estuviera usando pierde " +
          "acceso de inmediato, y debe crearse un token nuevo (con un valor nuevo de una sola vista) " +
          "vía auth_create_token para reemplazarlo. Úsala cuando un token se filtró, ya no hace falta, " +
          "o pertenecía a una identidad/propósito que ya no debería tener acceso. Confirma con el " +
          "usuario primero si revocarlo podría romper algo en uso, salvo que ya haya pedido " +
          "específicamente revocar este token.",
        inputSchema: {
          name: z.string().describe("Nombre único del token a revocar"),
        },
      },
      async ({ name }) => {
        let res: Response;
        try {
          res = await authFetch(`/tokens/${encodeURIComponent(name)}`, { method: "DELETE" });
        } catch (exc) {
          return textResult({ error: connectionErrorMessage("cerebro-auth", auth.baseUrl, exc) });
        }
        if (res.status === 401) return textResult({ error: authErrorMessage("cerebro-auth", "CEREBRO_TOKEN") });
        if (res.status === 404) return textResult({ error: `No existe ningún token con nombre '${name}'.` });
        if (!res.ok) return textResult({ error: await httpErrorMessage("cerebro-auth", res) });

        return textResult(await readJson(res));
      },
    );
  }

  return server;
}

function loadCerebroEntry(): LocalMcpEntry | null {
  const memory = loadMemoryConfig();
  if (!memory) return null;

  const docs = loadDocsConfig(memory.agentName);
  const flows = loadFlowsConfig(memory.agentName);
  const auth = loadAuthConfig(memory.agentName);

  return {
    kind: "local",
    name: "cerebro",
    path: "/cerebro",
    createServer: () => createCerebroServer(memory, docs, flows, auth),
  };
}

export const cerebroEntry = loadCerebroEntry();

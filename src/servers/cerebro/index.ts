import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { LocalMcpEntry } from "../../registry/types.js";
import { logger } from "../../logger.js";

/**
 * Integra el ecosistema cerebro (https://github.com/luisjdev0/cerebro, privado) --
 * memoria persistente self-hosted (`cerebro-memory`, Postgres+pgvector detrás de una
 * API FastAPI) y, desde que ese repo pasó a ser un monorepo de 5 paquetes, también un
 * repositorio de documentos Markdown (`cerebro-docs`, misma arquitectura, API
 * hermana). El monorepo trae su propio cliente MCP (`cerebro-mcp`), pero es
 * stdio-only y no debe modificarse desde aquí, así que esta carpeta es una
 * reimplementación delgada de los mismos tools (mismo contrato, mismos endpoints)
 * hablando HTTP directo con las APIs ya desplegadas -- no hay lógica de negocio
 * propia, igual que el original (`cerebro-mcp/server.py` es en sí mismo un adaptador
 * delgado sobre `cerebro_clients`).
 *
 * Prefijos `memory_*` / `docs_*`, igual que upstream: las `memory_*` son un port 1:1
 * de las 10 tools originales de `cerebro-memory` (mismos nombres/schemas), y las
 * `docs_*` son las 9 tools nuevas de `cerebro-docs`. `cerebro-docs` es un servicio
 * separado (propia URL, propio contrato) que puede no estar desplegado todavía --
 * si `CEREBRO_DOCS_URL` no está definido, las tools `docs_*` simplemente no se
 * registran y el resto del MCP (memory_*) sigue funcionando igual.
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

export function createCerebroServer(memory: MemoryConfig, docs: DocsConfig | null): McpServer {
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

  if (!docs) return server;

  server.registerTool(
    "docs_create_category",
    {
      title: "Crear categoría de documentos",
      description:
        "Crea una categoría nueva para organizar documentos Markdown completos. Igual flujo que " +
        "memory_create_context: cerebro-docs organiza documentos en categorías (tabla formal, no " +
        "texto libre) para poder redistribuirlas después sin tocar los documentos que contienen. " +
        "Necesaria antes de docs_save si ninguna categoría existente encaja.",
      inputSchema: {
        slug: z.string().describe("Identificador corto y estable en minúsculas con guiones, único"),
        name: z.string().describe("Nombre legible para humanos"),
        description: z.string().optional().describe("Descripción breve de qué documentos van en esta categoría"),
      },
    },
    async ({ slug, name, description }) => {
      const body: Record<string, unknown> = { slug, name };
      if (description !== undefined) body.description = description;

      let res: Response;
      try {
        res = await docsFetch("/categories", { method: "POST", body: JSON.stringify(body) });
      } catch (exc) {
        return textResult({ error: connectionErrorMessage("cerebro-docs", docs.baseUrl, exc) });
      }
      if (res.status === 401) return textResult({ error: authErrorMessage("cerebro-docs", "CEREBRO_TOKEN") });
      if (res.status === 409) return textResult({ error: `Ya existe una categoría con slug '${slug}'.` });
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
        "exactamente qué documento quieres. Si solo tienes una referencia imprecisa, usa docs_search.",
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

      return textResult({ document: await readJson(res) });
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

  return server;
}

function loadCerebroEntry(): LocalMcpEntry | null {
  const memory = loadMemoryConfig();
  if (!memory) return null;

  const docs = loadDocsConfig(memory.agentName);

  return {
    kind: "local",
    name: "cerebro",
    path: "/cerebro",
    createServer: () => createCerebroServer(memory, docs),
  };
}

export const cerebroEntry = loadCerebroEntry();

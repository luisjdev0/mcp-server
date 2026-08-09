import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { LocalMcpEntry } from "../../registry/types.js";
import { logger } from "../../logger.js";

/**
 * Integra KnowledgeOS (https://github.com/luisjdev0/cerebro, privado) -- memoria
 * persistente self-hosted (Postgres+pgvector detrás de una API FastAPI). Ese proyecto
 * trae su propio cliente MCP (`knowledgeos-mcp`), pero es stdio-only y no debe
 * modificarse desde aquí, así que esta carpeta es una reimplementación delgada de
 * los mismos 10 tools (mismo contrato, mismos endpoints) hablando HTTP directo con
 * la API ya desplegada -- no hay lógica de negocio propia, igual que el original.
 */
const knowledgeosEnvSchema = z.object({
  KNOWLEDGEOS_API_URL: z.string().url(),
  KNOWLEDGEOS_API_TOKEN: z.string().min(1),
  KNOWLEDGEOS_AGENT_NAME: z.string().min(1).default("mcp-gateway"),
});

type KnowledgeosConfig = z.infer<typeof knowledgeosEnvSchema>;

const MEMORY_TYPES = ["semantic", "episodic", "procedural", "decision"] as const;
const RELATIONS = ["relates_to", "caused_by", "part_of", "contradicts", "follows"] as const;

function loadKnowledgeosConfig(): KnowledgeosConfig | null {
  const parsed = knowledgeosEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    logger.warn(
      'MCP "cerebro" deshabilitado: define KNOWLEDGEOS_API_URL y KNOWLEDGEOS_API_TOKEN para activarlo.',
    );
    return null;
  }
  return parsed.data;
}

function textResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

// fetch()'s Response.json() types as Promise<unknown> under this project's lib config;
// every caller here already handles arbitrary JSON shapes from the KnowledgeOS API.
function readJson(res: Response): Promise<any> {
  return res.json();
}

function connectionErrorMessage(apiUrl: string, exc: unknown): string {
  return `No se pudo conectar con la API de KnowledgeOS en ${apiUrl}: ${String(exc)}.`;
}

function authErrorMessage(apiUrl: string): string {
  return (
    `La API de KnowledgeOS en ${apiUrl} rechazó la autenticación (401). ` +
    "Verifica KNOWLEDGEOS_API_TOKEN."
  );
}

async function httpErrorMessage(res: Response): Promise<string> {
  let detail: unknown;
  try {
    detail = (await readJson(res))?.detail ?? (await res.text());
  } catch {
    detail = res.statusText;
  }
  return `La API de KnowledgeOS devolvió ${res.status}: ${JSON.stringify(detail)}`;
}

export function createKnowledgeosServer(config: KnowledgeosConfig): McpServer {
  const server = new McpServer({ name: "cerebro", version: "1.0.0" });

  // Estado de proceso por sesión MCP (una instancia de McpServer por sesión, ver
  // registry/types.ts): último `disambiguation_id` sin resolver, igual al
  // "process-memory slot" del mcp_server.py original -- ver docstring de
  // memory_search más abajo para el comportamiento de auto-resolve que habilita.
  let lastDisambiguationId: string | null = null;

  async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`${config.KNOWLEDGEOS_API_URL}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.KNOWLEDGEOS_API_TOKEN}`,
        "X-Agent-Name": config.KNOWLEDGEOS_AGENT_NAME,
        ...init.headers,
      },
    });
  }

  async function getContexts(): Promise<any[]> {
    const res = await apiFetch("/contexts");
    if (!res.ok) throw new Error(await httpErrorMessage(res));
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
        res = await apiFetch(`/memories/search?${params}`);
      } catch (exc) {
        return textResult({ error: connectionErrorMessage(config.KNOWLEDGEOS_API_URL, exc) });
      }
      if (res.status === 401) return textResult({ error: authErrorMessage(config.KNOWLEDGEOS_API_URL) });
      if (!res.ok) return textResult({ error: await httpErrorMessage(res) });

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
          const resolveRes = await apiFetch(`/disambiguations/${pendingId}/resolve`, {
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
        res = await apiFetch("/memories", { method: "POST", body: JSON.stringify(body) });
      } catch (exc) {
        return textResult({ error: connectionErrorMessage(config.KNOWLEDGEOS_API_URL, exc) });
      }
      if (res.status === 401) return textResult({ error: authErrorMessage(config.KNOWLEDGEOS_API_URL) });
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
        return textResult({ error: `KnowledgeOS rechazó la memoria (422): ${JSON.stringify(detail)}` });
      }
      if (!res.ok) return textResult({ error: await httpErrorMessage(res) });

      return textResult({ memory: await readJson(res) });
    },
  );

  server.registerTool(
    "memory_update",
    {
      title: "Actualizar memoria",
      description:
        "Actualiza el contenido de una memoria existente. KnowledgeOS nunca edita in-place: crea " +
        "una versión nueva y marca la anterior como 'superseded', preservando el historial.",
      inputSchema: {
        memory_id: z.string().describe("UUID de la memoria activa a reemplazar"),
        content: z.string().describe("El contenido nuevo y correcto"),
      },
    },
    async ({ memory_id, content }) => {
      let res: Response;
      try {
        res = await apiFetch(`/memories/${memory_id}`, { method: "PATCH", body: JSON.stringify({ content }) });
      } catch (exc) {
        return textResult({ error: connectionErrorMessage(config.KNOWLEDGEOS_API_URL, exc) });
      }
      if (res.status === 401) return textResult({ error: authErrorMessage(config.KNOWLEDGEOS_API_URL) });
      if (res.status === 404) return textResult({ error: `No existe ninguna memoria con id '${memory_id}'.` });
      if (res.status === 409) {
        const detail = (await readJson(res).catch(() => ({}))).detail ?? "";
        return textResult({ error: `No se pudo actualizar: ${detail}` });
      }
      if (!res.ok) return textResult({ error: await httpErrorMessage(res) });

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
        res = await apiFetch(`/memories/${memory_id}?hard=${hard}`, { method: "DELETE" });
      } catch (exc) {
        return textResult({ error: connectionErrorMessage(config.KNOWLEDGEOS_API_URL, exc) });
      }
      if (res.status === 401) return textResult({ error: authErrorMessage(config.KNOWLEDGEOS_API_URL) });
      if (res.status === 404) return textResult({ error: `No existe ninguna memoria con id '${memory_id}'.` });
      if (!res.ok) return textResult({ error: await httpErrorMessage(res) });

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
        res = await apiFetch(`/memories/${from_memory_id}/edges`, {
          method: "POST",
          body: JSON.stringify({ to_memory: to_memory_id, relation, note: note ?? null }),
        });
      } catch (exc) {
        return textResult({ error: connectionErrorMessage(config.KNOWLEDGEOS_API_URL, exc) });
      }
      if (res.status === 401) return textResult({ error: authErrorMessage(config.KNOWLEDGEOS_API_URL) });
      if (res.status === 404) {
        const detail = (await readJson(res).catch(() => ({}))).detail;
        return textResult({ error: `KnowledgeOS no encontró alguna de las dos memorias: ${detail}` });
      }
      if (res.status === 409) {
        const detail = (await readJson(res).catch(() => ({}))).detail;
        return textResult({ error: `Esa relación ya existe: ${detail}` });
      }
      if (res.status === 422) {
        const detail = (await readJson(res).catch(() => ({}))).detail;
        return textResult({ error: `Datos inválidos: ${detail}` });
      }
      if (!res.ok) return textResult({ error: await httpErrorMessage(res) });

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
        res = await apiFetch(`/memories/${memory_id}/related?${params}`);
      } catch (exc) {
        return textResult({ error: connectionErrorMessage(config.KNOWLEDGEOS_API_URL, exc) });
      }
      if (res.status === 401) return textResult({ error: authErrorMessage(config.KNOWLEDGEOS_API_URL) });
      if (res.status === 404) return textResult({ error: `No existe ninguna memoria con id '${memory_id}'.` });
      if (res.status === 422) {
        const detail = (await readJson(res).catch(() => ({}))).detail;
        return textResult({ error: `relation inválida: ${detail}` });
      }
      if (!res.ok) return textResult({ error: await httpErrorMessage(res) });

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
        res = await apiFetch(`/timeline?${params}`);
      } catch (exc) {
        return textResult({ error: connectionErrorMessage(config.KNOWLEDGEOS_API_URL, exc) });
      }
      if (res.status === 401) return textResult({ error: authErrorMessage(config.KNOWLEDGEOS_API_URL) });
      if (res.status === 422) {
        const detail = (await readJson(res).catch(() => ({}))).detail;
        return textResult({ error: `KnowledgeOS rechazó la consulta: ${detail}` });
      }
      if (!res.ok) return textResult({ error: await httpErrorMessage(res) });

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
        res = await apiFetch("/contexts");
      } catch (exc) {
        return textResult({ error: connectionErrorMessage(config.KNOWLEDGEOS_API_URL, exc) });
      }
      if (res.status === 401) return textResult({ error: authErrorMessage(config.KNOWLEDGEOS_API_URL) });
      if (!res.ok) return textResult({ error: await httpErrorMessage(res) });

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
        res = await apiFetch("/contexts", { method: "POST", body: JSON.stringify(body) });
      } catch (exc) {
        return textResult({ error: connectionErrorMessage(config.KNOWLEDGEOS_API_URL, exc) });
      }
      if (res.status === 401) return textResult({ error: authErrorMessage(config.KNOWLEDGEOS_API_URL) });
      if (res.status === 409) return textResult({ error: `Ya existe un contexto con slug '${slug}'.` });
      if (!res.ok) return textResult({ error: await httpErrorMessage(res) });

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
        res = await apiFetch("/stats");
      } catch (exc) {
        return textResult({ error: connectionErrorMessage(config.KNOWLEDGEOS_API_URL, exc) });
      }
      if (res.status === 401) return textResult({ error: authErrorMessage(config.KNOWLEDGEOS_API_URL) });
      if (!res.ok) return textResult({ error: await httpErrorMessage(res) });

      return textResult({ stats: await readJson(res) });
    },
  );

  return server;
}

function loadCerebroEntry(): LocalMcpEntry | null {
  const config = loadKnowledgeosConfig();
  if (!config) return null;

  return {
    kind: "local",
    name: "cerebro",
    path: "/cerebro",
    createServer: () => createKnowledgeosServer(config),
  };
}

export const cerebroEntry = loadCerebroEntry();

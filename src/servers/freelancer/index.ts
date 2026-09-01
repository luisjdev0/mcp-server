import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { LocalMcpEntry } from "../../registry/types.js";
import { logger } from "../../logger.js";

/**
 * Integra Freelancer.com (buscar/pujar proyectos, mensajes, skills y perfiles de
 * especialidad). Existe un servidor de terceros para esto (npm `freelancer-mcp-server`,
 * github.com/godesigntech/freelancer-mcp-server, MIT), pero es stdio-only -- igual que
 * cerebro-mcp -- así que en vez de correrlo como sidecar con un bridge stdio→HTTP, esta
 * carpeta es un port 1:1 de sus mismas tools (mismos nombres/schemas/endpoints) hablando
 * HTTP directo contra la API pública de freelancer.com (`kind: "local"`, sin dependencia
 * del paquete de terceros ni contenedor extra). Auditado línea por línea antes de portarlo:
 * la única base URL que toca es freelancer.com/api, sin telemetría ni llamadas a terceros.
 *
 * El token va en el header propio de Freelancer (`freelancer-oauth-v1`), NO en
 * `Authorization` -- ese header lo consume nuestro propio `requireAuth` antes de llegar
 * aquí (ver auth/middleware.ts), así que nunca se mezclan.
 */

const FREELANCER_API_BASE = "https://www.freelancer.com/api";
const CHARACTER_LIMIT = 8000;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const REQUEST_TIMEOUT_MS = 15_000;

interface FreelancerApiResponse<T> {
  status: string;
  result: T;
  request_id?: string;
  error_code?: string;
  message?: string;
}

interface FreelancerUser {
  [key: string]: unknown;
  id: number;
  username: string;
  display_name: string;
  role?: string;
  reputation?: { entire_history?: { overall?: number; reviews?: number } };
  location?: { country?: { name?: string }; city?: string };
  registration_date?: number;
  jobs?: Array<{ name: string }>;
  hourly_rate?: number;
  earnings?: { earnings?: number };
  tagline?: string;
}

interface FreelancerProject {
  [key: string]: unknown;
  id: number;
  title: string;
  description?: string;
  status: string;
  type: string;
  budget?: { minimum?: number; maximum?: number; currency_code?: string };
  bid_stats?: { bid_count?: number; bid_avg?: number };
  time_submitted?: number;
  time_updated?: number;
  jobs?: Array<{ name: string }>;
}

interface FreelancerBid {
  [key: string]: unknown;
  id: number;
  project_id: number;
  amount: number;
  period: number;
  description: string;
  status: string;
  time_submitted?: number;
  reputation?: { overall?: number };
  bidder?: FreelancerUser;
}

interface FreelancerMilestone {
  [key: string]: unknown;
  id: number;
  amount: number;
  description: string;
  status: string;
  time_created?: number;
  time_updated?: number;
  currency?: { code?: string };
}

interface FreelancerMessage {
  [key: string]: unknown;
  id: number;
  from_user: number;
  message: string;
  time_created?: number;
  attachments?: Array<{ filename: string; url: string }>;
}

interface FreelancerThread {
  [key: string]: unknown;
  id: number;
  thread?: {
    thread_type?: string;
    members?: number[];
    context?: { type?: string; id?: number };
  };
  message_count?: number;
  time_updated?: number;
}

interface FreelancerJob {
  id: number;
  name: string;
  category?: { id: number; name: string };
}

/**
 * Formato de FREELANCER_ACCOUNTS: igual al del paquete original, un JSON
 * `{"etiqueta": "token", ...}`. Para una sola cuenta, FREELANCER_OAUTH_TOKEN
 * basta y se registra bajo la etiqueta "default".
 */
function loadAccounts(): Map<string, string> | null {
  const accounts = new Map<string, string>();
  const multi = process.env.FREELANCER_ACCOUNTS;
  const single = process.env.FREELANCER_OAUTH_TOKEN;

  if (multi) {
    try {
      const parsed = JSON.parse(multi) as Record<string, string>;
      for (const [label, token] of Object.entries(parsed)) {
        if (token) accounts.set(label, token);
      }
    } catch {
      logger.warn('MCP "freelancer" deshabilitado: FREELANCER_ACCOUNTS no es JSON válido.');
      return null;
    }
  } else if (single) {
    accounts.set("default", single);
  }

  if (accounts.size === 0) {
    logger.warn(
      'MCP "freelancer" deshabilitado: define FREELANCER_OAUTH_TOKEN (una cuenta) o ' +
        'FREELANCER_ACCOUNTS (JSON \'{"etiqueta":"token"}\', varias cuentas) para activarlo.',
    );
    return null;
  }
  return accounts;
}

const ACCOUNT_DESC =
  "Which configured Freelancer account to use (see freelancer_list_accounts for labels). Omit to use your default/only account.";

export function createFreelancerServer(accounts: Map<string, string>): McpServer {
  const server = new McpServer({ name: "freelancer", version: "1.0.0" });
  const defaultAccount = accounts.keys().next().value as string;

  // Estado por sesión (una instancia de McpServer por sesión, igual que cerebro):
  // catálogo de skills (~3000 entradas, dato público) cacheado tras la primera consulta.
  let jobCatalogue: FreelancerJob[] | null = null;

  function resolveToken(account?: string): string {
    const label = account || defaultAccount;
    const token = accounts.get(label);
    if (!token) {
      throw new Error(
        `Unknown account "${label}". Configured accounts: ${Array.from(accounts.keys()).join(", ") || "none"}. ` +
          "Use freelancer_list_accounts to see what's available.",
      );
    }
    return token;
  }

  async function freelancerFetch(
    path: string,
    init: Omit<RequestInit, "headers"> & { account?: string; headers?: Record<string, string> } = {},
  ): Promise<Response> {
    const { account, headers, ...rest } = init;
    const token = resolveToken(account);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await fetch(`${FREELANCER_API_BASE}${path}`, {
        ...rest,
        signal: controller.signal,
        headers: { "freelancer-oauth-v1": token, ...headers },
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  function buildQuery(params?: Record<string, unknown>): string {
    if (!params) return "";
    const usp = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) {
        for (const v of value) usp.append(`${key}[]`, String(v));
      } else {
        usp.append(key, String(value));
      }
    }
    const qs = usp.toString();
    return qs ? `?${qs}` : "";
  }

  function buildForm(arrayParams: Record<string, Array<string | number>>, scalarParams: Record<string, unknown> = {}): string {
    const body = new URLSearchParams();
    for (const [key, values] of Object.entries(arrayParams)) {
      for (const v of values) body.append(`${key}[]`, String(v));
    }
    for (const [key, value] of Object.entries(scalarParams)) {
      if (value === undefined || value === null) continue;
      body.append(key, String(value));
    }
    return body.toString();
  }

  async function unwrap<T>(res: Response): Promise<T> {
    if (res.status === 401) {
      throw new Error("Freelancer API rejected the authentication (401). Check the token configured for this account.");
    }
    let data: FreelancerApiResponse<T> | undefined;
    try {
      // Response.json() tipa como Promise<unknown> con el lib config de este proyecto
      // (ver la misma nota en servers/cerebro/index.ts); todo caller aquí ya maneja el
      // shape ApiResponse<T> de Freelancer.
      data = (await res.json()) as FreelancerApiResponse<T>;
    } catch {
      // sin body JSON, cae al mensaje genérico de abajo
    }
    if (!res.ok || !data || data.status !== "success") {
      const detail = data?.message || data?.error_code || res.statusText;
      throw new Error(`Freelancer API error (${res.status}): ${detail}`);
    }
    return data.result;
  }

  function connectionError(exc: unknown): Error {
    return new Error(`Could not connect to freelancer.com: ${String(exc)}`);
  }

  async function apiGet<T>(path: string, params?: Record<string, unknown>, account?: string): Promise<T> {
    let res: Response;
    try {
      res = await freelancerFetch(`${path}${buildQuery(params)}`, { account });
    } catch (exc) {
      throw connectionError(exc);
    }
    return unwrap<T>(res);
  }

  async function apiPostJson<T>(path: string, body: Record<string, unknown>, account?: string): Promise<T> {
    let res: Response;
    try {
      res = await freelancerFetch(path, {
        method: "POST",
        account,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (exc) {
      throw connectionError(exc);
    }
    return unwrap<T>(res);
  }

  async function apiPostForm<T>(path: string, body: Record<string, unknown>, account?: string): Promise<T> {
    let res: Response;
    try {
      res = await freelancerFetch(path, {
        method: "POST",
        account,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: buildForm({}, body),
      });
    } catch (exc) {
      throw connectionError(exc);
    }
    return unwrap<T>(res);
  }

  async function apiPutJson<T>(path: string, body: Record<string, unknown>, account?: string): Promise<T> {
    let res: Response;
    try {
      res = await freelancerFetch(path, {
        method: "PUT",
        account,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (exc) {
      throw connectionError(exc);
    }
    return unwrap<T>(res);
  }

  /** Endpoints de skills: siempre form-urlencoded con arrays repetidos (`jobs[]=1&jobs[]=2`). */
  async function apiForm<T>(
    method: "POST" | "PUT" | "DELETE",
    path: string,
    arrayParams: Record<string, Array<string | number>>,
    account?: string,
  ): Promise<T> {
    let res: Response;
    try {
      res = await freelancerFetch(path, {
        method,
        account,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: buildForm(arrayParams),
      });
    } catch (exc) {
      throw connectionError(exc);
    }
    return unwrap<T>(res);
  }

  function truncate(text: string, limit: number): string {
    if (text.length <= limit) return text;
    return text.slice(0, limit) + `\n\n[Truncated — ${text.length - limit} characters omitted]`;
  }

  function formatDate(unix?: number): string {
    if (!unix) return "unknown";
    return new Date(unix * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  }

  function mcpError(message: string) {
    return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true as const };
  }

  function resolveThreadId(input: string | number): number {
    if (typeof input === "number") return input;
    const trimmed = input.trim();
    if (/^\d+$/.test(trimmed)) return Number(trimmed);
    const match = trimmed.match(/(\d+)(?:\D*)?$/) || trimmed.match(/thread[s]?[/=](\d+)/i);
    if (match) return Number(match[1]);
    throw new Error(`Could not extract a thread ID from "${input}". Pass a numeric thread ID or a Freelancer chat link.`);
  }

  async function getJobCatalogue(account?: string): Promise<FreelancerJob[]> {
    if (jobCatalogue) return jobCatalogue;
    jobCatalogue = await apiGet<FreelancerJob[]>("/projects/0.1/jobs/", undefined, account);
    return jobCatalogue;
  }

  async function resolveSkillIds(skills: Array<string | number>, account?: string): Promise<number[]> {
    const catalogue = await getJobCatalogue(account);
    const byName = new Map<string, number>();
    for (const j of catalogue) byName.set(j.name.toLowerCase(), j.id);

    const ids: number[] = [];
    const unmatched: string[] = [];
    for (const s of skills) {
      if (typeof s === "number" || /^\d+$/.test(String(s))) {
        ids.push(Number(s));
        continue;
      }
      const key = String(s).trim().toLowerCase();
      const exact = byName.get(key);
      if (exact !== undefined) {
        ids.push(exact);
        continue;
      }
      const matches = catalogue.filter((j) => j.name.toLowerCase().includes(key));
      if (matches.length === 1) {
        ids.push(matches[0].id);
      } else {
        unmatched.push(String(s));
      }
    }
    if (unmatched.length) {
      throw new Error(
        `Could not resolve these skills to a single match: ${unmatched.join(", ")}. ` +
          "Use freelancer_search_skills to find the exact name or numeric ID.",
      );
    }
    return Array.from(new Set(ids));
  }

  // =============================================================================== formatters

  function formatProjectSummary(p: FreelancerProject, index: number): string {
    const budget = p.budget
      ? `$${p.budget.minimum ?? "?"}–$${p.budget.maximum ?? "?"} ${p.budget.currency_code ?? "USD"}`
      : "Budget TBD";
    const skills = p.jobs?.map((j) => j.name).join(", ") || "";
    return [
      `**${index}. [${p.id}] ${p.title}**`,
      `   Status: ${p.status} | Type: ${p.type} | Budget: ${budget}`,
      `   Bids: ${p.bid_stats?.bid_count ?? 0} (avg $${p.bid_stats?.bid_avg?.toFixed(0) ?? "?"})`,
      skills ? `   Skills: ${skills}` : "",
      `   Posted: ${formatDate(p.time_submitted)}`,
      "",
    ]
      .filter((l) => l !== "")
      .join("\n");
  }

  function formatProjectFull(p: FreelancerProject): string {
    const budget = p.budget
      ? `$${p.budget.minimum ?? "?"}–$${p.budget.maximum ?? "?"} ${p.budget.currency_code ?? "USD"}`
      : "Budget TBD";
    const skills = p.jobs?.map((j) => j.name).join(", ") || "none";
    return [
      `## [${p.id}] ${p.title}`,
      "",
      `**Status:** ${p.status} | **Type:** ${p.type} | **Budget:** ${budget}`,
      `**Posted:** ${formatDate(p.time_submitted)} | **Updated:** ${formatDate(p.time_updated)}`,
      `**Bids:** ${p.bid_stats?.bid_count ?? 0} (avg $${p.bid_stats?.bid_avg?.toFixed(0) ?? "?"})`,
      `**Skills:** ${skills}`,
      "",
      "### Description",
      p.description || "No description provided.",
    ].join("\n");
  }

  function formatBid(b: FreelancerBid, index: number): string {
    const bidder = b.bidder;
    return [
      `**${index}. Bid #${b.id}** — $${b.amount} / ${b.period} days`,
      `   Status: ${b.status} | Submitted: ${formatDate(b.time_submitted)}`,
      bidder ? `   Bidder: @${bidder.username} (${bidder.display_name}) ⭐ ${b.reputation?.overall?.toFixed(2) ?? "N/A"}` : "",
      b.description ? `   Proposal: ${b.description.slice(0, 200)}${b.description.length > 200 ? "..." : ""}` : "",
      "",
    ]
      .filter((l) => l !== "")
      .join("\n");
  }

  function formatMilestone(m: FreelancerMilestone, index: number): string {
    return [
      `**${index}. Milestone #${m.id}** — $${m.amount} ${m.currency?.code ?? ""}`,
      `   Status: ${m.status}`,
      `   Description: ${m.description || "N/A"}`,
      `   Created: ${formatDate(m.time_created)} | Updated: ${formatDate(m.time_updated)}`,
      "",
    ].join("\n");
  }

  function formatThread(t: FreelancerThread, index: number): string {
    const ctx = t.thread?.context;
    const ctxLabel = ctx?.type
      ? `${ctx.type}${ctx.id ? ` — ${ctx.type === "project" ? "Project " : ""}${ctx.id}` : ""}`
      : t.thread?.thread_type ?? "chat";
    const members = t.thread?.members ?? [];
    return [
      `**${index}. Thread #${t.id}** (${ctxLabel})`,
      `   Members: ${members.length ? members.join(", ") : "unknown"} | Messages: ${t.message_count ?? "?"}`,
      `   Updated: ${formatDate(t.time_updated)}`,
      "",
    ].join("\n");
  }

  function formatMessage(m: FreelancerMessage): string {
    const attachmentNote = m.attachments?.length
      ? `\n   📎 Attachments: ${m.attachments.map((a) => a.filename).join(", ")}`
      : "";
    return [`[${formatDate(m.time_created)}] **User ${m.from_user}:**`, m.message, attachmentNote, ""].join("\n");
  }

  function formatUserProfile(user: FreelancerUser): string {
    const skills = user.jobs?.map((j) => j.name).join(", ") || "none listed";
    const rep = user.reputation?.entire_history;
    const loc = user.location;
    return [
      `**${user.display_name}** (@${user.username})`,
      user.tagline ? `_${user.tagline}_` : "",
      "",
      `📍 ${loc?.city || ""}${loc?.city && loc?.country?.name ? ", " : ""}${loc?.country?.name || "Unknown"}`,
      `⭐ Reputation: ${rep?.overall?.toFixed(2) ?? "N/A"} (${rep?.reviews ?? 0} reviews)`,
      user.hourly_rate ? `💰 Hourly rate: $${user.hourly_rate}/hr` : "",
      user.earnings?.earnings ? `💵 Total earnings: $${user.earnings.earnings.toLocaleString()}` : "",
      `🗓️ Registered: ${formatDate(user.registration_date)}`,
      `🛠️ Skills: ${skills}`,
    ]
      .filter(Boolean)
      .join("\n");
  }

  // =============================================================================== meta

  server.registerTool(
    "freelancer_list_accounts",
    {
      title: "List Configured Accounts",
      description:
        "List the Freelancer.com account labels configured on this MCP server (never the tokens " +
        "themselves). Use this to discover which `account` value to pass to other tools when " +
        "multiple Freelancer profiles are connected (e.g. your own account plus one or more " +
        "clients' accounts).",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const labels = Array.from(accounts.keys());
      const lines = [
        `**Configured accounts** (${labels.length}):`,
        "",
        ...labels.map((a, i) => `${i + 1}. \`${a}\`${i === 0 ? " (default)" : ""}`),
      ];
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        structuredContent: { accounts: labels, default: labels[0] ?? null },
      };
    },
  );

  // =============================================================================== profile

  server.registerTool(
    "freelancer_get_self",
    {
      title: "Get My Profile",
      description:
        "Retrieve your own Freelancer.com profile, including reputation, earnings, skills, " +
        "location and stats.",
      inputSchema: { account: z.string().optional().describe(ACCOUNT_DESC) },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ account }) => {
      try {
        const user = await apiGet<FreelancerUser>(
          "/users/0.1/self",
          { avatar: true, reputation: true, jobs: true, location_details: true, earnings: true },
          account,
        );
        return {
          content: [{ type: "text", text: truncate(formatUserProfile(user), CHARACTER_LIMIT) }],
          structuredContent: user,
        };
      } catch (err) {
        return mcpError((err as Error).message);
      }
    },
  );

  server.registerTool(
    "freelancer_get_user",
    {
      title: "Get User Profile",
      description:
        "Retrieve a Freelancer.com user profile by username or user ID. Provide at least one of " +
        "username or user_id.",
      inputSchema: {
        username: z.string().optional().describe("Freelancer username"),
        user_id: z.number().int().optional().describe("Numeric user ID"),
        account: z.string().optional().describe(ACCOUNT_DESC),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ username, user_id, account }) => {
      if (!username && !user_id) return mcpError("Provide either username or user_id.");
      try {
        const params: Record<string, unknown> = { avatar: true, reputation: true, jobs: true, location_details: true };
        if (username) params.usernames = [username];
        if (user_id) params.ids = [user_id];

        const result = await apiGet<{ users: Record<string, FreelancerUser> }>("/users/0.1/users", params, account);
        const users = Object.values(result.users);
        if (!users.length) return mcpError("User not found.");

        const text = users.map(formatUserProfile).join("\n\n---\n\n");
        return { content: [{ type: "text", text: truncate(text, CHARACTER_LIMIT) }], structuredContent: users[0] };
      } catch (err) {
        return mcpError((err as Error).message);
      }
    },
  );

  // =============================================================================== projects

  server.registerTool(
    "freelancer_search_projects",
    {
      title: "Search Projects",
      description:
        "Search for projects/jobs on Freelancer.com by keyword, budget or project type. Results " +
        "are ordered newest-first, so this also answers \"what are the latest projects?\".",
      inputSchema: {
        query: z.string().optional().describe("Search keywords"),
        project_type: z.enum(["fixed", "hourly"]).optional().describe("Project type"),
        min_budget: z.number().optional().describe("Minimum budget in USD"),
        max_budget: z.number().optional().describe("Maximum budget in USD"),
        limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT).describe("Number of results (max 50)"),
        offset: z.number().int().min(0).default(0).describe("Pagination offset"),
        account: z.string().optional().describe(ACCOUNT_DESC),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ query, project_type, min_budget, max_budget, limit, offset, account }) => {
      try {
        const params: Record<string, unknown> = { limit, offset, full_description: false, job_details: true, upgrade_details: true };
        if (query) params.query = query;
        if (project_type) params.project_types = [project_type];
        if (min_budget !== undefined) params.min_price = min_budget;
        if (max_budget !== undefined) params.max_price = max_budget;

        const result = await apiGet<{ projects: FreelancerProject[]; total_count: number }>(
          "/projects/0.1/projects/active",
          params,
          account,
        );
        if (!result.projects?.length) return { content: [{ type: "text", text: "No projects found matching your criteria." }] };

        const lines = [
          `**Found ${result.total_count} projects** (showing ${result.projects.length}):`,
          "",
          ...result.projects.map((p, i) => formatProjectSummary(p, i + 1)),
        ];
        return {
          content: [{ type: "text", text: truncate(lines.join("\n"), CHARACTER_LIMIT) }],
          structuredContent: { total: result.total_count, projects: result.projects },
        };
      } catch (err) {
        return mcpError((err as Error).message);
      }
    },
  );

  server.registerTool(
    "freelancer_get_project",
    {
      title: "Get Project Details",
      description: "Get full details of a specific Freelancer.com project by ID.",
      inputSchema: {
        project_id: z.number().int().positive().describe("Numeric Freelancer project ID"),
        account: z.string().optional().describe(ACCOUNT_DESC),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ project_id, account }) => {
      try {
        const result = await apiGet<{ projects: Record<string, FreelancerProject> }>(
          "/projects/0.1/projects",
          { ids: [project_id], full_description: true, job_details: true, upgrade_details: true },
          account,
        );
        const project = Object.values(result.projects)[0];
        if (!project) return mcpError(`Project ${project_id} not found.`);
        return {
          content: [{ type: "text", text: truncate(formatProjectFull(project), CHARACTER_LIMIT) }],
          structuredContent: project,
        };
      } catch (err) {
        return mcpError((err as Error).message);
      }
    },
  );

  server.registerTool(
    "freelancer_my_projects",
    {
      title: "List My Projects",
      description:
        "List projects you own or are working on as a freelancer. To analyze past performance " +
        '("what are my winning strategies?"), call this with status "complete" and pair it with ' +
        'freelancer_my_bids (status "awarded") — reason over the combined results yourself.',
      inputSchema: {
        role: z.enum(["owner", "freelancer"]).default("freelancer").describe("owner = posted by you, freelancer = hired on"),
        status: z.enum(["active", "complete", "closed"]).optional().describe("Filter by project status"),
        limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT).describe("Number of results"),
        offset: z.number().int().min(0).default(0).describe("Pagination offset"),
        account: z.string().optional().describe(ACCOUNT_DESC),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ role, status, limit, offset, account }) => {
      try {
        const self = await apiGet<{ id: number }>("/users/0.1/self", undefined, account);
        const params: Record<string, unknown> = { limit, offset, full_description: false, job_details: true };
        if (role === "owner") params.owners = [self.id];
        else params.freelancers = [self.id];
        if (status) params.statuses = [status];

        const result = await apiGet<{ projects: FreelancerProject[]; total_count: number }>("/projects/0.1/projects", params, account);
        if (!result.projects?.length) return { content: [{ type: "text", text: "No projects found." }] };

        const lines = [
          `**Your projects as ${role}** — ${result.total_count} total (showing ${result.projects.length}):`,
          "",
          ...result.projects.map((p, i) => formatProjectSummary(p, i + 1)),
        ];
        return {
          content: [{ type: "text", text: truncate(lines.join("\n"), CHARACTER_LIMIT) }],
          structuredContent: { total: result.total_count, projects: result.projects },
        };
      } catch (err) {
        return mcpError((err as Error).message);
      }
    },
  );

  // =============================================================================== bids

  server.registerTool(
    "freelancer_get_project_bids",
    {
      title: "Get Project Bids",
      description: "List all bids on a specific Freelancer.com project.",
      inputSchema: {
        project_id: z.number().int().positive().describe("Numeric project ID"),
        limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT).describe("Number of bids"),
        offset: z.number().int().min(0).default(0).describe("Pagination offset"),
        account: z.string().optional().describe(ACCOUNT_DESC),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ project_id, limit, offset, account }) => {
      try {
        const result = await apiGet<{ bids: FreelancerBid[]; total_count: number }>(
          "/projects/0.1/bids",
          { project_ids: [project_id], limit, offset, reputation_details: true, bidder_details: true },
          account,
        );
        if (!result.bids?.length) return { content: [{ type: "text", text: `No bids found for project ${project_id}.` }] };

        const lines = [
          `**Bids on project ${project_id}** — ${result.total_count} total (showing ${result.bids.length}):`,
          "",
          ...result.bids.map((b, i) => formatBid(b, i + 1)),
        ];
        return {
          content: [{ type: "text", text: truncate(lines.join("\n"), CHARACTER_LIMIT) }],
          structuredContent: { total: result.total_count, bids: result.bids },
        };
      } catch (err) {
        return mcpError((err as Error).message);
      }
    },
  );

  server.registerTool(
    "freelancer_my_bids",
    {
      title: "List My Bids",
      description:
        "List bids you have placed on Freelancer.com projects. To analyze your winning strategy, " +
        'call this twice — once with status "awarded" and once with status "rejected" — and ' +
        "compare amount, period and proposal style across the two sets yourself.",
      inputSchema: {
        status: z.enum(["active", "awarded", "revoked", "rejected"]).optional().describe("Filter by bid status"),
        limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT).describe("Number of results"),
        offset: z.number().int().min(0).default(0).describe("Pagination offset"),
        account: z.string().optional().describe(ACCOUNT_DESC),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ status, limit, offset, account }) => {
      try {
        const self = await apiGet<{ id: number }>("/users/0.1/self", undefined, account);
        const params: Record<string, unknown> = { bidder_ids: [self.id], limit, offset, project_details: true };
        if (status) params.statuses = [status];

        const result = await apiGet<{ bids: FreelancerBid[]; total_count: number }>("/projects/0.1/bids", params, account);
        if (!result.bids?.length) return { content: [{ type: "text", text: "No bids found." }] };

        const lines = [
          `**Your bids** — ${result.total_count} total (showing ${result.bids.length}):`,
          "",
          ...result.bids.map((b, i) => formatBid(b, i + 1)),
        ];
        return {
          content: [{ type: "text", text: truncate(lines.join("\n"), CHARACTER_LIMIT) }],
          structuredContent: { total: result.total_count, bids: result.bids },
        };
      } catch (err) {
        return mcpError((err as Error).message);
      }
    },
  );

  server.registerTool(
    "freelancer_place_bid",
    {
      title: "Place a Bid",
      description:
        "Submit a bid / proposal on a Freelancer.com project. ⚠️ This creates a real bid on your " +
        "account. Review before confirming — including which account, when multiple are configured.",
      inputSchema: {
        project_id: z.number().int().positive().describe("Project ID to bid on"),
        amount: z.number().positive().describe("Bid amount in project currency"),
        period: z.number().int().positive().describe("Delivery time in days"),
        description: z.string().min(10).max(5000).describe("Proposal / cover letter text"),
        milestone_percentage: z
          .number()
          .int()
          .min(0)
          .max(100)
          .default(100)
          .describe("Percentage to request as initial milestone (default 100)"),
        account: z.string().optional().describe(ACCOUNT_DESC + " This is the account the bid is placed FROM."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ project_id, amount, period, description, milestone_percentage, account }) => {
      try {
        const result = await apiPostJson<FreelancerBid>(
          "/projects/0.1/bids",
          { project_id, amount, period, description, milestone_percentage },
          account,
        );
        return {
          content: [
            {
              type: "text",
              text: [
                "✅ **Bid placed successfully!**",
                `Bid ID: ${result.id}`,
                `Project: ${project_id}`,
                `Amount: $${amount} | Delivery: ${period} days`,
                `Status: ${result.status}`,
                `Submitted: ${formatDate(result.time_submitted)}`,
              ].join("\n"),
            },
          ],
          structuredContent: result,
        };
      } catch (err) {
        return mcpError((err as Error).message);
      }
    },
  );

  // =============================================================================== milestones

  server.registerTool(
    "freelancer_get_milestones",
    {
      title: "Get Project Milestones",
      description:
        "List milestones for a specific Freelancer.com project. Milestone statuses include: " +
        "created, requested, pending, released, cancelled.",
      inputSchema: {
        project_id: z.number().int().positive().describe("Project ID to fetch milestones for"),
        account: z.string().optional().describe(ACCOUNT_DESC),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ project_id, account }) => {
      try {
        const result = await apiGet<{ milestones: FreelancerMilestone[] }>(
          "/projects/0.1/milestones",
          { project_ids: [project_id] },
          account,
        );
        if (!result.milestones?.length) return { content: [{ type: "text", text: `No milestones found for project ${project_id}.` }] };

        const lines = [
          `**Milestones for project ${project_id}** (${result.milestones.length} total):`,
          "",
          ...result.milestones.map((m, i) => formatMilestone(m, i + 1)),
        ];
        return {
          content: [{ type: "text", text: truncate(lines.join("\n"), CHARACTER_LIMIT) }],
          structuredContent: { milestones: result.milestones },
        };
      } catch (err) {
        return mcpError((err as Error).message);
      }
    },
  );

  // =============================================================================== messages

  server.registerTool(
    "freelancer_list_threads",
    {
      title: "List Message Threads",
      description: "List your Freelancer.com inbox message threads.",
      inputSchema: {
        context_type: z.enum(["project", "freelancer_dashboard"]).optional().describe("Thread context type"),
        limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT).describe("Number of threads"),
        offset: z.number().int().min(0).default(0).describe("Pagination offset"),
        account: z.string().optional().describe(ACCOUNT_DESC),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ context_type, limit, offset, account }) => {
      try {
        const params: Record<string, unknown> = { limit, offset };
        if (context_type) params.context_types = [context_type];

        const result = await apiGet<{ threads: FreelancerThread[]; total_count: number }>("/messages/0.1/threads", params, account);
        if (!result.threads?.length) return { content: [{ type: "text", text: "No message threads found." }] };

        const lines = [
          `**Your inbox** — ${result.total_count} threads (showing ${result.threads.length}):`,
          "",
          ...result.threads.map((t, i) => formatThread(t, i + 1)),
        ];
        return {
          content: [{ type: "text", text: truncate(lines.join("\n"), CHARACTER_LIMIT) }],
          structuredContent: { total: result.total_count, threads: result.threads },
        };
      } catch (err) {
        return mcpError((err as Error).message);
      }
    },
  );

  server.registerTool(
    "freelancer_get_messages",
    {
      title: "Get Thread Messages",
      description:
        "Retrieve messages from a specific Freelancer.com thread. Accepts a numeric thread ID, or " +
        "a pasted Freelancer chat/message link (the ID is extracted either way).",
      inputSchema: {
        thread_id: z.union([z.number().int().positive(), z.string().min(1)]).describe("Thread ID, or a chat link containing one"),
        limit: z.number().int().min(1).max(MAX_LIMIT).default(20).describe("Number of messages"),
        offset: z.number().int().min(0).default(0).describe("Pagination offset"),
        account: z.string().optional().describe(ACCOUNT_DESC),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ thread_id: threadIdInput, limit, offset, account }) => {
      try {
        const thread_id = resolveThreadId(threadIdInput);
        const result = await apiGet<{ messages: FreelancerMessage[]; total_count: number }>(
          "/messages/0.1/messages",
          { threads: [thread_id], limit, offset },
          account,
        );
        if (!result.messages?.length) return { content: [{ type: "text", text: `No messages found in thread ${thread_id}.` }] };

        const lines = [
          `**Thread ${thread_id}** — ${result.total_count} messages (showing ${result.messages.length}):`,
          "",
          ...result.messages.map((m) => formatMessage(m)),
        ];
        return {
          content: [{ type: "text", text: truncate(lines.join("\n"), CHARACTER_LIMIT) }],
          structuredContent: { total: result.total_count, messages: result.messages },
        };
      } catch (err) {
        return mcpError((err as Error).message);
      }
    },
  );

  server.registerTool(
    "freelancer_send_message",
    {
      title: "Send Message",
      description:
        "Send a message in an existing Freelancer.com thread. ⚠️ This sends a real message from " +
        "your account.",
      inputSchema: {
        thread_id: z.union([z.number().int().positive(), z.string().min(1)]).describe("Thread ID to reply to, or a chat link containing one"),
        message: z.string().min(1).max(5000).describe("Message text to send"),
        account: z.string().optional().describe(ACCOUNT_DESC + " This is the account the message is sent FROM."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ thread_id: threadIdInput, message, account }) => {
      try {
        const thread_id = resolveThreadId(threadIdInput);
        const result = await apiPostForm<FreelancerMessage>(`/messages/0.1/threads/${thread_id}/messages`, { message }, account);
        return {
          content: [
            {
              type: "text",
              text: ["✅ **Message sent!**", `Message ID: ${result.id}`, `Thread: ${thread_id}`, `Sent: ${formatDate(result.time_created)}`].join(
                "\n",
              ),
            },
          ],
          structuredContent: result,
        };
      } catch (err) {
        return mcpError((err as Error).message);
      }
    },
  );

  // =============================================================================== skills

  server.registerTool(
    "freelancer_search_skills",
    {
      title: "Search Skills",
      description:
        "Search the Freelancer.com skill (job) catalogue by name. Use this to find the numeric " +
        "skill IDs needed by the skill-management tools.",
      inputSchema: {
        query: z.string().min(1).describe("Substring to match against skill names"),
        limit: z.number().int().min(1).max(100).default(25).describe("Max results"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ query, limit }) => {
      try {
        const catalogue = await getJobCatalogue();
        const q = query.trim().toLowerCase();
        const matches = catalogue.filter((j) => j.name.toLowerCase().includes(q)).slice(0, limit);
        if (!matches.length) return { content: [{ type: "text", text: `No skills matched "${query}".` }] };

        const lines = [
          `**Skills matching "${query}"** (${matches.length}):`,
          "",
          ...matches.map((j) => `• ${j.name} — ID ${j.id}${j.category ? ` (${j.category.name})` : ""}`),
        ];
        return { content: [{ type: "text", text: truncate(lines.join("\n"), CHARACTER_LIMIT) }], structuredContent: { skills: matches } };
      } catch (err) {
        return mcpError((err as Error).message);
      }
    },
  );

  server.registerTool(
    "freelancer_list_skills",
    {
      title: "List My Skills",
      description: "List the skills (jobs) currently on your own Freelancer.com profile.",
      inputSchema: { account: z.string().optional().describe(ACCOUNT_DESC) },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ account }) => {
      try {
        const self = await apiGet<{ jobs?: FreelancerJob[] }>("/users/0.1/self", { jobs: true }, account);
        const jobs = self.jobs || [];
        if (!jobs.length) return { content: [{ type: "text", text: "No skills listed on your profile." }] };

        const lines = [`**Your skills** (${jobs.length}):`, "", ...jobs.map((j) => `• ${j.name} — ID ${j.id}${j.category ? ` (${j.category.name})` : ""}`)];
        return {
          content: [{ type: "text", text: truncate(lines.join("\n"), CHARACTER_LIMIT) }],
          structuredContent: { count: jobs.length, skills: jobs },
        };
      } catch (err) {
        return mcpError((err as Error).message);
      }
    },
  );

  server.registerTool(
    "freelancer_add_skills",
    {
      title: "Add Skills",
      description:
        "Add one or more skills (jobs) to your Freelancer.com profile, keeping your existing " +
        "skills. ⚠️ This modifies your real profile. Freelancer caps the max skills per account; " +
        "adding past the limit is rejected by the API.",
      inputSchema: {
        skills: z.array(z.union([z.string(), z.number()])).min(1).describe("Skill names or numeric IDs to add"),
        account: z.string().optional().describe(ACCOUNT_DESC),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ skills, account }) => {
      try {
        const ids = await resolveSkillIds(skills, account);
        await apiForm("POST", "/users/0.1/self/jobs", { jobs: ids }, account);
        return { content: [{ type: "text", text: `✅ Added ${ids.length} skill(s): IDs ${ids.join(", ")}.` }], structuredContent: { added: ids } };
      } catch (err) {
        return mcpError((err as Error).message);
      }
    },
  );

  server.registerTool(
    "freelancer_remove_skills",
    {
      title: "Remove Skills",
      description: "Remove one or more skills (jobs) from your Freelancer.com profile. ⚠️ This modifies your real profile.",
      inputSchema: {
        skills: z.array(z.union([z.string(), z.number()])).min(1).describe("Skill names or numeric IDs to remove"),
        account: z.string().optional().describe(ACCOUNT_DESC),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ skills, account }) => {
      try {
        const ids = await resolveSkillIds(skills, account);
        await apiForm("DELETE", "/users/0.1/self/jobs", { jobs: ids }, account);
        return { content: [{ type: "text", text: `✅ Removed ${ids.length} skill(s): IDs ${ids.join(", ")}.` }], structuredContent: { removed: ids } };
      } catch (err) {
        return mcpError((err as Error).message);
      }
    },
  );

  server.registerTool(
    "freelancer_set_skills",
    {
      title: "Set Skills (Replace All)",
      description:
        "Replace your ENTIRE skill list with the provided skills. Any current skill not in the " +
        "list is removed. ⚠️ Destructive: consider freelancer_list_skills first, and " +
        "freelancer_add_skills if you only want to append.",
      inputSchema: {
        skills: z.array(z.union([z.string(), z.number()])).min(1).describe("Complete replacement set of skill names or IDs"),
        account: z.string().optional().describe(ACCOUNT_DESC),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ skills, account }) => {
      try {
        const ids = await resolveSkillIds(skills, account);
        await apiForm("PUT", "/users/0.1/self/jobs", { jobs: ids }, account);
        return {
          content: [{ type: "text", text: `✅ Skill list replaced — now ${ids.length} skill(s): IDs ${ids.join(", ")}.` }],
          structuredContent: { skills: ids },
        };
      } catch (err) {
        return mcpError((err as Error).message);
      }
    },
  );

  // =============================================================================== specialty profiles

  server.registerTool(
    "freelancer_list_profiles",
    {
      title: "List Specialty Profiles",
      description:
        "Fetch one or more of your Freelancer.com \"specialty profiles\" by their numeric profile " +
        "IDs. Note: Freelancer's API has no endpoint that lists your profile IDs for you — you " +
        "must already know the ID(s) (e.g. from the profile URL).",
      inputSchema: {
        profile_ids: z.array(z.number().int().positive()).min(1).describe("Numeric specialty-profile IDs"),
        account: z.string().optional().describe(ACCOUNT_DESC),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ profile_ids, account }) => {
      try {
        const result = await apiGet<{ profiles: unknown[] }>("/users/0.1/profiles", { ids: profile_ids }, account);
        const profiles = result.profiles || [];
        if (!profiles.length) return { content: [{ type: "text", text: "No profiles found for those IDs." }] };
        return { content: [{ type: "text", text: truncate(JSON.stringify(profiles, null, 2), CHARACTER_LIMIT) }], structuredContent: { profiles } };
      } catch (err) {
        return mcpError((err as Error).message);
      }
    },
  );

  server.registerTool(
    "freelancer_create_profile",
    {
      title: "Create Specialty Profile",
      description:
        "Create a new Freelancer.com \"specialty profile\" (a focused sub-profile, separate from " +
        "your main account profile). All fields are required by the API. ⚠️ Creates real data on " +
        "your account. Freelancer caps the number of specialty profiles; some account types cannot " +
        "create any.",
      inputSchema: {
        profile_name: z.string().min(1).describe("Internal name for the specialty profile"),
        tagline: z.string().min(1).describe("Short headline"),
        hourly_rate: z.number().positive().describe("Hourly rate in USD"),
        description: z.string().min(1).describe("Profile description / bio"),
        skills: z.array(z.union([z.string(), z.number()])).optional().describe("Skill names or IDs"),
        account: z.string().optional().describe(ACCOUNT_DESC),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ profile_name, tagline, hourly_rate, description, skills, account }) => {
      try {
        const body: Record<string, unknown> = { profile_name, tagline, hourly_rate, description };
        if (skills?.length) body.skill_ids = await resolveSkillIds(skills, account);
        const result = await apiPostJson<{ profile_id?: number }>("/users/0.1/profiles", body, account);
        return {
          content: [{ type: "text", text: `✅ Specialty profile created${result?.profile_id ? ` (ID ${result.profile_id})` : ""}.` }],
          structuredContent: result,
        };
      } catch (err) {
        return mcpError((err as Error).message);
      }
    },
  );

  server.registerTool(
    "freelancer_update_profile",
    {
      title: "Update Specialty Profile",
      description:
        "Update fields on one of your Freelancer.com \"specialty profiles\". Only the fields you " +
        "supply are changed. Important: this edits a SPECIALTY profile identified by profile_id — " +
        "it does NOT edit your main account profile (that's web-UI-only). ⚠️ The API enforces " +
        "ownership: editing a profile_id you don't own is rejected.",
      inputSchema: {
        profile_id: z.number().int().positive().describe("Specialty profile numeric ID"),
        tagline: z.string().optional().describe("Short headline"),
        hourly_rate: z.number().positive().optional().describe("Hourly rate in USD"),
        description: z.string().optional().describe("Profile description"),
        skills: z.array(z.union([z.string(), z.number()])).optional().describe("Skill names or IDs (replaces this profile's skills)"),
        account: z.string().optional().describe(ACCOUNT_DESC),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ profile_id, tagline, hourly_rate, description, skills, account }) => {
      try {
        const body: Record<string, unknown> = { profile_id };
        if (tagline !== undefined) body.tagline = tagline;
        if (hourly_rate !== undefined) body.hourly_rate = hourly_rate;
        if (description !== undefined) body.description = description;
        if (skills?.length) body.skill_ids = await resolveSkillIds(skills, account);
        if (Object.keys(body).length === 1) {
          return mcpError("Provide at least one field to update (tagline, hourly_rate, description or skills).");
        }
        const result = await apiPutJson<Record<string, unknown>>("/users/0.1/profiles", body, account);
        return { content: [{ type: "text", text: `✅ Specialty profile ${profile_id} updated.` }], structuredContent: { profile_id, result } };
      } catch (err) {
        return mcpError((err as Error).message);
      }
    },
  );

  return server;
}

function loadFreelancerEntry(): LocalMcpEntry | null {
  const accounts = loadAccounts();
  if (!accounts) return null;

  return {
    kind: "local",
    name: "freelancer",
    path: "/freelancer",
    createServer: () => createFreelancerServer(accounts),
  };
}

export const freelancerEntry = loadFreelancerEntry();

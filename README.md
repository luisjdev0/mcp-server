# mcp-gateway

Gateway Express que aloja múltiples servidores MCP bajo un mismo dominio, cada uno
en su propio path (`/echo`, `/mcp2`, ...), protegido por token. Ver `plan-desarrollo.md`
para el diseño completo.

## Variables de entorno

Copia `.env.example` a `.env` y ajusta:

- `PORT`: puerto interno de Express (dentro del contenedor).
- `MCP_AUTH_TOKENS`: tokens de acceso, formato `token[:scope1|scope2],token2[:scope]`.
  - Un token sin scope (o con `*`) tiene acceso a todos los MCPs registrados.
  - Un token con scope(s) solo accede a los MCPs cuyo `name` (definido en
    `src/registry/index.ts`) coincida.
  - Genera tokens con `openssl rand -hex 32`.
- `HOST_BIND` / `HOST_PORT`: solo para docker-compose — host/puerto donde se publica
  el contenedor (por defecto `127.0.0.1:3000`) para que el Caddy ya instalado en el
  servidor le haga `reverse_proxy`.

## Desarrollo local

```bash
npm install
cp .env.example .env   # y edita MCP_AUTH_TOKENS
npm run dev
```

## Build / producción (sin Docker)

```bash
npm run build
npm start
```

## Docker

Este repo trae `Dockerfile` y `docker-compose.yml` con un único servicio (`app`).
No incluye proxy: se asume que el Caddy ya existente en el servidor apunta a
`127.0.0.1:${HOST_PORT}`. El despliegue (levantar el compose, configurar el
Caddyfile del servidor, DNS, etc.) queda a cargo de quien administra el servidor.

Ejemplo de bloque en el Caddy ya existente:

```
mcp.dominio.com {
    reverse_proxy 127.0.0.1:3000
}
```

## Autenticación: token estático vs. OAuth (custom connector de cuenta)

Hay dos formas de autenticarse contra este gateway, pensadas para clientes distintos:

- **Token estático (`MCP_AUTH_TOKENS`)**: pensado para clientes "locales" — Claude
  Code, `claude_desktop_config.json` con [`mcp-remote`](https://www.npmjs.com/package/mcp-remote)
  como bridge, `curl`, el MCP Inspector, etc. Es el mecanismo original de este
  gateway (ver sección de variables de entorno arriba).
- **OAuth 2.1 + Dynamic Client Registration (`OAUTH_*`)**: necesario para registrar
  este gateway como **custom connector a nivel de cuenta en claude.ai**
  (Settings → Connectors → Add custom connector). Ese flujo, al no pasar por
  ningún archivo de config local, solo sabe hacer el handshake OAuth — no hay
  forma de pegar un Bearer token estático ahí. Este repo implementa un
  authorization server mínimo (`src/auth/oauth.ts` + `src/http/mountOAuth.ts`)
  para un único usuario administrador: no hay noción de múltiples cuentas, un
  login válido da acceso total a todos los MCPs del gateway.

Ambos mecanismos conviven: `requireAuth` (`src/auth/middleware.ts`) acepta
cualquiera de los dos en el header `Authorization: Bearer <token>`.

### Activar el custom connector de cuenta en claude.ai

1. Completa en `.env`: `OAUTH_JWT_SECRET` (`openssl rand -hex 32`),
   `OAUTH_ADMIN_USER` y `OAUTH_ADMIN_PASSWORD`. Si falta cualquiera, el
   authorization server queda deshabilitado y el resto del gateway sigue
   funcionando normal.
2. `docker compose up -d --build` (el volumen `oauth_data` persiste los
   clientes que claude.ai registre dinámicamente, para no perderlos en cada
   reinicio del contenedor).
3. En claude.ai: **Settings → Connectors → Add custom connector**, con la URL
   del MCP que quieras conectar, ej. `https://mcp.tudominio.com/appflowy`.
4. Claude.ai se auto-registra como cliente OAuth (Dynamic Client Registration)
   y te redirige a una pantalla de login (`/authorize`) servida por este
   gateway. Ingresa `OAUTH_ADMIN_USER`/`OAUTH_ADMIN_PASSWORD`.
5. Listo: claude.ai guarda el access/refresh token y los renueva solo. El
   login vale para **todo el gateway** (cualquier path `/echo`, `/appflowy`,
   `/dbhub`), así que solo hace falta hacerlo una vez aunque agregues el
   conector para más de un MCP.

**Notas de seguridad:**

- Los access tokens (JWT, 1h) y refresh tokens (JWT, 90 días) están firmados
  con `OAUTH_JWT_SECRET`; no hay lista de revocación — para invalidar todo,
  rota `OAUTH_JWT_SECRET` (cierra la sesión de todos los conectores
  registrados, no solo uno).
- `OAUTH_ADMIN_PASSWORD` viaja en texto plano en `.env`, igual que
  `APPFLOWY_PASSWORD`: nunca subas `.env` al repo (ya está en `.gitignore`).
- Al ser un único usuario, no hay scopes por conector: todo login OAuth
  equivale a un token estático con scope `*`.

## Cómo agregar un MCP nuevo

1. Copia `src/servers/_template` a `src/servers/<nombre>/index.ts`.
2. Renombra la función `createTemplateServer`, ajusta `name`/`version` y define
   sus `tools`/`resources`/`prompts` con `server.registerTool(...)`, etc.
3. Agrega una entrada en `src/registry/index.ts`:
   ```ts
   {
     kind: "local",
     name: "mi-mcp",
     path: "/mi-mcp",
     createServer: createMiMcpServer,
   }
   ```
4. Si quieres un token restringido solo a ese MCP, usa `mi-mcp` como scope en
   `MCP_AUTH_TOKENS` (ej. `MCP_AUTH_TOKENS=token-general:*,token-limitado:mi-mcp`).
5. No hace falta tocar `src/index.ts` ni `src/http/mountMcp.ts`: el bootstrap
   recorre el registry y monta auth + transporte HTTP automáticamente.

## Cómo integrar un MCP de terceros (reverse proxy)

Para un MCP que no implementamos nosotros y corre como su propio servicio
(otro contenedor, otro proceso), se usa una entrada `kind: "proxy"` en vez de
`kind: "local"` — ver `src/servers/appflowy` como ejemplo real. El patrón:

1. Agrega el servicio como container aparte en `docker-compose.yml`, sin
   publicar su puerto al host (solo alcanzable por `app` en la red interna).
2. Crea `src/servers/<nombre>/index.ts` que arme un `ProxiedMcpEntry` (path
   público, `target` con la URL interna + su endpoint, y opcionalmente
   `upstreamAuthHeader` con el token/credencial que esa app necesita).
3. Agrega la entrada al `registry` (se filtra sola si falta configuración,
   igual que appflowy).

Nuestro middleware de auth (`MCP_AUTH_TOKENS`, scope = `name` del MCP) protege
el path público antes de reenviar; `mountProxy` reemplaza el header
`Authorization` por el que el servicio downstream espera, así el cliente nunca
ve ni necesita el token interno de esa integración.

## MCPs incluidos

### `/echo` (local)

Incluido para validar el pipeline completo (auth → sesión MCP → tools). Expone
dos tools: `echo` (repite texto) y `server_time` (hora actual del servidor).
Pruébalo con el [MCP Inspector](https://github.com/modelcontextprotocol/inspector)
apuntando a `http://localhost:3000/echo` con el header
`Authorization: Bearer <tu-token>`.

### `/appflowy` (proxy a [CAREEMER/appflowy-mcp](https://github.com/CAREEMER/appflowy-mcp))

Reverse proxy hacia el servidor MCP de AppFlowy Cloud (imagen Docker
`m2n2/appflowy-mcp`, levantada como servicio `appflowy-mcp` en
`docker-compose.yml`). Expone 23 tools para operar workspaces, páginas,
bloques, bases de datos y papelera/favoritos de AppFlowy.

Para activarlo:

1. Completa en `.env`: `APPFLOWY_BASE_URL`, `APPFLOWY_EMAIL`, `APPFLOWY_PASSWORD`
   (cuenta de servicio de tu AppFlowy Cloud) y `APPFLOWY_MCP_INTERNAL_TOKEN`
   (secreto interno entre este gateway y el sidecar, generado con
   `openssl rand -hex 32`).
2. Da a un token de `MCP_AUTH_TOKENS` acceso al scope `appflowy`
   (ej. `MCP_AUTH_TOKENS=token-general:*` ya incluye todo; o
   `token-limitado:appflowy` para un token restringido solo a este MCP).
3. `docker compose up -d` levanta ambos servicios; el cliente MCP se conecta
   a `https://mcp.dominio.com/appflowy` con `Authorization: Bearer <su-token>`
   — nunca ve `APPFLOWY_MCP_INTERNAL_TOKEN`, que solo viaja entre `app` y
   `appflowy-mcp` dentro de la red de docker-compose.

Si `APPFLOWY_MCP_INTERNAL_TOKEN` no está definido, este MCP se omite del
arranque (el resto del gateway sigue funcionando normalmente).

### `/dbhub` (proxy a [bytebase/dbhub](https://github.com/bytebase/dbhub))

Reverse proxy hacia DBHub (imagen Docker `bytebase/dbhub`, levantada como
servicio `dbhub-mcp` en modo `--transport http`). Expone tools genéricas de
base de datos (`execute_sql`, `search_objects`) contra Postgres, MySQL, SQL
Server, MariaDB o SQLite según el DSN que le pases.

**Importante:** DBHub no autentica a sus clientes HTTP por diseño propio — por
eso nunca se publica su puerto al host en `docker-compose.yml`; nuestra propia
auth (`MCP_AUTH_TOKENS`, scope `dbhub`) es la única protección delante de él.

Para activarlo:

1. Completa en `.env`: `DBHUB_DSN` con la cadena de conexión a la base que
   quieras exponer (usa un usuario de solo lectura salvo que necesites que el
   MCP escriba). Si la BD corre en el mismo host (fuera de Docker), usa
   `host.docker.internal` en vez de `localhost`.
2. Da a un token de `MCP_AUTH_TOKENS` acceso al scope `dbhub`.
3. `docker compose up -d`; el cliente MCP se conecta a
   `https://mcp.dominio.com/dbhub` con `Authorization: Bearer <su-token>`.

Si `DBHUB_DSN` no está definido, este MCP se omite del arranque.

### `/cerebro` (local, reimplementación contra la API de [KnowledgeOS](https://github.com/luisjdev0/cerebro), privado)

A diferencia de `/appflowy`, `/dbhub` y `/analytics`, este MCP **no es un proxy a un
sidecar**: KnowledgeOS (memoria persistente self-hosted, Postgres+pgvector) ya corre
como su propio servicio en otro lugar (ver `DEPLOY.md` de ese repo), y su cliente MCP
oficial (`knowledgeos-mcp`) solo habla stdio. Como ese repo es privado y no se
modifica desde aquí, `src/servers/cerebro` reimplementa los mismos 10 tools
(`memory_search`, `memory_remember`, `memory_update`, `memory_forget`, `memory_link`,
`memory_related`, `memory_timeline`, `memory_contexts`, `memory_create_context`,
`memory_stats`) hablando HTTP directo contra esa API — mismo contrato, mismos
endpoints, sin lógica de negocio propia (vive toda en la API de KnowledgeOS).

Para activarlo:

1. Completa en `.env`: `KNOWLEDGEOS_API_URL` (URL de la API ya desplegada) y
   `KNOWLEDGEOS_API_TOKEN` (un token con scopes `read,write,admin` y sin
   `--contexts` -- acceso completo a todos los contextos -- creado con
   `knowledgeos token create mcp-gateway --scopes read,write,admin`).
2. Da a un token de `MCP_AUTH_TOKENS` acceso al scope `cerebro`.
3. El cliente MCP se conecta a `https://mcp.dominio.com/cerebro` con
   `Authorization: Bearer <su-token>` — nunca ve `KNOWLEDGEOS_API_TOKEN`.

Si `KNOWLEDGEOS_API_URL` o `KNOWLEDGEOS_API_TOKEN` no están definidos, este MCP se
omite del arranque.

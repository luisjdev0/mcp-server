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

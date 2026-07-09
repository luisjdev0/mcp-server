# Plan de Desarrollo — MCP Gateway

## 0. Resumen ejecutivo

Proyecto Node.js (Express) que actúa como **gateway/host** para múltiples servidores MCP (Model Context Protocol), cada uno expuesto bajo su propia ruta en un mismo dominio:

```
https://mcp.dominio.com/mcp1
https://mcp.dominio.com/mcp2
https://mcp.dominio.com/mcp3
...
```

Todo el tráfico queda protegido por un sistema de autenticación (no es accesible públicamente sin credenciales), se empaqueta con Docker y se despliega vía `docker-compose` en un servidor propio. Los MCPs se añaden de forma incremental, uno a uno, sin tener que rediseñar la base.

---

## 1. Objetivos y alcance

- **Un único proceso Node/Express** capaz de alojar N servidores MCP, cada uno como módulo independiente.
- **Autenticación obligatoria** delante de cualquier MCP (API key / Bearer token como primera fase; posibilidad de evolucionar a OAuth2 más adelante si algún cliente MCP lo requiere).
- **Enrutamiento por path**, no por subdominio, para simplificar certificados TLS y configuración de DNS (`mcp.dominio.com/mcp1`, `/mcp2`, ...).
- **Incremental**: agregar un nuevo MCP debe ser "crear una carpeta + registrar la ruta", sin tocar el resto del sistema.
- **Desplegable con Docker Compose** en un VPS/servidor propio, con reverse proxy delante para TLS y dominio.
- Fuera de alcance (por ahora): multi-tenant con paneles de administración, billing, marketplace de MCPs. Se puede evaluar más adelante.

---

## 2. Arquitectura general

```
Cliente MCP (Claude, IDE, etc.)
        │  HTTPS + Bearer token
        ▼
 ┌─────────────────────────────┐
 │  Reverse Proxy (Caddy/Nginx)│  ← TLS (Let's Encrypt) + dominio
 └──────────────┬───────────────┘
                │ HTTP interno (docker network)
                ▼
 ┌─────────────────────────────┐
 │      Express App (Node)     │
 │  ┌─────────────────────────┐│
 │  │ Middleware de auth       ││  ← valida API key/token en TODAS las rutas /mcp*
 │  └─────────────────────────┘│
 │  ┌───────────┐ ┌───────────┐│
 │  │ /mcp1     │ │ /mcp2     ││  ← cada uno monta su propio McpServer
 │  │ Transport │ │ Transport ││     (StreamableHTTPServerTransport)
 │  └───────────┘ └───────────┘│
 └─────────────────────────────┘
```

- El **reverse proxy** (recomendado: Caddy por su TLS automático con Let's Encrypt y config mínima; alternativa: Nginx si ya se maneja en el servidor) es el único servicio expuesto a internet. Termina TLS y reenvía a la app Node por la red interna de Docker.
- La **app Express** es el único punto de entrada a los MCPs. No expone nada sin pasar antes por el middleware de autenticación.
- Cada **MCP** vive en su propia carpeta/módulo y se registra en un "registry" central que Express recorre para montar las rutas automáticamente.

---

## 3. Stack tecnológico

| Área | Elección | Motivo |
|---|---|---|
| Runtime | Node.js 20/22 LTS | Estable, soportado por el SDK oficial de MCP |
| Lenguaje | TypeScript | Tipado para los `tools`/`resources` de cada MCP, menos errores al escalar a varios servidores |
| Framework HTTP | Express 4/5 | Pedido explícitamente, maduro, fácil de montar sub-routers |
| SDK MCP | `@modelcontextprotocol/sdk` (Node) | SDK oficial, soporta `StreamableHTTPServerTransport` para exponer MCP sobre HTTP |
| Auth | Middleware propio con API Keys (Bearer) | Simple, suficiente para "no público"; ampliable a OAuth2 si algún cliente lo exige |
| Logs | `pino` (+ `pino-http`) | Logging estructurado, bajo overhead |
| Contenedor | Docker + docker-compose | Pedido explícitamente |
| Reverse proxy / TLS | Caddy (o Nginx) | TLS automático, config simple para path-based routing |
| Validación config | `zod` | Validar `.env` y configuración de cada MCP al arrancar |

---

## 4. Estructura de carpetas propuesta

```
mcp-server/
├── docker-compose.yml
├── Dockerfile
├── .env.example
├── package.json
├── tsconfig.json
├── plan-desarrollo.md
├── proxy/
│   └── Caddyfile                 # o nginx.conf, según elección
└── src/
    ├── index.ts                 # bootstrap: crea app, carga registry, levanta servidor
    ├── config/
    │   └── env.ts                # carga y valida variables de entorno (zod)
    ├── auth/
    │   ├── middleware.ts          # verifica Bearer token / API key
    │   └── keys.ts                # fuente de API keys (env, json, o DB simple)
    ├── registry/
    │   └── index.ts               # lista de MCPs activos y su path (`/mcp1`, `/mcp2`...)
    ├── servers/
    │   ├── mcp1/
    │   │   ├── index.ts           # crea el McpServer, define tools/resources/prompts
    │   │   └── tools/*.ts
    │   ├── mcp2/
    │   │   └── index.ts
    │   └── _template/             # plantilla para crear un MCP nuevo rápido
    │       └── index.ts
    └── http/
        └── mountMcp.ts            # helper: monta un McpServer en un path de Express
                                    #   (maneja StreamableHTTPServerTransport + sesiones)
```

Añadir un MCP nuevo = copiar `_template`, implementar sus tools, y agregar una línea en `registry/index.ts`.

---

## 5. Autenticación

**Fase 1 (MVP):**
- Middleware Express aplicado a `/mcp*` que exige header `Authorization: Bearer <token>`.
- Tokens definidos en variables de entorno (o archivo `keys.json` montado como volumen/secret), con soporte para:
  - Un token "global" con acceso a todos los MCPs.
  - Tokens con acceso restringido a MCPs específicos (útil si en el futuro se comparte acceso a un solo MCP con un tercero).
- Respuestas `401` si falta/():es inválido el token, sin filtrar información del servidor.
- Rate limiting básico (`express-rate-limit`) para mitigar fuerza bruta sobre el endpoint de auth.

**Fase 2 (opcional, si se necesita más adelante):**
- Emisión/rotación de tokens vía un pequeño CLI o endpoint admin protegido.
- Migrar a OAuth 2.1 / Dynamic Client Registration si algún cliente MCP (p. ej. Claude.ai remoto) lo requiere formalmente — el spec de MCP remoto contempla esto, pero muchos clientes (Claude Code, Claude Desktop vía config) funcionan perfectamente con Bearer token estático.

---

## 6. Enrutamiento multi-MCP con Express

- Un **registry** (`src/registry/index.ts`) define: `{ path: "/mcp1", factory: () => createMcp1Server() }` por cada MCP.
- `src/http/mountMcp.ts` implementa el patrón recomendado por el SDK de MCP para transporte HTTP:
  - Instancia `StreamableHTTPServerTransport` por sesión (usando el header `Mcp-Session-Id`).
  - Mapa en memoria `sessionId -> transport` por cada MCP montado (aislado por path, para que una sesión de `/mcp1` no choque con una de `/mcp2`).
  - Maneja `POST` (mensajes/inicialización), `GET` (stream SSE de servidor a cliente) y `DELETE` (cierre de sesión) según el spec de Streamable HTTP.
- `src/index.ts` recorre el registry y llama `mountMcp(app, entry)` por cada uno — así agregar un MCP nuevo no requiere tocar el bootstrap.

> Nota: si en el futuro se necesita escalar horizontalmente (más de una instancia de Node), el mapa de sesiones en memoria deja de servir y habría que mover el estado de sesión a Redis. Se documenta aquí para no olvidarlo, pero no es necesario para el MVP de un solo servidor.

---

## 7. Docker y docker-compose

**`Dockerfile`** (multi-stage):
1. Stage `build`: instala dependencias, compila TypeScript.
2. Stage `runtime`: imagen `node:20-slim`, solo `dist/` + `node_modules` de producción, usuario no-root, `HEALTHCHECK` simple sobre un endpoint `/health`.

**`docker-compose.yml`** (servicios):
```yaml
services:
  app:
    build: .
    env_file: .env
    restart: unless-stopped
    expose:
      - "3000"
    # sin "ports" públicos: solo accesible dentro de la red de docker-compose

  proxy:
    image: caddy:2
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./proxy/Caddyfile:/etc/caddy/Caddyfile
      - caddy_data:/data
    depends_on:
      - app

volumes:
  caddy_data:
```

**`proxy/Caddyfile`** (ejemplo mínimo):
```
mcp.dominio.com {
    reverse_proxy app:3000
}
```
Caddy gestiona el certificado TLS automáticamente vía Let's Encrypt; Express se encarga de rutear `/mcp1`, `/mcp2`, etc. internamente.

---

## 8. Despliegue en servidor

1. DNS: registro `A`/`AAAA` de `mcp.dominio.com` apuntando a la IP del servidor.
2. Servidor con Docker + Docker Compose instalados; abrir puertos 80/443.
3. Copiar el repo (o usar CI/CD simple: `git pull` + `docker compose up -d --build`).
4. Variables de entorno sensibles (`.env`) nunca en el repo — se gestionan directamente en el servidor o vía secret manager si se usa CI.
5. `docker compose up -d` levanta proxy + app; Caddy emite el certificado en el primer arranque.
6. Verificación: `curl` con y sin token contra `/mcp1` para confirmar que el 401 funciona antes de dar por bueno el despliegue.

---

## 9. Observabilidad y seguridad adicional

- Logging estructurado (`pino`) con request id, path de MCP, y resultado de auth (sin loguear el token en texto plano).
- `helmet` para cabeceras HTTP seguras.
- CORS restringido a los orígenes que realmente lo necesiten (por defecto, cerrado).
- Límite de tamaño de body (`express.json({ limit: ... })`) para evitar payloads abusivos.
- Healthcheck `/health` sin autenticación (para Docker/monitorización), todo lo demás bajo `/mcp*` protegido.
- Backups/rotación de logs si el volumen de uso crece.

---

## 10. Roadmap por fases

**Fase 0 — Bootstrap del proyecto**
- Inicializar repo Git, `package.json`, TypeScript, ESLint/Prettier.
- Estructura de carpetas descrita en la sección 4.
- `Dockerfile` + `docker-compose.yml` básicos, endpoint `/health`.

**Fase 1 — Autenticación**
- Middleware de Bearer token + validación de config vía `zod`.
- Tests manuales de acceso denegado/permitido.

**Fase 2 — Primer MCP end-to-end**
- Implementar `_template` como MCP real y sencillo (por ejemplo un MCP de "echo"/utilidades) para validar todo el pipeline: auth → montaje → transporte HTTP → respuesta a un cliente MCP real (Claude Code o Inspector de MCP).
- Probar con `@modelcontextprotocol/inspector` localmente antes de exponer a internet.

**Fase 3 — Reverse proxy + despliegue real**
- Levantar Caddy, apuntar DNS, desplegar en el servidor, validar TLS y ruteo por path en producción.

**Fase 4 — Segundo y siguientes MCPs**
- Añadir MCPs adicionales uno a uno reutilizando `_template` y el registry.
- Cada nuevo MCP: su propia carpeta, sus propios tools, entrada en el registry, y (si aplica) su propio scope de API key.

**Fase 5 (opcional, según necesidad futura)**
- Rotación/gestión de tokens vía comando o endpoint admin.
- Persistencia de sesiones fuera de memoria (Redis) si se necesita escalar a múltiples instancias.
- Migración a OAuth2 si algún cliente MCP lo exige.

---

## 11. Checklist de próximos pasos inmediatos

- [ ] Confirmar nombre de dominio real y si ya existe DNS gestionable.
- [ ] Confirmar cuáles serán los primeros 1-2 MCPs a implementar (para diseñar el `_template` con ejemplos reales).
- [ ] Decidir Caddy vs Nginx (Caddy recomendado si no hay ya infraestructura Nginx en el servidor).
- [ ] `npm init` + estructura base (Fase 0).

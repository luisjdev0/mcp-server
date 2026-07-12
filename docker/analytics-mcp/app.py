# Envoltorio ASGI que reexpone el servidor stdio oficial de Google
# (paquete "analytics-mcp", https://github.com/googleanalytics/google-analytics-mcp)
# sobre Streamable HTTP, reusando el SDK oficial de MCP para Python
# (StreamableHTTPSessionManager) en vez de depender de un bridge de terceros.
#
# analytics_mcp.coordinator.app ya es un mcp.server.lowlevel.Server con todas
# las tools de Google Analytics registradas (ver ese paquete); aquí solo se
# reconecta ese mismo objeto a un transporte HTTP en lugar de stdio.

import contextlib
import os

from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.routing import Route
from starlette.types import Receive, Scope, Send

import analytics_mcp.coordinator as coordinator
from mcp.server.streamable_http_manager import StreamableHTTPSessionManager

INTERNAL_TOKEN = os.environ["ANALYTICS_MCP_INTERNAL_TOKEN"]

session_manager = StreamableHTTPSessionManager(
    app=coordinator.app,
    json_response=False,
)


async def health(_request: Request) -> Response:
    return JSONResponse({"status": "ok"})


class MCPEndpoint:
    """ASGI app crudo (no un endpoint `(request) -> Response`).

    Se pasa como instancia (no función) a `Route` a propósito: Starlette solo
    envuelve con `request_response()` cuando `endpoint` es una función o
    método; una instancia con `__call__` se monta tal cual, con la firma ASGI
    `(scope, receive, send)` que espera `StreamableHTTPSessionManager`. Con
    `Mount` en vez de `Route` la ruta exacta "/mcp" redirige (307) a "/mcp/",
    lo que rompe al proxy del gateway (siempre pega a la ruta exacta).
    """

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        request = Request(scope, receive)
        if request.headers.get("authorization") != f"Bearer {INTERNAL_TOKEN}":
            response = JSONResponse({"error": "unauthorized"}, status_code=401)
            await response(scope, receive, send)
            return
        await session_manager.handle_request(scope, receive, send)


mcp_endpoint = MCPEndpoint()


@contextlib.asynccontextmanager
async def lifespan(_app: Starlette):
    async with session_manager.run():
        yield


app = Starlette(
    routes=[
        Route("/health", health),
        Route("/mcp", mcp_endpoint, methods=["GET", "POST", "DELETE"]),
    ],
    lifespan=lifespan,
)

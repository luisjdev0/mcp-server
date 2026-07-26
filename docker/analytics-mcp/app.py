# Envoltorio ASGI que reexpone el servidor stdio oficial de Google
# (paquete "analytics-mcp", https://github.com/googleanalytics/google-analytics-mcp)
# sobre Streamable HTTP, reusando el SDK oficial de MCP para Python
# (StreamableHTTPSessionManager) en vez de depender de un bridge de terceros.
#
# analytics_mcp.coordinator.app ya es un mcp.server.lowlevel.Server con todas
# las tools de Google Analytics registradas (ver ese paquete); aquí se
# reconecta ese mismo objeto a un transporte HTTP en lugar de stdio, y además
# se le añaden las tools de escritura propias de admin_write_tools.py (el
# paquete oficial es de solo lectura). Ambos grupos de tools comparten el
# mismo Server MCP: se sobreescriben sus handlers list_tools/call_tool para
# que respondan con la unión de tools de lectura + escritura.

import contextlib
import json
import os
import sys

from mcp import types as mcp_types
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.routing import Route
from starlette.types import Receive, Scope, Send

import admin_write_tools
import analytics_mcp.coordinator as coordinator
from mcp.server.streamable_http_manager import StreamableHTTPSessionManager

INTERNAL_TOKEN = os.environ["ANALYTICS_MCP_INTERNAL_TOKEN"]

_all_tool_map = {**coordinator.tool_map, **admin_write_tools.tool_map}
_all_mcp_tools = [*coordinator.mcp_tools, *admin_write_tools.mcp_tools]


@coordinator.app.list_tools()
async def _list_all_tools() -> list[mcp_types.Tool]:
    return _all_mcp_tools


@coordinator.app.call_tool()
async def _call_any_tool(name: str, arguments: dict) -> list[mcp_types.Content]:
    if name in _all_tool_map:
        tool = _all_tool_map[name]
        try:
            adk_tool_response = await tool.run_async(args=arguments, tool_context=None)
            response_text = json.dumps(adk_tool_response, indent=2)
            return [mcp_types.TextContent(type="text", text=response_text)]
        except Exception as e:
            print(
                f"MCP Server: Error executing ADK tool '{name}': {e}",
                file=sys.stderr,
            )
            error_text = json.dumps(
                {"error": f"Failed to execute tool '{name}': {str(e)}"}
            )
            return [mcp_types.TextContent(type="text", text=error_text)]

    error_text = json.dumps(
        {"error": f"Tool '{name}' not implemented by this server."}
    )
    return [mcp_types.TextContent(type="text", text=error_text)]


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

// Vercel Function: Aposkal MCP sunucusunun uzak (Streamable HTTP) giriş noktası.
// aposkal-mcp · Switas Consultancy (https://switas.com)
// Derlenmiş kodu kullanır; Vercel derleme adımında `npm run build` çalıştırılır.
import { handleMcpRequest } from "../dist/http-handler.js";

export const GET = handleMcpRequest;
export const POST = handleMcpRequest;
export const DELETE = handleMcpRequest;

// Vercel Function — OAuth: Token ucu (yetkilendirme kodu ve yenileme).
// aposkal-mcp · Switas Consultancy (https://switas.com)
import { handleToken } from "../../dist/http-handler.js";

export const GET = handleToken;
export const POST = handleToken;
export const OPTIONS = handleToken;

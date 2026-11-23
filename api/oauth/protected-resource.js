// Vercel Function — OAuth: Korunan kaynak meta verisi (RFC 9728).
// aposkal-mcp · Switas Consultancy (https://switas.com)
import { handleProtectedResourceMetadata } from "../../dist/http-handler.js";

export const GET = handleProtectedResourceMetadata;
export const POST = handleProtectedResourceMetadata;
export const OPTIONS = handleProtectedResourceMetadata;

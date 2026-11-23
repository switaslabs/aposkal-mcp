// Vercel Function — OAuth: Yetkilendirme sunucusu meta verisi (RFC 8414).
// aposkal-mcp · Switas Consultancy (https://switas.com)
import { handleAuthorizationServerMetadata } from "../../dist/http-handler.js";

export const GET = handleAuthorizationServerMetadata;
export const POST = handleAuthorizationServerMetadata;
export const OPTIONS = handleAuthorizationServerMetadata;

// Vercel Function — OAuth: Yetkilendirme ve giriş sayfası.
// aposkal-mcp · Switas Consultancy (https://switas.com)
import { handleAuthorize } from "../../dist/http-handler.js";

export const GET = handleAuthorize;
export const POST = handleAuthorize;
export const OPTIONS = handleAuthorize;

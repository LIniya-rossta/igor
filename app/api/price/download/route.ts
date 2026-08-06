import { contentDisposition, getCurrentPriceVersion } from "@/lib/price";
import { getRuntimeEnv } from "@/lib/runtime-env";

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const current = await getCurrentPriceVersion();

    if (!current) {
      return Response.redirect(new URL("/price.xlsx", request.url), 307);
    }

    const object = await getRuntimeEnv().PRICE_FILES.get(current.objectKey);
    if (!object) {
      return Response.redirect(new URL("/price.xlsx", request.url), 307);
    }

    const headers = new Headers({
      "Cache-Control": "private, no-store",
      "Content-Disposition": contentDisposition(current.originalName),
      "Content-Length": String(object.size),
      "Content-Type": XLSX_MIME,
      "X-Content-Type-Options": "nosniff",
    });
    headers.set("ETag", object.httpEtag);

    return new Response(object.body, { headers });
  } catch {
    return Response.redirect(new URL("/price.xlsx", request.url), 307);
  }
}

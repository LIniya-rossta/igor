import { contentDisposition, getCurrentPriceVersion } from "@/lib/price";
import { excelMimeType } from "@/lib/excel-file";
import { getRuntimeEnv } from "@/lib/runtime-env";

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
      "Content-Type": excelMimeType(current.originalName),
      "X-Content-Type-Options": "nosniff",
    });
    headers.set("ETag", object.httpEtag);

    return new Response(object.body, { headers });
  } catch {
    return Response.redirect(new URL("/price.xlsx", request.url), 307);
  }
}

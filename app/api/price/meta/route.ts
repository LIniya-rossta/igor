import { getCurrentPriceVersion, toPublicPriceMeta } from "@/lib/price";
import { publicPriceHeaders } from "@/lib/public-api";
import { getRuntimeEnv } from "@/lib/runtime-env";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const current = await getCurrentPriceVersion();
    const available = current
      ? await getRuntimeEnv().PRICE_FILES.head(current.objectKey)
      : null;
    return Response.json(toPublicPriceMeta(available ? current : null), {
      headers: publicPriceHeaders(request.headers.get("Origin")),
    });
  } catch {
    return Response.json(toPublicPriceMeta(null), {
      headers: publicPriceHeaders(request.headers.get("Origin")),
    });
  }
}

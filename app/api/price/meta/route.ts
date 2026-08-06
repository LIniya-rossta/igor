import { getCurrentPriceVersion, toPublicPriceMeta } from "@/lib/price";
import { getRuntimeEnv } from "@/lib/runtime-env";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const current = await getCurrentPriceVersion();
    const available = current
      ? await getRuntimeEnv().PRICE_FILES.head(current.objectKey)
      : null;
    return Response.json(toPublicPriceMeta(available ? current : null), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return Response.json(toPublicPriceMeta(null), {
      headers: { "Cache-Control": "no-store" },
    });
  }
}

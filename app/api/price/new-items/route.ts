import { getCachedCurrentNewItems } from "@/lib/price";
import { publicPriceHeaders } from "@/lib/public-api";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const items = await getCachedCurrentNewItems();
    return Response.json(
      { items },
      { headers: publicPriceHeaders(request.headers.get("Origin")) },
    );
  } catch {
    // The list is additive UI. A missing/unmigrated table must not take down
    // the public price page while the rest of the site remains available.
    return Response.json(
      { items: [] },
      { headers: publicPriceHeaders(request.headers.get("Origin")) },
    );
  }
}

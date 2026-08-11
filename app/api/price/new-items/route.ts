import { getCurrentNewItems } from "@/lib/price";
import { publicPriceHeaders } from "@/lib/public-api";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const rows = await getCurrentNewItems();
    return Response.json(
      { items: rows.map((row: { productName: string }) => row.productName) },
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

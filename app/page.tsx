import HomeContent from "./home-content";
import { getCachedCurrentNewItems } from "@/lib/price";

export const dynamic = "force-dynamic";

export default async function Home() {
  let initialNewItems: string[] = [];
  try {
    initialNewItems = await getCachedCurrentNewItems();
  } catch {
    // The public page still renders with the empty state if storage is warming up.
  }

  return <HomeContent initialNewItems={initialNewItems} />;
}

import type { Metadata } from "next";
import { SearchScreen } from "@/components/search-screen";

export const metadata: Metadata = { title: "Search. MOSAIC Atlas" };

export default function Page() {
  return <SearchScreen />;
}

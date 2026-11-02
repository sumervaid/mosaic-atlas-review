import type { Metadata } from "next";
import { ConceptScreen } from "@/components/concept-screen";

export const metadata: Metadata = { title: "Concept. MOSAIC Atlas" };

export default function Page() {
  return <ConceptScreen />;
}

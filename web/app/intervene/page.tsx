import type { Metadata } from "next";
import { InterveneScreen } from "@/components/intervene-screen";

export const metadata: Metadata = { title: "Intervene. MOSAIC Atlas" };

export default function Page() {
  return <InterveneScreen />;
}

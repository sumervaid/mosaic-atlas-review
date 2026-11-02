import type { Metadata } from "next";
import { ContagionScreen } from "@/components/contagion-screen";

export const metadata: Metadata = { title: "Contagion tracer. MOSAIC Atlas" };

export default function Page() {
  return <ContagionScreen />;
}

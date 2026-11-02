import type { Metadata } from "next";
import { SetupScreen } from "@/components/setup-screen";

export const metadata: Metadata = { title: "Setup. MOSAIC Atlas" };

export default function Page() {
  return <SetupScreen />;
}

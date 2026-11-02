import type { Metadata } from "next";
import { SteerScreen } from "@/components/steer-screen";

export const metadata: Metadata = { title: "Steer. MOSAIC Atlas" };

export default function Page() {
  return <SteerScreen />;
}

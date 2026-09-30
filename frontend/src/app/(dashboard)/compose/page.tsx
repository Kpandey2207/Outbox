import type { Metadata } from "next";
import { ComposePage } from "@/components/compose/ComposePage";

export const metadata: Metadata = { title: "Compose" };

export default function Page() {
  return <ComposePage />;
}

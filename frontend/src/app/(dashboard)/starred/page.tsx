import type { Metadata } from "next";
import { EmailList } from "@/components/emails/EmailList";

export const metadata: Metadata = { title: "Starred" };

export default function StarredPage() {
  return <EmailList view="starred" />;
}

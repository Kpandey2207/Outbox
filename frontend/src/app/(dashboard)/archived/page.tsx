import type { Metadata } from "next";
import { EmailList } from "@/components/emails/EmailList";

export const metadata: Metadata = { title: "Archived" };

export default function ArchivedPage() {
  return <EmailList view="archived" />;
}

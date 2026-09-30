import type { Metadata } from "next";
import { EmailList } from "@/components/emails/EmailList";

export const metadata: Metadata = { title: "Scheduled" };

export default function ScheduledPage() {
  return <EmailList view="scheduled" />;
}

import type { Metadata } from "next";
import { EmailList } from "@/components/emails/EmailList";

export const metadata: Metadata = { title: "Sent" };

export default function SentPage() {
  return <EmailList view="sent" />;
}

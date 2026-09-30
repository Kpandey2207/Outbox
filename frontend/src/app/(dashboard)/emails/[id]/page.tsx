import { notFound } from "next/navigation";
import { EmailDetail } from "@/components/emails/EmailDetail";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function EmailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // The id goes into an API path; anything that is not an email id is simply not found.
  if (!UUID.test(id)) notFound();
  return <EmailDetail id={id} />;
}

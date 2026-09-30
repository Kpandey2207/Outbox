"use client";

import { ComposeForm } from "./ComposeForm";
import { PageLoader } from "../ui/Spinner";
import { useMe } from "@/hooks/queries";

export function ComposePage() {
  const me = useMe();
  // The dashboard layout already handles loading and auth errors for /api/me.
  if (!me.data) return <PageLoader />;
  return <ComposeForm me={me.data} />;
}

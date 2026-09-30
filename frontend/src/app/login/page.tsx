import type { Metadata } from "next";
import { Suspense } from "react";
import { LoginCard } from "@/components/layout/LoginCard";
import { Logo } from "@/components/ui/Logo";

export const metadata: Metadata = { title: "Login" };

export default function LoginPage() {
  return (
    <div className="flex min-h-dvh flex-col items-center bg-surface px-5 pb-10 pt-14 md:justify-center md:px-4 md:py-0">
      {/* Phones open on a bare page, so the brand sits above the form. */}
      <div className="mb-10 md:hidden">
        <Logo size={32} />
      </div>
      <Suspense>
        <LoginCard />
      </Suspense>
    </div>
  );
}

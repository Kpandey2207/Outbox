"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter, useSearchParams } from "next/navigation";
import { useState, type FormEvent } from "react";
import { api } from "@/lib/api";
import { Button } from "../ui/Button";
import { InlineError } from "../ui/States";

const ERRORS: Record<string, string> = {
  google_denied: "Google sign in was cancelled.",
  invalid_state: "That sign in link expired. Please try again.",
  google_failed: "We could not sign you in with Google. Please try again.",
  google_mismatch: "This email is linked to a different Google account.",
  slack_signed_out: "Your session ended before Slack finished connecting. Sign in and connect Slack again.",
};

function GoogleIcon() {
  return (
    <svg viewBox="0 0 48 48" className="h-4 w-4" aria-hidden>
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2c-2 1.5-4.5 2.4-7.2 2.4-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  );
}

const inputClass =
  "w-full rounded-lg bg-surface-muted px-4 py-3.5 text-sm outline-none ring-brand-500 placeholder:text-ink-subtle focus:ring-2 md:py-3";

export function LoginCard() {
  const router = useRouter();
  const params = useSearchParams();
  const qc = useQueryClient();
  const config = useQuery({ queryKey: ["auth-config"], queryFn: api.authConfig });
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(ERRORS[params.get("error") ?? ""] ?? null);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      // Nothing cached from a previous account may show in this one.
      qc.clear();
      router.replace("/scheduled");
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!email.trim() || password.length < 8) {
      setError(!email.trim() ? "Enter your email" : "Password must be at least 8 characters");
      return;
    }
    void run(() => api.emailSignIn(email.trim(), password));
  };

  const googleEnabled = config.data?.googleEnabled !== false;

  return (
    <div className="w-full max-w-[460px]">
      <div className="rounded-xl bg-surface md:border md:border-line md:px-10 md:py-10">
        <h1 className="text-center text-[26px] font-bold md:text-[28px]">Login</h1>

        <div className="mt-6">
          <a
            href="/auth/google"
            onClick={(e) => {
              if (!googleEnabled) {
                e.preventDefault();
                setError("Google sign in is not configured on this server yet.");
              }
            }}
            className="flex min-h-12 items-center justify-center gap-2.5 rounded-lg bg-brand-50 px-5 py-2.5 text-[15px] text-ink transition-colors hover:bg-brand-100 active:bg-brand-100 md:min-h-0 md:text-sm"
          >
            <GoogleIcon />
            Login with Google
          </a>
        </div>

        <div className="my-6 flex items-center gap-4 text-[11px] text-ink-subtle">
          <span className="h-px flex-1 bg-line" />
          or sign up through email
          <span className="h-px flex-1 bg-line" />
        </div>

        <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
          <label>
            <span className="sr-only">Email ID</span>
            <input type="email" autoComplete="email" inputMode="email" autoCapitalize="off" placeholder="Email ID" value={email} onChange={(e) => setEmail(e.target.value)} className={inputClass} />
          </label>
          <label>
            <span className="sr-only">Password</span>
            <input
              type="password"
              autoComplete="current-password"
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={inputClass}
            />
          </label>
          {error && <InlineError>{error}</InlineError>}
          <Button type="submit" loading={busy} className="mt-3 min-h-12 w-full md:min-h-0">
            Login
          </Button>
        </form>
      </div>

      {config.data?.devLoginEnabled && (
        <button
          type="button"
          onClick={() => run(api.devLogin)}
          disabled={busy}
          className="mt-4 min-h-11 w-full text-center text-xs text-ink-subtle hover:text-ink-muted md:min-h-0"
        >
          Local testing: continue as demo user
        </button>
      )}
    </div>
  );
}

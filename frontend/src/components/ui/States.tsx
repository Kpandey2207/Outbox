import type { ReactNode } from "react";
import { AlertCircle, Inbox } from "lucide-react";
import { Button } from "./Button";

export function EmptyState({ title, message, action }: { title: string; message?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-24 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-surface-muted text-ink-subtle">
        <Inbox className="h-6 w-6" />
      </div>
      <h3 className="text-base font-semibold">{title}</h3>
      {message && <p className="max-w-sm text-sm text-ink-muted">{message}</p>}
      {action}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-24 text-center" role="alert">
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-failed-bg text-failed-fg">
        <AlertCircle className="h-6 w-6" />
      </div>
      <h3 className="text-base font-semibold">Something went wrong</h3>
      <p className="max-w-sm text-sm text-ink-muted">{message}</p>
      {onRetry && (
        <Button variant="outline" pill onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

export function InlineError({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-center gap-1.5 text-xs text-failed-fg" role="alert">
      <AlertCircle className="h-3.5 w-3.5" />
      {children}
    </p>
  );
}

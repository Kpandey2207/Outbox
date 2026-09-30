import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-3 text-center">
      <h1 className="text-xl font-semibold">Page not found</h1>
      <Link href="/scheduled" className="text-sm font-medium text-brand-600 hover:underline">
        Back to your emails
      </Link>
    </div>
  );
}

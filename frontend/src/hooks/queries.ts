"use client";

import { keepPreviousData, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { EmailStatus, EmailView } from "@/lib/types";

export const queryKeys = {
  me: ["me"] as const,
  counts: ["counts"] as const,
  emails: (view: EmailView, q: string, only?: EmailStatus) => ["emails", view, q, only ?? "all"] as const,
  email: (id: string) => ["email", id] as const,
};

export function useMe() {
  return useQuery({ queryKey: queryKeys.me, queryFn: api.me, retry: false });
}

export function useCounts() {
  return useQuery({ queryKey: queryKeys.counts, queryFn: api.counts, refetchInterval: 5_000 });
}

/**
 * Pages of 50 behind a "Load more" button. Polls so rows move from Scheduled to Sent live
 * while the worker runs (every loaded page is refreshed).
 */
export function useEmails(view: EmailView, q: string, only?: EmailStatus) {
  return useInfiniteQuery({
    queryKey: queryKeys.emails(view, q, only),
    queryFn: ({ pageParam }) => api.emails(view, q, pageParam, only),
    initialPageParam: 1,
    // The API pages up to 500; past that, narrow the list with search or a filter.
    getNextPageParam: (last) => (last.page * last.pageSize < last.total && last.page < 500 ? last.page + 1 : undefined),
    // Pages are fetched at different moments while mail is sent, so a row can move from one
    // page to the next between fetches. Show each email once.
    select: (data) => {
      const seen = new Set<string>();
      const items = data.pages.flatMap((p) => p.items).filter((e) => !seen.has(e.id) && seen.add(e.id));
      return { items, total: data.pages[0]?.total ?? 0 };
    },
    placeholderData: keepPreviousData,
    refetchInterval: 5_000,
  });
}

export function useEmail(id: string) {
  return useQuery({
    queryKey: queryKeys.email(id),
    queryFn: () => api.email(id),
    refetchInterval: (q) => (q.state.data && ["scheduled", "sending"].includes(q.state.data.status) ? 5_000 : false),
  });
}

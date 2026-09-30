import type {
  Attachment,
  CreateCampaignInput,
  CreateCampaignResult,
  Email,
  EmailPage,
  EmailStatus,
  EmailView,
  Me,
  ParsedLeads,
  Sender,
} from "./types";

const PAGE_SIZE = 50;

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    credentials: "include",
    ...init,
    headers: {
      ...(init.body && !(init.body instanceof FormData) ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = data?.error ?? {};
    throw new ApiError(res.status, err.code ?? "error", err.message ?? `Request failed (${res.status})`, err.details);
  }
  return data as T;
}

export const api = {
  authConfig: () => request<{ googleEnabled: boolean; devLoginEnabled: boolean }>("/auth/config"),
  /** Signs in, or creates the account if the email is new ("or sign up through email"). */
  emailSignIn: (email: string, password: string) =>
    request<{ ok: true; created: boolean }>("/auth/email", { method: "POST", body: JSON.stringify({ email, password }) }),
  devLogin: () => request<{ ok: true }>("/auth/dev-login", { method: "POST" }),
  logout: () => request<void>("/auth/logout", { method: "POST" }),
  me: () => request<Me>("/api/me"),

  emails: (view: EmailView, q: string, page = 1, only?: EmailStatus) => {
    const params = new URLSearchParams({ status: view, page: String(page), pageSize: String(PAGE_SIZE) });
    if (q) params.set("q", q);
    if (only) params.set("only", only);
    return request<EmailPage>(`/api/emails?${params}`);
  },
  counts: () => request<Record<EmailView, number>>("/api/emails/counts"),
  email: (id: string) => request<Email>(`/api/emails/${encodeURIComponent(id)}`),
  updateEmail: (id: string, flags: { starred?: boolean; archived?: boolean }) =>
    request<Email>(`/api/emails/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(flags) }),
  /** Removes it from every mailbox; a scheduled email is cancelled and never sent. */
  deleteEmail: (id: string) => request<void>(`/api/emails/${encodeURIComponent(id)}`, { method: "DELETE" }),

  addSender: () => request<Sender>("/api/senders", { method: "POST", body: JSON.stringify({}) }),

  parseLeads: (file: File) => {
    const form = new FormData();
    form.append("file", file);
    return request<ParsedLeads>("/api/leads/parse", { method: "POST", body: form });
  },

  uploadAttachments: (files: File[]) => {
    const form = new FormData();
    for (const f of files) form.append("files", f);
    return request<{ items: Attachment[] }>("/api/attachments", { method: "POST", body: form });
  },
  removeAttachment: (id: string) => request<void>(`/api/attachments/${encodeURIComponent(id)}`, { method: "DELETE" }),
  attachmentUrl: (id: string) => `/api/attachments/${encodeURIComponent(id)}`,

  /** The key makes a double click or network retry return the same campaign. */
  createCampaign: (input: CreateCampaignInput, idempotencyKey: string) =>
    request<CreateCampaignResult>("/api/campaigns", {
      method: "POST",
      body: JSON.stringify(input),
      headers: { "Idempotency-Key": idempotencyKey },
    }),

  testSlack: () => request<{ ok: true }>("/api/integrations/slack/test", { method: "POST" }),
  disconnectSlack: () => request<void>("/api/integrations/slack", { method: "DELETE" }),
};

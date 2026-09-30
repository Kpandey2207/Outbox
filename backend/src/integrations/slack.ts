import { WebClient } from '@slack/web-api';
import { env } from '../config/env.js';

/**
 * Slack's client errors carry the HTTP request they made, which holds the bot token or the
 * client secret. Everything leaving this module is re-thrown as a plain error with only
 * Slack's error code, so nothing upstream can log a credential by accident.
 */
export class SlackError extends Error {
  constructor(public readonly slackCode: string) {
    super(`Slack API error: ${slackCode}`);
    this.name = 'SlackError';
  }
}

async function clean<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    const e = err as { data?: { error?: string }; code?: string };
    throw new SlackError(e.data?.error ?? e.code ?? 'request_failed');
  }
}

const SLACK_SCOPES = ['chat:write', 'incoming-webhook'];

export function isSlackConfigured(): boolean {
  return Boolean(env.SLACK_CLIENT_ID && env.SLACK_CLIENT_SECRET);
}

function slackRedirectUri(): string {
  return `${env.API_URL}/integrations/slack/callback`;
}

export function slackAuthorizeUrl(state: string): string {
  const url = new URL('https://slack.com/oauth/v2/authorize');
  url.searchParams.set('client_id', env.SLACK_CLIENT_ID ?? '');
  url.searchParams.set('scope', SLACK_SCOPES.join(','));
  url.searchParams.set('redirect_uri', slackRedirectUri());
  url.searchParams.set('state', state);
  return url.toString();
}

export interface SlackOAuthResult {
  teamId: string;
  teamName: string | null;
  botToken: string;
  channelId: string;
  channelName: string | null;
  /** Posts to the channel picked during install, whether or not the bot is a member. */
  webhookUrl: string | null;
}

/** Exchanges the OAuth code. The incoming-webhook scope makes Slack ask the user for a channel. */
export async function exchangeSlackCode(code: string): Promise<SlackOAuthResult> {
  const res = await clean(() =>
    new WebClient(undefined, { timeout: 10_000 }).oauth.v2.access({
      client_id: env.SLACK_CLIENT_ID!,
      client_secret: env.SLACK_CLIENT_SECRET!,
      code,
      redirect_uri: slackRedirectUri(),
    }),
  );
  if (!res.ok || !res.access_token || !res.team?.id || !res.incoming_webhook?.channel_id) {
    throw new SlackError(res.error ?? 'missing_token_or_channel');
  }
  return {
    teamId: res.team.id,
    teamName: res.team.name ?? null,
    botToken: res.access_token,
    channelId: res.incoming_webhook.channel_id,
    channelName: res.incoming_webhook.channel ?? null,
    webhookUrl: isSlackWebhookUrl(res.incoming_webhook.url) ? res.incoming_webhook.url : null,
  };
}

const isSlackWebhookUrl = (url: string | undefined): url is string =>
  typeof url === 'string' && url.startsWith('https://hooks.slack.com/');

/** Posts through the install's incoming webhook. Slack answers with a plain-text error code. */
async function postViaWebhook(url: string, text: string, blocks?: unknown[]) {
  let res: globalThis.Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, ...(blocks ? { blocks } : {}) }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    throw new SlackError('request_failed');
  }
  if (!res.ok) {
    const code = (await res.text().catch(() => '')).trim().slice(0, 60);
    throw new SlackError(/^[a-z_]+$/.test(code) ? code : `http_${res.status}`);
  }
}

/**
 * Sends to the channel chosen at install. The incoming webhook is preferred because the bot
 * token can only post where the bot was invited (`not_in_channel` otherwise); installs from
 * before webhooks were stored fall back to chat.postMessage.
 */
export async function postToInstall(
  install: { bot_token: string; channel_id: string; webhook_url: string | null },
  text: string,
  blocks?: unknown[],
) {
  if (install.webhook_url) return postViaWebhook(install.webhook_url, text, blocks);
  return postSlackMessage(install.bot_token, install.channel_id, text, blocks);
}

async function postSlackMessage(botToken: string, channel: string, text: string, blocks?: unknown[]) {
  const client = new WebClient(botToken, { timeout: 5_000, retryConfig: { retries: 1 } });
  await clean(() => client.chat.postMessage({ channel, text, ...(blocks ? { blocks: blocks as never } : {}) }));
}

/** Invalidates the token at Slack, so a disconnected install cannot post even if the row leaked. */
export async function revokeSlackToken(botToken: string): Promise<void> {
  await clean(() => new WebClient(botToken, { timeout: 5_000, retryConfig: { retries: 0 } }).auth.revoke());
}

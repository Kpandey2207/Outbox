import { OAuth2Client } from 'google-auth-library';
import { env } from '../config/env.js';

export function isGoogleConfigured(): boolean {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
}

function client(): OAuth2Client {
  return new OAuth2Client({
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    redirectUri: `${env.API_URL}/auth/google/callback`,
  });
}

export function googleAuthorizeUrl(state: string): string {
  return client().generateAuthUrl({
    access_type: 'online',
    prompt: 'select_account',
    scope: ['openid', 'email', 'profile'],
    state,
  });
}

export interface GoogleProfile {
  googleId: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
}

/** Exchanges the code and verifies the ID token's signature, audience and expiry. */
export async function exchangeGoogleCode(code: string): Promise<GoogleProfile> {
  const oauth = client();
  const { tokens } = await oauth.getToken(code);
  if (!tokens.id_token) throw new Error('Google did not return an ID token');
  const ticket = await oauth.verifyIdToken({ idToken: tokens.id_token, audience: env.GOOGLE_CLIENT_ID! });
  const payload = ticket.getPayload();
  if (!payload?.sub || !payload.email || !payload.email_verified) {
    throw new Error('Google account has no verified email');
  }
  return {
    googleId: payload.sub,
    email: payload.email,
    name: payload.name ?? null,
    avatarUrl: payload.picture ?? null,
  };
}

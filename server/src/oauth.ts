export interface OAuthIdentity {
  /** Stable id at the provider; never changes when the user renames themselves. */
  subject: string;
  displayName: string;
}

export interface OAuthProvider {
  authorizeUrl(opts: { state: string; redirectUri: string }): string;
  /** Trade the authorization code for the user's identity. Throws on any failure. */
  exchange(code: string, redirectUri: string): Promise<OAuthIdentity>;
}

export interface OAuthSettings {
  providers: Record<string, OAuthProvider>;
  /** Origin the providers redirect back to: this API, as seen by browsers. */
  publicApiUrl: string;
  /** The client page to send the browser to after sign-in. */
  clientUrl: string;
}

type Fetch = typeof fetch;

/** Discord: authorization-code flow, `identify` scope only. */
export function discordProvider(cfg: { clientId: string; clientSecret: string; fetch?: Fetch }): OAuthProvider {
  const doFetch = cfg.fetch ?? fetch;
  return {
    authorizeUrl({ state, redirectUri }) {
      const q = new URLSearchParams({
        client_id: cfg.clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: "identify",
        state,
        prompt: "none", // skip the consent screen when the user already approved
      });
      return `https://discord.com/oauth2/authorize?${q}`;
    },
    async exchange(code, redirectUri) {
      const tokenRes = await doFetch("https://discord.com/api/oauth2/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
          client_id: cfg.clientId,
          client_secret: cfg.clientSecret,
        }),
      });
      if (!tokenRes.ok) throw new Error(`discord token exchange failed: ${tokenRes.status}`);
      const { access_token } = (await tokenRes.json()) as { access_token?: string };
      if (!access_token) throw new Error("discord returned no access token");

      const meRes = await doFetch("https://discord.com/api/users/@me", {
        headers: { Authorization: `Bearer ${access_token}` },
      });
      if (!meRes.ok) throw new Error(`discord profile failed: ${meRes.status}`);
      const me = (await meRes.json()) as { id?: string; username?: string; global_name?: string | null };
      if (!me.id) throw new Error("discord returned no user id");
      return { subject: me.id, displayName: (me.global_name || me.username || "Discord user").slice(0, 64) };
    },
  };
}

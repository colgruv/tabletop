import { execFileSync } from "node:child_process";
import { discordProvider, type OAuthProvider, type OAuthSettings } from "./oauth";

const SSM_PREFIX = "/tabletop/";

/** Settings kept in SSM Parameter Store, keyed by name without the prefix. */
export function readSsmParams(region = process.env.AWS_REGION ?? "us-east-1"): Record<string, string> {
  try {
    const out = execFileSync(
      "aws",
      [
        "ssm", "get-parameters-by-path", "--path", SSM_PREFIX, "--with-decryption",
        "--region", region, "--query", "Parameters[].[Name,Value]", "--output", "json",
      ],
      { encoding: "utf8", timeout: 15_000 },
    );
    const pairs = JSON.parse(out) as [string, string][];
    return Object.fromEntries(pairs.map(([name, value]) => [name.slice(SSM_PREFIX.length), value]));
  } catch (err) {
    console.warn(`could not read ${SSM_PREFIX}* from SSM: ${err instanceof Error ? err.message : err}`);
    return {};
  }
}

/**
 * OAuth settings from environment variables (dev) or, in production, from SSM.
 * Environment variables win. Returns undefined when no provider is configured,
 * which leaves sign-in switched off.
 */
export function loadOAuthSettings(
  env: NodeJS.ProcessEnv = process.env,
  readParams: () => Record<string, string> = readSsmParams,
): OAuthSettings | undefined {
  const production = env.NODE_ENV === "production";
  const params = production ? readParams() : {};
  const get = (name: string) => env[name.toUpperCase().replaceAll("-", "_")] ?? params[name];

  const providers: Record<string, OAuthProvider> = {};
  const discordId = get("discord-client-id");
  const discordSecret = get("discord-client-secret");
  if (discordId && discordSecret) providers.discord = discordProvider({ clientId: discordId, clientSecret: discordSecret });

  if (Object.keys(providers).length === 0) return undefined;
  const publicApiUrl = get("public-api-url") ?? (production ? undefined : "http://localhost:5173");
  const clientUrl = get("client-url") ?? (production ? undefined : "http://localhost:5173/");
  if (!publicApiUrl || !clientUrl) {
    console.warn("OAuth providers are configured but public-api-url / client-url are not; sign-in is off");
    return undefined;
  }
  return { providers, publicApiUrl: publicApiUrl.replace(/\/$/, ""), clientUrl: clientUrl.split("#")[0]! };
}

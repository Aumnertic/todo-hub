import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { ApiError, type Actor, type Env } from "./types";

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function jwks(team: string) {
  let set = jwksCache.get(team);
  if (!set) {
    set = createRemoteJWKSet(new URL(`https://${team}/cdn-cgi/access/certs`));
    jwksCache.set(team, set);
  }
  return set;
}

interface AccessClaims extends JWTPayload {
  email?: string;
  common_name?: string; // service token 的 client id
}

/**
 * 认出调用方。线上：校验 CF Access 注入的 JWT
 *   - 人：Access 登录 → email
 *   - Agent：service token → common_name = client id
 * 本地：DEV_AUTH=1 时可用 X-Dev-Actor: <actor id>
 */
export async function authenticate(req: Request, env: Env): Promise<Actor> {
  if (env.DEV_AUTH === "1") {
    const dev = req.headers.get("X-Dev-Actor");
    if (dev) return lookup(env, "id", dev);
  }

  const token = req.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) throw new ApiError(401, "unauthenticated", "missing Cf-Access-Jwt-Assertion");
  if (!env.ACCESS_AUD || !env.ACCESS_TEAM_DOMAIN) {
    throw new ApiError(500, "misconfigured", "ACCESS_AUD / ACCESS_TEAM_DOMAIN not set");
  }

  let claims: AccessClaims;
  try {
    ({ payload: claims } = await jwtVerify<AccessClaims>(token, jwks(env.ACCESS_TEAM_DOMAIN), {
      issuer: `https://${env.ACCESS_TEAM_DOMAIN}`,
      audience: env.ACCESS_AUD,
    }));
  } catch {
    throw new ApiError(401, "unauthenticated", "invalid Access token");
  }

  if (claims.email) return lookup(env, "email", claims.email.toLowerCase());
  if (claims.common_name) return lookup(env, "access_client_id", claims.common_name);
  throw new ApiError(401, "unauthenticated", "Access token has neither email nor common_name");
}

async function lookup(env: Env, col: "id" | "email" | "access_client_id", value: string): Promise<Actor> {
  const actor = await env.DB.prepare(
    `SELECT * FROM actors WHERE ${col} = ? AND active = 1 AND kind IN ('human', 'agent')`,
  )
    .bind(value)
    .first<Actor>();
  if (!actor) throw new ApiError(403, "unknown_actor", `no active actor for ${col}=${value}`);
  return actor;
}

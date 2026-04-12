import { CognitoJwtVerifier } from "aws-jwt-verify";

const USER_POOL_ID = process.env["COGNITO_USER_POOL_ID"] ?? "";
const CLIENT_ID = process.env["COGNITO_CLIENT_ID"] ?? "";

let _verifier: ReturnType<typeof CognitoJwtVerifier.create> | null = null;

export function getJwtVerifier(): ReturnType<typeof CognitoJwtVerifier.create> {
  if (!_verifier) {
    _verifier = CognitoJwtVerifier.create({
      userPoolId: USER_POOL_ID,
      tokenUse: "id",
      clientId: CLIENT_ID,
    });
  }
  return _verifier;
}

export interface VerifiedClaims {
  sub: string;
  email?: string;
}

export async function verifyJwt(token: string): Promise<VerifiedClaims> {
  const verifier = getJwtVerifier();
  const payload = await verifier.verify(token);
  return {
    sub: payload.sub,
    email: typeof payload["email"] === "string" ? payload["email"] : undefined,
  };
}

export function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader?.startsWith("Bearer ")) return null;
  return authHeader.slice(7);
}

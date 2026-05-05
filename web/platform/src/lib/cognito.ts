// Thin wrapper around amazon-cognito-identity-js for the platform site.
//
// Mirrors the macOS app's CognitoEmailAuth.swift logic: the user pool is
// configured with `alias_attributes = ["email"]`, so the actual Cognito
// Username MUST be a UUID (not the email). The email is set as a user
// attribute and resolves as a sign-in alias *after* email verification.
// Pre-confirmation, only the UUID username works for confirmSignUp /
// resendConfirmationCode — so we stash the username in localStorage
// keyed by email until confirmation completes.

import {
  AuthenticationDetails,
  CognitoUser,
  CognitoUserAttribute,
  CognitoUserPool,
  CognitoUserSession,
  type ISignUpResult,
} from "amazon-cognito-identity-js";

const USER_POOL_ID = import.meta.env.PUBLIC_COGNITO_USER_POOL_ID;
const CLIENT_ID = import.meta.env.PUBLIC_COGNITO_CLIENT_ID;

const PENDING_USERNAME_PREFIX = "knowable.pendingUsername:";

export const isCognitoConfigured = Boolean(USER_POOL_ID && CLIENT_ID);

// Lazy-construct so SSR/build-time imports don't blow up when env vars
// are absent (Astro evaluates module-level code during static build).
let _userPool: CognitoUserPool | null = null;
export function userPool(): CognitoUserPool {
  if (!_userPool) {
    if (!USER_POOL_ID || !CLIENT_ID) {
      throw new Error(
        "Cognito not configured: set PUBLIC_COGNITO_USER_POOL_ID and PUBLIC_COGNITO_CLIENT_ID at build time."
      );
    }
    _userPool = new CognitoUserPool({
      UserPoolId: USER_POOL_ID,
      ClientId: CLIENT_ID,
    });
  }
  return _userPool;
}

export interface Session {
  idToken: string;
  accessToken: string;
  email: string | null;
  sub: string | null;
  displayName: string | null;
}

function uuid(): string {
  // crypto.randomUUID is widely available; fallback for very old browsers.
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Minimal RFC4122 v4 fallback.
  const r = (Math.random() * 0x100000000) >>> 0;
  return `${Date.now().toString(16)}-${r.toString(16)}-4xxx-yxxx-xxxxxxxxxxxx`.replace(
    /[xy]/g,
    (c) => {
      const v = (Math.random() * 16) | 0;
      const out = c === "x" ? v : (v & 0x3) | 0x8;
      return out.toString(16);
    }
  );
}

function rememberPendingUsername(email: string, username: string): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(
    `${PENDING_USERNAME_PREFIX}${email.toLowerCase()}`,
    username
  );
}

function recallPendingUsername(email: string): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(
    `${PENDING_USERNAME_PREFIX}${email.toLowerCase()}`
  );
}

function clearPendingUsername(email: string): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(`${PENDING_USERNAME_PREFIX}${email.toLowerCase()}`);
}

// MARK: - Sign Up

export interface SignUpResult {
  username: string; // Cognito UUID (caller doesn't need it but useful for tests)
}

export function signUp(
  email: string,
  password: string,
  displayName: string
): Promise<SignUpResult> {
  return new Promise((resolve, reject) => {
    const username = uuid().toLowerCase();
    const attributes: CognitoUserAttribute[] = [
      new CognitoUserAttribute({ Name: "email", Value: email }),
    ];
    // We don't add `name` as a Cognito attribute because the pool schema
    // (cognito.tf) only declares `email`. The displayName lives in the
    // DynamoDB roles table (written by /educator/register after signup).
    void displayName;

    userPool().signUp(
      username,
      password,
      attributes,
      [],
      (err, _result?: ISignUpResult) => {
        if (err) {
          reject(err);
          return;
        }
        rememberPendingUsername(email, username);
        resolve({ username });
      }
    );
  });
}

// MARK: - Confirm Sign Up

export function confirmSignUp(email: string, code: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const username = recallPendingUsername(email);
    if (!username) {
      reject(
        new Error(
          "We lost track of your signup — please start the signup form over."
        )
      );
      return;
    }
    const cognitoUser = new CognitoUser({
      Username: username,
      Pool: userPool(),
    });
    cognitoUser.confirmRegistration(code, true, (err) => {
      if (err) {
        reject(err);
        return;
      }
      clearPendingUsername(email);
      resolve();
    });
  });
}

// MARK: - Sign In

export function signIn(email: string, password: string): Promise<Session> {
  return new Promise((resolve, reject) => {
    // Once email is verified it resolves as an alias, so signing in by
    // email Just Works on the second auth call onward.
    const cognitoUser = new CognitoUser({
      Username: email,
      Pool: userPool(),
    });
    const authDetails = new AuthenticationDetails({
      Username: email,
      Password: password,
    });
    cognitoUser.authenticateUser(authDetails, {
      onSuccess: (session) => {
        resolve(sessionFromCognito(session, email));
      },
      onFailure: (err) => {
        reject(err);
      },
      // newPasswordRequired and mfaRequired are not configured in our pool;
      // fail loudly if they ever trigger so we notice the misconfig.
      newPasswordRequired: () => {
        reject(new Error("Server requested a new password — unsupported flow."));
      },
      mfaRequired: () => {
        reject(new Error("Server requested MFA — unsupported flow."));
      },
    });
  });
}

// MARK: - Sign Out

export function signOut(): void {
  const user = userPool().getCurrentUser();
  if (user) {
    user.signOut();
  }
}

// MARK: - Get Current Session

export function getCurrentSession(): Promise<Session | null> {
  return new Promise((resolve) => {
    const user = userPool().getCurrentUser();
    if (!user) {
      resolve(null);
      return;
    }
    user.getSession((err: Error | null, session: CognitoUserSession | null) => {
      if (err || !session || !session.isValid()) {
        resolve(null);
        return;
      }
      // Pull email out of the id-token payload — that's what we'll display.
      const payload = session.getIdToken().decodePayload() as Record<string, unknown>;
      const email = (payload.email as string | undefined) ?? null;
      const sub = (payload.sub as string | undefined) ?? null;
      resolve({
        idToken: session.getIdToken().getJwtToken(),
        accessToken: session.getAccessToken().getJwtToken(),
        email,
        sub,
        // displayName lives server-side in DynamoDB (/educator/register
        // wrote it). Fetched lazily by callers that need it.
        displayName: null,
      });
    });
  });
}

function sessionFromCognito(
  session: CognitoUserSession,
  fallbackEmail: string
): Session {
  const payload = session.getIdToken().decodePayload() as Record<string, unknown>;
  const email = (payload.email as string | undefined) ?? fallbackEmail;
  const sub = (payload.sub as string | undefined) ?? null;
  return {
    idToken: session.getIdToken().getJwtToken(),
    accessToken: session.getAccessToken().getJwtToken(),
    email,
    sub,
    displayName: null,
  };
}

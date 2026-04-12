export interface TurnstileResult {
  success: boolean;
  errorCodes?: string[];
}

export async function verifyTurnstileToken(
  token: string,
  secret: string,
  remoteIp?: string
): Promise<TurnstileResult> {
  const body = new URLSearchParams({ secret, response: token });
  if (remoteIp) {
    body.set("remoteip", remoteIp);
  }

  let lastError: unknown;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });

      const data = (await res.json()) as {
        success: boolean;
        "error-codes"?: string[];
      };

      return {
        success: data.success,
        errorCodes: data["error-codes"],
      };
    } catch (err) {
      lastError = err;
      if (attempt === 0) {
        // One retry on network error
        continue;
      }
    }
  }

  throw lastError;
}

/// <reference path="../.astro/types.d.ts" />

interface ImportMetaEnv {
  readonly PUBLIC_COGNITO_USER_POOL_ID: string;
  readonly PUBLIC_COGNITO_CLIENT_ID: string;
  readonly PUBLIC_API_BASE_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

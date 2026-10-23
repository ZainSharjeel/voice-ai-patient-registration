/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_CONVEX_URL: string;
  readonly VITE_VIKTOR_AUTH_CLIENT_ID?: string;
  readonly VITE_VIKTOR_SPACES_ACCESS_MODE?: string;
  readonly VITE_VIKTOR_SPACES_API_URL?: string;
  readonly VITE_VIKTOR_SPACES_AUTH_PROVIDERS?: string;
  readonly VITE_VIKTOR_SPACES_ENVIRONMENT?: string;
  readonly VITE_VIKTOR_SPACES_SPACE_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

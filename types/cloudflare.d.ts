interface Fetcher {
  fetch(input: Request | string | URL, init?: RequestInit): Promise<Response>;
}

declare const d1DatabaseBrand: unique symbol;

interface D1Database {
  readonly [d1DatabaseBrand]?: true;
}

declare module "cloudflare:workers" {
  export const env: {
    DB?: D1Database;
    [key: string]: unknown;
  };
}

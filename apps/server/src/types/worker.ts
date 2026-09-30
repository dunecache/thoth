import type { DurableObjectNamespace } from '@cloudflare/workers-types';

export interface Env {
  VERSION?: string;
  ENVIRONMENT?: string;
  VAULT_DO?: DurableObjectNamespace;
  /**
   * ISO 8601 date after which device credentials are required on the data
   * routes. Before it, a keyless request is still accepted so a client
   * predating authentication keeps syncing.
   *
   * A missing or unparseable value means enforcement is already on. Failing
   * open here would silently disable authentication on a typo.
   */
  AUTH_ENFORCED_AFTER?: string;
}

/**
 * Client for the provisioning API.
 *
 * EVERY endpoint here is public and unauthenticated — the backend documents
 * each one as "public, no auth required" / "auth disabled". Do NOT add auth
 * headers, session reads, or engine sign-in to this module:
 * src/test/provisioning-hardening.test.ts pins that property by reading this
 * file's source, and the production /app/provision flow must work for an
 * operator who is not signed into any backend.
 */
/**
 * Base URL for the public provisioning API.
 *
 * Reads VITE_API_URL when set (e.g. to point at a custom backend domain).
 * Falls back to the same-origin relative path, which on Vercel is rewritten
 * by vercel.json to the backend (avoiding CORS), and locally is proxied by
 * Vite to http://localhost:8000.
 */
const API_BASE_URL = (import.meta.env.VITE_API_URL ?? '/api/v1/provisioning').replace(/\/+$/, '');

export interface BootstrapRequest {
  identity: string;
  wan_interface: string;
  /** Which services the router should be enrolled with: hotspot, pppoe, or both. */
  service_mode?: 'hotspot' | 'pppoe' | 'both';
  /** LAN interface for the HotSpot server (e.g. ether2). */
  hotspot_interface?: string;
  /** Interface for the PPPoE server (e.g. ether3). */
  pppoe_interface?: string;
}

export interface BootstrapResponse {
  session_id: string;
  bootstrap_command: string;
  /** Router row id created/found by the public bootstrap call; the wizard uses it for scan + workflow. */
  router_id?: number;
}

export interface ProvisioningRequest {
  router_id: number;
  service_type: 'hotspot' | 'pppoe_server' | 'both';
  configuration: Record<string, any>;
}

export interface ProvisioningResponse {
  session_id: string;
  status: string;
  message: string;
}

export interface SessionStatusResponse {
  session_id: string;
  status: string;
  current_step: string | null;
  progress: number | null;
  steps: Array<Record<string, any>> | null;
  error_message: string | null;
}

export async function generateBootstrapCommand(data: BootstrapRequest): Promise<BootstrapResponse> {
  const payload: Record<string, string> = {
    identity: data.identity || 'Router-1',
    wan_interface: data.wan_interface || 'ether1',
  };

  // Only include the service selection and interface assignments when they are
  // actually provided, so plain identity/WAN-only calls stay minimal.
  if (data.service_mode) payload.service_mode = data.service_mode;
  if (data.hotspot_interface) payload.hotspot_interface = data.hotspot_interface;
  if (data.pppoe_interface) payload.pppoe_interface = data.pppoe_interface;

  const response = await fetch(`${API_BASE_URL}/bootstrap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(errorText || 'Failed to generate bootstrap command');
  }

  return response.json();
}

export async function startProvisioningWorkflow(data: ProvisioningRequest): Promise<ProvisioningResponse> {
  const response = await fetch(`${API_BASE_URL}/workflow`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(errorText || 'Failed to start provisioning workflow');
  }

  return response.json();
}

export async function fetchProvisioningSessionStatus(sessionId: string): Promise<SessionStatusResponse> {
  const response = await fetch(`${API_BASE_URL}/sessions/${sessionId}/status`, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(errorText || 'Failed to fetch session status');
  }

  return response.json();
}

export async function fetchProvisioningSessions(): Promise<PublicProvisionSession[]> {
  try {
    const response = await fetch(`${API_BASE_URL}/sessions`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });

    if (!response.ok) return [];
    return response.json();
  } catch {
    return [];
  }
}

/* ── Public wizard surface (bootstrap → device scan → workflow) ───────────── */

export type ProvisioningServiceType = 'hotspot' | 'pppoe_server' | 'both';

/** One row of `GET /sessions` (the public list endpoint). */
export interface PublicProvisionSession {
  id: string;
  identity: string;
  wan_interface: string;
  status: string;
  created_at: string | null;
  completed_at: string | null;
}

export interface ScanService {
  name: string;
  active: boolean;
  available: boolean;
}

export interface NetworkConfig {
  router_ip: string;
  router_ip_cidr: string;
  network: string;
  network_address: string;
  gateway: string;
  broadcast: string;
  dhcp_start: string;
  dhcp_end: string;
  dhcp_pool: string;
  subnet_mask: string;
  cidr: number;
  total_hosts: number;
  dns_servers: string[];
  current_subnet: string;
  wan_interface: string;
}

export interface DeviceScan {
  interfaces: string[];
  wan_interface: string;
  services: ScanService[];
  network_config: NetworkConfig;
  system_info: {
    identity: string;
    board_name: string;
    model: string;
    version: string;
    architecture: string;
    uptime: string | null;
  };
  current_subnet: string;
  available_services: string[];
}

/** Response of `GET /bootstrap/can-use-direct-api/{router_id}` (DB-only probe). */
export interface DirectApiStatus {
  can_use_direct_api: boolean;
  bootstrap_completed: boolean;
  provisioning_status: string;
  last_provisioned_at: string | null;
  agent_installed: boolean;
  agent_online: boolean;
  has_cached_scan: boolean;
}

/**
 * Turn a non-2xx response into an actionable message: prefer the backend's
 * JSON `detail`, and call out an HTML body explicitly — on the public
 * deployment that means the SPA fallback answered instead of the API (the
 * original prod /app/provision bug).
 */
async function toApiError(response: Response, fallback: string): Promise<Error> {
  const contentType = response.headers.get('content-type') ?? '';
  const text = await response.text().catch(() => '');
  if (contentType.includes('text/html') || /^\s*<!doctype html/i.test(text)) {
    return new Error(
      `${fallback} (HTTP ${response.status}): the server returned HTML instead of JSON — ` +
        'the API rewrite is likely serving the SPA instead of the backend.',
    );
  }
  try {
    const body = JSON.parse(text) as { detail?: unknown };
    if (typeof body.detail === 'string') return new Error(body.detail);
  } catch {
    /* not JSON - fall through to the raw/text message */
  }
  return new Error(text || `${fallback} (HTTP ${response.status})`);
}

/** Reads the device's interfaces / services / network config (public endpoint). */
export async function scanDevice(routerId: number, forceRescan = false): Promise<DeviceScan> {
  const response = await fetch(`${API_BASE_URL}/device/scan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ router_id: routerId, force_rescan: forceRescan }),
  });
  if (!response.ok) throw await toApiError(response, 'Device scan failed');
  return response.json();
}

/**
 * Cheap probe: reads only the router row — it NEVER dials the device — so the
 * wizard can poll it as fast as it likes even when the router sits behind NAT.
 * `has_cached_scan` flips when the bootstrap script's `POST /bootstrap/scan-report`
 * has been stored; `bootstrap_completed` flips when its `POST /bootstrap/notify` lands.
 */
export async function getDirectApiStatus(routerId: number): Promise<DirectApiStatus> {
  const response = await fetch(`${API_BASE_URL}/bootstrap/can-use-direct-api/${routerId}`, {
    headers: { 'Content-Type': 'application/json' },
  });
  if (!response.ok) throw await toApiError(response, 'Could not read the router status');
  return response.json();
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Wait for the router's phone-home scan report instead of hanging on a single
 * direct-dial scan. Behind NAT the direct dial fails, but the bootstrap script
 * POSTs its scan back to the engine, so an optimistic `scanDevice(false)` is
 * raced against a DB-only probe loop that reads the cache the moment the
 * report lands. On deadline it throws with an actionable message.
 */
export async function waitForScanReport(
  routerId: number,
  opts: {
    /** Overall budget for the report to arrive (default 120s). */
    deadlineMs?: number;
    /** Gap between probe polls (default 2s). */
    intervalMs?: number;
    /** Minimum gap between onProgress calls (default 6s). */
    progressIntervalMs?: number;
    /** Called with elapsed seconds while waiting, for progress UI. */
    onProgress?: (elapsedSeconds: number) => void;
  } = {},
): Promise<DeviceScan> {
  const deadlineMs = opts.deadlineMs ?? 120_000;
  const intervalMs = opts.intervalMs ?? 2_000;
  const progressIntervalMs = opts.progressIntervalMs ?? 6_000;
  const started = Date.now();
  let lastDetail = '';
  let lastProgressAt = 0;

  // Optimistic read: resolves instantly when the cache is warm or the router
  // is directly reachable (LAN). Behind NAT it rejects — swallowed here so
  // the probe loop below keeps waiting for the phone-home report.
  const eager = scanDevice(routerId, false).then(
    (s) => s,
    (e) => {
      lastDetail = e instanceof Error ? e.message : String(e);
      return null;
    },
  );
  // A null (failed) eager result must not win the race — only a real scan.
  const eagerWin = eager.then((s) => (s ? s : new Promise<never>(() => {})));

  const probeLoop = (async (): Promise<DeviceScan> => {
    for (;;) {
      try {
        const st = await getDirectApiStatus(routerId);
        if (st.has_cached_scan || st.bootstrap_completed) {
          // force_rescan=false → the backend serves the cache; it only dials
          // when the cache is empty (stale flag), in which case we keep polling.
          try {
            return await scanDevice(routerId, false);
          } catch (e) {
            lastDetail = e instanceof Error ? e.message : String(e);
          }
        }
      } catch (e) {
        // Probe failure (backend restart etc.) — retry until the deadline.
        lastDetail = e instanceof Error ? e.message : String(e);
      }

      const elapsed = Date.now() - started;
      if (elapsed >= deadlineMs) break;
      if (elapsed - lastProgressAt >= progressIntervalMs) {
        lastProgressAt = elapsed;
        opts.onProgress?.(Math.round(elapsed / 1000));
      }
      await sleep(intervalMs);
    }

    throw new Error(
      'No scan report from the router yet. Paste the bootstrap one-liner into ' +
        'the router terminal (Winbox: New Terminal), wait ~10 seconds for it ' +
        'to finish, then scan again — the wizard reads the report the router ' +
        'sends back, so it also works behind NAT.' +
        (lastDetail ? ` Last response: ${lastDetail}` : ''),
    );
  })();

  return Promise.race([eagerWin, probeLoop]);
}

/** Cancel stale PENDING/IN_PROGRESS sessions before reprovisioning (public endpoint). */
export async function cancelActiveSessions(routerId: number): Promise<{
  message: string;
  cancelled_count: number;
}> {
  const response = await fetch(`${API_BASE_URL}/router/${routerId}/cancel-active`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  if (!response.ok) throw await toApiError(response, 'Could not clear previous sessions');
  return response.json();
}
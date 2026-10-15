const API_BASE_URL = '/api/v1/provisioning';

export interface BootstrapRequest {
  identity: string;
  wan_interface: string;
}

export interface BootstrapResponse {
  session_id: string;
  bootstrap_command: string;
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
  const payload = {
    identity: data.identity || 'Router-1',
    wan_interface: data.wan_interface || 'ether1',
  };

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

export async function fetchProvisioningSessions() {
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
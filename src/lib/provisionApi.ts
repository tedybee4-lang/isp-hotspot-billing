const API_BASE_URL = '/api/v1/provisioning';

export interface BootstrapRequest {
  identity: string;
  wan_interface: string;
}

export interface BootstrapResponse {
  session_id: string;
  bootstrap_command: string;
}

export async function generateBootstrapCommand(data: BootstrapRequest): Promise<BootstrapResponse> {
  // Apply defaults for empty values
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
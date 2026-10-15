import React, { useState, useEffect } from 'react';
import { generateBootstrapCommand, fetchProvisioningSessions, startProvisioningWorkflow, fetchProvisioningSessionStatus } from '@/lib/provisionApi';
import { fetchNodes } from '@/lib/data';

// Type definitions for proper API response handling
interface ProvisioningSession {
  session_id: string;
  identity: string;
  wan_interface: string;
  status: string;
  service_type?: string;
}

interface Router {
  id: number;
  name: string;
  host?: string;
  ip_address?: string;
}

export default function RouterProvisioningPage() {
  const [identity, setIdentity] = useState('');
  const [wanInterface, setWanInterface] = useState('ether1');
  const [bootstrapCommand, setBootstrapCommand] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<ProvisioningSession[]>([]);
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [serviceType, setServiceType] = useState<'hotspot' | 'pppoe_server' | 'both'>('hotspot');
  const [routerId, setRouterId] = useState<number | null>(null);
  const [routers, setRouters] = useState<Router[]>([]);
  const [provisioningSessionId, setProvisioningSessionId] = useState<string | null>(null);
  const [workflowStatus, setWorkflowStatus] = useState<string | null>(null);
  const [showEnrollmentStep, setShowEnrollmentStep] = useState(false);
  const [enrollmentStep, setEnrollmentStep] = useState(0);
  
  const [hotspotInterface, setHotspotInterface] = useState('ether2');
  const [pppoeInterface, setPppoeInterface] = useState('ether3');
  const [useManualInterfaces, setUseManualInterfaces] = useState(false);

  const loadSessions = async () => {
    try {
      const data = await fetchProvisioningSessions();
      setSessions(Array.isArray(data) ? data : []);
    } catch (e) {
      console.error("Failed to load sessions:", e);
    }
  };

  const loadRouters = async () => {
    try {
      const data = await fetchNodes();
      setRouters(Array.isArray(data) ? data : []);
    } catch (e) {
      console.error("Failed to load routers:", e);
    }
  };

  useEffect(() => {
    loadSessions();
    loadRouters();
  }, []);

  const handleStartProvisioning = async () => {
    if (!routerId || !provisioningSessionId) {
      setError('Please select a router and generate bootstrap command first');
      return;
    }
    setError(null);
    setLoading(true);
    setWorkflowStatus('Starting provisioning workflow...');
    setShowEnrollmentStep(true);
    setEnrollmentStep(1);
    
    try {
      const configuration = {
        hotspot_interface: useManualInterfaces ? hotspotInterface : 'ether2',
        pppoe_interface: useManualInterfaces ? pppoeInterface : 'ether3',
        identity: identity || 'Router-1',
        wan_interface: wanInterface || 'ether1',
        service_type: serviceType,
      };
      
      const res = await startProvisioningWorkflow({
        router_id: routerId,
        service_type: serviceType,
        configuration
      });
      setProvisioningSessionId(res.session_id);
      setWorkflowStatus(res.message || 'Provisioning workflow started successfully');
      setEnrollmentStep(2);
      loadSessions();
    } catch (err: any) {
      setError(err.message || 'Error starting provisioning workflow. Please try again.');
      setWorkflowStatus(null);
      setShowEnrollmentStep(false);
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(bootstrapCommand);
      setCopyStatus('copied');
      setTimeout(() => setCopyStatus('idle'), 2000);
    } catch {
      setCopyStatus('failed');
      setTimeout(() => setCopyStatus('idle'), 2000);
    }
  };

  const handleGenerate = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    
    try {
      const res = await generateBootstrapCommand({
        identity: identity || 'Router-1',
        wan_interface: wanInterface || 'ether1',
      });
      setBootstrapCommand(res.bootstrap_command);
      setCopyStatus('idle');
      setProvisioningSessionId(res.session_id);
      loadSessions();
    } catch (err: any) {
      setError(err.message || 'Error generating command. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold mb-6">Router Provisioning</h1>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-md mb-6 text-sm font-medium">
          {error}
        </div>
      )}

      {/* Bootstrap a new router */}
      <div className="bg-white p-6 rounded-lg shadow-sm border mb-8">
        <h2 className="text-lg font-semibold mb-2">Bootstrap a new router</h2>
        <p className="text-sm text-gray-500 mb-6">
          Generates a RouterOS one-liner for the router to enroll itself.
        </p>

        <form onSubmit={handleGenerate} className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Router identity</label>
              <input
                type="text"
                value={identity}
                onChange={(e) => setIdentity(e.target.value)}
                placeholder="e.g. Office Router"
                className="w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500"
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">WAN interface</label>
              <input
                type="text"
                value={wanInterface}
                onChange={(e) => setWanInterface(e.target.value)}
                placeholder="ether1"
                className="w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500"
                required
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="mt-4 px-4 py-2 bg-indigo-600 text-white rounded-md hover:bg-indigo-700 disabled:opacity-50"
          >
            {loading ? 'Generating...' : 'Generate bootstrap command'}
          </button>
        </form>

        {bootstrapCommand && (
          <div className="mt-6 p-4 bg-gray-900 text-green-400 rounded-md font-mono text-sm overflow-x-auto relative">
            <div className="flex items-center justify-between mb-2">
              <p className="text-gray-400 text-xs"># Copy and paste into WinBox Terminal:</p>
              <button
                onClick={handleCopy}
                disabled={loading || copyStatus === 'copied'}
                className="px-3 py-1 text-xs bg-gray-700 text-gray-200 rounded hover:bg-gray-600 disabled:opacity-50 transition-colors"
              >
                {copyStatus === 'copied' ? (
                  <span className="text-green-400">✓ Copied!</span>
                ) : copyStatus === 'failed' ? (
                  <span className="text-red-400">Failed</span>
                ) : (
                  'Copy'
                )}
              </button>
            </div>
            <code>{bootstrapCommand}</code>
          </div>
        )}
      </div>

      {/* Provision Service */}
      {bootstrapCommand && (
        <div className="bg-white p-6 rounded-lg shadow-sm border mb-8">
          <h2 className="text-lg font-semibold mb-4">Provision Service</h2>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Router</label>
              <select
                value={routerId || ''}
                onChange={(e) => setRouterId(Number(e.target.value) || null)}
                className="w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500"
              >
                <option value="">Select a router...</option>
                {routers.map((r) => (
                  <option key={r.id} value={r.id}>{r.name || r.host || r.ip_address || r.id}</option>
                ))}
              </select>
            </div>
            
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Service Type</label>
              <select
                value={serviceType}
                onChange={(e) => setServiceType(e.target.value as any)}
                className="w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500"
              >
                <option value="hotspot">Hotspot</option>
                <option value="pppoe_server">PPPoE</option>
                <option value="both">Both (Hotspot + PPPoE)</option>
              </select>
            </div>

            {/* Manual interface configuration */}
            {(serviceType === 'hotspot' || serviceType === 'both') && (
              <div className="bg-blue-50 p-4 rounded-md">
                <h3 className="text-sm font-medium text-blue-900 mb-2">HotSpot Configuration</h3>
                <div className="flex items-center space-x-2 mb-3">
                  <input
                    type="checkbox"
                    id="useManualInterfaces"
                    checked={useManualInterfaces}
                    onChange={(e) => setUseManualInterfaces(e.target.checked)}
                    className="h-4 w-4 text-indigo-600"
                  />
                  <label htmlFor="useManualInterfaces" className="text-sm text-blue-800">
                    Use manual interface configuration (default: HotSpot on ether2)
                  </label>
                </div>
                {useManualInterfaces && (
                  <div>
                    <label className="block text-xs text-blue-700 mb-1">HotSpot Interface</label>
                    <input
                      type="text"
                      value={hotspotInterface}
                      onChange={(e) => setHotspotInterface(e.target.value)}
                      placeholder="ether2"
                      className="w-full px-2 py-1 text-sm border rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
                    />
                  </div>
                )}
              </div>
            )}

            {(serviceType === 'pppoe_server' || serviceType === 'both') && (
              <div className="bg-green-50 p-4 rounded-md">
                <h3 className="text-sm font-medium text-green-900 mb-2">PPPoE Configuration</h3>
                <div className="flex items-center space-x-2 mb-3">
                  <input
                    type="checkbox"
                    id="useManualPppoeInterfaces"
                    checked={useManualInterfaces}
                    onChange={(e) => setUseManualInterfaces(e.target.checked)}
                    className="h-4 w-4 text-green-600"
                  />
                  <label htmlFor="useManualPppoeInterfaces" className="text-sm text-green-800">
                    Use manual interface configuration (default: PPPoE on ether3)
                  </label>
                </div>
                {useManualInterfaces && (
                  <div>
                    <label className="block text-xs text-green-700 mb-1">PPPoE Interface</label>
                    <input
                      type="text"
                      value={pppoeInterface}
                      onChange={(e) => setPppoeInterface(e.target.value)}
                      placeholder="ether3"
                      className="w-full px-2 py-1 text-sm border rounded focus:outline-none focus:ring-1 focus:ring-green-500"
                    />
                  </div>
                )}
              </div>
            )}

            <button
              onClick={handleStartProvisioning}
              disabled={loading || !routerId}
              className="px-4 py-2 bg-green-600 text-white rounded-md hover:bg-green-700 disabled:opacity-50"
            >
              {loading ? 'Starting...' : 'Start Provisioning Workflow'}
            </button>
            {workflowStatus && (
              <div className="text-sm text-green-600 mt-2">
                {workflowStatus}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Provisioning sessions list */}
      <div className="bg-white p-6 rounded-lg shadow-sm border">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-lg font-semibold">Provisioning sessions</h2>
          <button onClick={loadSessions} className="px-3 py-1 text-sm border rounded-md hover:bg-gray-50">
            Refresh
          </button>
        </div>

        {sessions.length === 0 ? (
          <p className="text-sm text-gray-500">No active provisioning sessions found.</p>
        ) : (
          <div className="divide-y">
            {sessions.map((s, idx) => (
              <div key={s.session_id || idx} className="py-3 flex justify-between text-sm">
                <span>{s.identity || 'Router'} ({s.wan_interface || 'ether1'})</span>
                <span className="text-gray-500">{s.status || 'Pending'}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
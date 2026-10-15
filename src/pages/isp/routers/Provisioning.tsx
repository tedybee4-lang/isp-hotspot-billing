import React, { useState, useEffect } from 'react';
import { generateBootstrapCommand, fetchProvisioningSessions } from '@/lib/provisionApi';

export default function RouterProvisioningPage() {
  const [identity, setIdentity] = useState('');
  const [wanInterface, setWanInterface] = useState('ether1');
  const [bootstrapCommand, setBootstrapCommand] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<any[]>([]);
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'failed'>('idle');

  const loadSessions = async () => {
    try {
      const data = await fetchProvisioningSessions();
      setSessions(Array.isArray(data) ? data : []);
    } catch (e) {
      console.error("Failed to load sessions:", e);
    }
  };

  useEffect(() => {
    loadSessions();
  }, []);

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
              <div key={s.id || idx} className="py-3 flex justify-between text-sm">
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
import React, { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { generateBootstrapCommand } from '@/lib/provisionApi'

type ServiceMode = 'hotspot' | 'pppoe' | 'both'

const SERVICE_MODES: Array<{ value: ServiceMode; label: string; hint: string }> = [
  { value: 'hotspot', label: 'HotSpot', hint: 'Voucher & captive-portal Wi-Fi access' },
  { value: 'pppoe', label: 'PPPoE', hint: 'Username/password broadband sessions' },
  { value: 'both', label: 'Both (HotSpot & PPPoE)', hint: 'Run HotSpot and PPPoE on the same router' },
]

export default function RouterProvisioningPage() {
  const navigate = useNavigate()

  const [identity, setIdentity] = useState('')
  const [wanInterface, setWanInterface] = useState('ether1')
  const [serviceMode, setServiceMode] = useState<ServiceMode>('hotspot')
  const [hotspotInterface, setHotspotInterface] = useState('ether2')
  const [pppoeInterface, setPppoeInterface] = useState('ether3')

  const [bootstrapCommand, setBootstrapCommand] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'failed'>('idle')

  const showHotspotPort = serviceMode === 'hotspot' || serviceMode === 'both'
  const showPppoePort = serviceMode === 'pppoe' || serviceMode === 'both'

  const handleGenerate = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setBootstrapCommand('')
    setLoading(true)

    try {
      const res = await generateBootstrapCommand({
        identity: identity.trim(),
        wan_interface: wanInterface.trim(),
        service_mode: serviceMode,
        hotspot_interface: showHotspotPort ? hotspotInterface.trim() : undefined,
        pppoe_interface: showPppoePort ? pppoeInterface.trim() : undefined,
      })
      setBootstrapCommand(res.bootstrap_command)
    } catch (err: any) {
      setError(err?.message || 'Failed to generate the bootstrap command. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(bootstrapCommand)
      setCopyStatus('copied')
    } catch {
      setCopyStatus('failed')
    }
    setTimeout(() => setCopyStatus('idle'), 2500)
  }

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold mb-1">Router Provisioning</h1>
        <p className="text-sm text-gray-500">
          Add a MikroTik router, pick the services it should run, then generate its one-line enrollment script.
        </p>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-md text-sm font-medium">
          {error}
        </div>
      )}

      <form onSubmit={handleGenerate} className="space-y-6">
        {/* Step 1: Router details */}
        <div className="bg-white p-6 rounded-lg shadow-sm border">
          <h2 className="text-lg font-semibold mb-1">1. Router details</h2>
          <p className="text-sm text-gray-500 mb-4">Name the router and tell us which port faces the internet.</p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Router identity</label>
              <input
                type="text"
                value={identity}
                onChange={(e) => setIdentity(e.target.value)}
                placeholder="e.g. Beta-Router"
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
        </div>

        {/* Step 2: Service mode and ports */}
        <div className="bg-white p-6 rounded-lg shadow-sm border">
          <h2 className="text-lg font-semibold mb-1">2. Service mode</h2>
          <p className="text-sm text-gray-500 mb-4">Choose which billing services this router should run.</p>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {SERVICE_MODES.map((mode) => (
              <button
                key={mode.value}
                type="button"
                onClick={() => setServiceMode(mode.value)}
                className={
                  'text-left p-4 rounded-lg border transition ' +
                  (serviceMode === mode.value
                    ? 'border-indigo-500 bg-indigo-50 ring-2 ring-indigo-500'
                    : 'border-gray-200 hover:border-gray-300 bg-white')
                }
              >
                <span className="block text-sm font-semibold text-gray-900">{mode.label}</span>
                <span className="block text-xs text-gray-500 mt-1">{mode.hint}</span>
              </button>
            ))}
          </div>

          {/* Dynamic port selection */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-5">
            {showHotspotPort && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">HotSpot LAN interface</label>
                <input
                  type="text"
                  value={hotspotInterface}
                  onChange={(e) => setHotspotInterface(e.target.value)}
                  placeholder="ether2"
                  className="w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
                <p className="text-xs text-gray-400 mt-1">The port your HotSpot clients connect to.</p>
              </div>
            )}
            {showPppoePort && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">PPPoE interface</label>
                <input
                  type="text"
                  value={pppoeInterface}
                  onChange={(e) => setPppoeInterface(e.target.value)}
                  placeholder="ether3"
                  className="w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
                <p className="text-xs text-gray-400 mt-1">The port your PPPoE clients connect to.</p>
              </div>
            )}
          </div>
        </div>

        {/* Step 3: Generate */}
        <div className="flex justify-end">
          <button
            type="submit"
            disabled={loading}
            className="px-6 py-2.5 bg-indigo-600 text-white font-medium rounded-md hover:bg-indigo-700 disabled:opacity-50"
          >
            {loading ? 'Generating...' : 'Generate Bootstrap Command'}
          </button>
        </div>
      </form>

      {/* Success state */}
      {bootstrapCommand && (
        <div className="bg-green-50 border border-green-200 rounded-lg p-6 space-y-4">
          <div className="flex items-center gap-2">
            <span className="h-6 w-6 rounded-full bg-green-500 text-white grid place-items-center text-xs font-bold">
              ✓
            </span>
            <h2 className="text-lg font-semibold text-green-900">Script Loaded Successfully</h2>
          </div>
          <p className="text-sm text-green-800">
            Paste this one-liner into the router's WinBox terminal. The router will enroll itself and the
            selected services will be applied automatically.
          </p>
          <div className="relative">
            <pre className="bg-gray-900 text-green-400 rounded-md font-mono text-xs p-4 pr-24 overflow-x-auto whitespace-pre-wrap break-all">
              {bootstrapCommand}
            </pre>
            <button
              onClick={handleCopy}
              className="absolute top-2 right-2 px-3 py-1.5 text-xs font-medium bg-gray-700 text-gray-200 rounded hover:bg-gray-600"
            >
              {copyStatus === 'copied' ? 'Copied!' : copyStatus === 'failed' ? 'Failed' : 'Copy'}
            </button>
          </div>
          <div className="flex flex-wrap gap-3 pt-2">
            <button
              onClick={() => navigate('/app/routers')}
              className="px-5 py-2.5 bg-indigo-600 text-white font-medium rounded-md hover:bg-indigo-700"
            >
              View Router Dashboard
            </button>
            <button
              onClick={handleGenerate}
              disabled={loading}
              className="px-5 py-2.5 border border-gray-300 bg-white text-gray-700 font-medium rounded-md hover:bg-gray-50 disabled:opacity-50"
            >
              Regenerate Script
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

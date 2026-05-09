import React, { useState } from 'react';
import { Database, Plus, Trash2, Cpu, Users, Layers, TrendingUp, Radio, LogOut, CheckCircle } from 'lucide-react';
import { HotspotPlan, Voucher, ActiveSession, NetworkNode } from '../data/mockData';

interface AdminDashboardProps {
  plans: HotspotPlan[];
  vouchers: Voucher[];
  sessions: ActiveSession[];
  nodes: NetworkNode[];
  onBulkGenerateVouchers: (prefix: string, planId: string, count: number) => void;
  onClearExpiredVouchers: () => void;
  onKickSession: (sessionId: string) => void;
  onToggleNodeStatus: (nodeId: string) => void;
}

export default function AdminDashboard({
  plans,
  vouchers,
  sessions,
  nodes,
  onBulkGenerateVouchers,
  onClearExpiredVouchers,
  onKickSession,
  onToggleNodeStatus
}: AdminDashboardProps) {
  // Batch tool state
  const [prefix, setPrefix] = useState('FAIBA');
  const [selectedPlanId, setSelectedPlanId] = useState(plans[0]?.id || '');
  const [quantity, setQuantity] = useState(5);
  const [generationNotice, setGenerationNotice] = useState(false);

  const hotspotPlans = plans.filter(p => p.type === 'hotspot');

  // Compute stats
  const totalRevenueSimulated = vouchers.filter(v => v.status === 'Active').reduce((sum, v) => {
    const p = plans.find(pl => pl.name === v.planName);
    return sum + (p ? p.price : 30);
  }, 1500 * 3); // Seed default client monthly payments

  const totalUnusedCount = vouchers.filter(v => v.status === 'Unused').length;
  const totalActiveCount = vouchers.filter(v => v.status === 'Active').length;

  const handleGenerateSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onBulkGenerateVouchers(prefix.toUpperCase().trim(), selectedPlanId, quantity);
    setGenerationNotice(true);
    setTimeout(() => setGenerationNotice(false), 3000);
  };

  return (
    <div className="space-y-8">
      {/* Central Admin Analytics Overview Widgets */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-xs">
          <div className="flex justify-between items-start">
            <div>
              <span className="text-[11px] font-bold text-slate-400 uppercase font-mono tracking-wider block">Estimated Revenue</span>
              <span className="text-2xl font-black text-slate-900 font-mono">{totalRevenueSimulated.toLocaleString()} BOB</span>
            </div>
            <div className="p-2 bg-emerald-50 rounded-xl text-emerald-600">
              <TrendingUp className="w-5 h-5" />
            </div>
          </div>
          <p className="text-[10px] text-slate-500 mt-2">Home Fiber + Active Vouchers</p>
        </div>

        <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-xs">
          <div className="flex justify-between items-start">
            <div>
              <span className="text-[11px] font-bold text-slate-400 uppercase font-mono tracking-wider block">Active Sessions</span>
              <span className="text-2xl font-black text-slate-900 font-mono">{sessions.length + totalActiveCount}</span>
            </div>
            <div className="p-2 bg-indigo-50 rounded-xl text-indigo-600">
              <Users className="w-5 h-5" />
            </div>
          </div>
          <p className="text-[10px] text-slate-500 mt-2">Live hardware leases right now</p>
        </div>

        <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-xs">
          <div className="flex justify-between items-start">
            <div>
              <span className="text-[11px] font-bold text-slate-400 uppercase font-mono tracking-wider block">Available Vouchers</span>
              <span className="text-2xl font-black text-slate-900 font-mono">{totalUnusedCount}</span>
            </div>
            <div className="p-2 bg-violet-50 rounded-xl text-violet-600">
              <Database className="w-5 h-5" />
            </div>
          </div>
          <p className="text-[10px] text-slate-500 mt-2">Pre-calculated pools ready to buy</p>
        </div>

        <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-xs">
          <div className="flex justify-between items-start">
            <div>
              <span className="text-[11px] font-bold text-slate-400 uppercase font-mono tracking-wider block">Hub Access Points</span>
              <span className="text-2xl font-black text-slate-900 font-mono">
                {nodes.filter(n => n.status === 'Online').length} <span className="text-xs text-slate-400 font-normal">/ {nodes.length}</span>
              </span>
            </div>
            <div className="p-2 bg-cyan-50 rounded-xl text-cyan-600">
              <Radio className="w-5 h-5" />
            </div>
          </div>
          <p className="text-[10px] text-slate-500 mt-2">Distributed backhaul sectors</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Bulk Voucher Generator Tool Section */}
        <div className="lg:col-span-4 bg-white p-5 rounded-3xl border border-slate-200 shadow-sm space-y-4">
          <div>
            <h3 className="font-extrabold text-slate-900 text-base flex items-center gap-1">
              <Cpu className="w-5 h-5 text-violet-600" />
              Radius Batch Token Generator
            </h3>
            <p className="text-xs text-slate-500">Inject automated randomized voucher strings directly to server tables.</p>
          </div>

          <form onSubmit={handleGenerateSubmit} className="space-y-3 pt-1">
            <div>
              <label className="block text-[11px] font-bold text-slate-600 uppercase">Voucher String Prefix</label>
              <input
                type="text"
                value={prefix}
                onChange={(e) => setPrefix(e.target.value.toUpperCase())}
                placeholder="e.g. CORE"
                maxLength={8}
                className="w-full bg-slate-50 border text-xs p-2.5 rounded-xl font-mono text-slate-800"
                required
              />
            </div>

            <div>
              <label className="block text-[11px] font-bold text-slate-600 uppercase">Assign Bandwidth Profile</label>
              <select
                value={selectedPlanId}
                onChange={(e) => setSelectedPlanId(e.target.value)}
                className="w-full bg-slate-50 border text-xs p-2.5 rounded-xl text-slate-800 font-medium"
              >
                {hotspotPlans.map(p => (
                  <option key={p.id} value={p.id}>
                    {p.name} - {p.duration} • {p.speedLimit}↓/{p.uploadLimit || p.speedLimit}↑ • {p.sharedUsers} dev ({p.price.toLocaleString()} BOB)
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-[11px] font-bold text-slate-600 uppercase">Quantity to Forge</label>
              <input
                type="number"
                min={1}
                max={50}
                value={quantity}
                onChange={(e) => setQuantity(parseInt(e.target.value) || 5)}
                className="w-full bg-slate-50 border text-xs p-2.5 rounded-xl font-mono text-slate-800"
              />
            </div>

            <button
              type="submit"
              className="w-full bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs py-2.5 px-4 rounded-xl flex items-center justify-center gap-1 shadow transition-colors"
            >
              <Plus className="w-4 h-4" />
              Forge Bulk Voucher Tokens
            </button>
          </form>

          {generationNotice && (
            <div className="p-3.5 bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-xl text-xs flex items-center gap-2">
              <CheckCircle className="w-4 h-4 text-emerald-600 shrink-0" />
              <span>Successfully injected vouchers! They are instantly buyable & active.</span>
            </div>
          )}

          <div className="pt-2 border-t border-slate-100 flex justify-between items-center text-xs">
            <span className="text-slate-400">Database Options:</span>
            <button
              onClick={onClearExpiredVouchers}
              className="text-rose-600 hover:underline flex items-center gap-0.5 text-[11px]"
            >
              <Trash2 className="w-3 h-3" /> Clear Expired Vouchers
            </button>
          </div>
        </div>

        {/* Voucher Database Matrix / List */}
        <div className="lg:col-span-8 bg-white p-5 rounded-3xl border border-slate-200 shadow-sm">
          <div className="flex justify-between items-center mb-3">
            <div>
              <h3 className="font-extrabold text-slate-900 text-base">Voucher Cryptographic Pool ({vouchers.length})</h3>
              <p className="text-xs text-slate-500">Live view of both sold, active, and available hotspot pins.</p>
            </div>
            <div className="flex gap-2">
              <span className="text-[10px] font-semibold bg-emerald-50 text-emerald-700 px-2 py-0.5 rounded border border-emerald-200">
                {totalActiveCount} Active
              </span>
              <span className="text-[10px] font-semibold bg-blue-50 text-blue-700 px-2 py-0.5 rounded border border-blue-200">
                {totalUnusedCount} Pending
              </span>
            </div>
          </div>

          <div className="overflow-y-auto max-h-[340px] border border-slate-150 rounded-xl text-xs">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-slate-50 text-slate-500 font-semibold uppercase tracking-wider text-[10px] border-b border-slate-150">
                  <th className="p-2.5 pl-3">Access Pin</th>
                  <th className="p-2.5">Bandwidth Target</th>
                  <th className="p-2.5">Speed Limit</th>
                  <th className="p-2.5">Status</th>
                  <th className="p-2.5 text-right pr-3">Authorized MAC Target</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 font-mono">
                {vouchers.map((v, idx) => (
                  <tr key={idx} className="hover:bg-slate-50/60 text-[11px]">
                    <td className="p-2.5 pl-3 font-bold text-violet-700">{v.code}</td>
                    <td className="p-2.5 text-slate-700">{v.planName}</td>
                    <td className="p-2.5 text-slate-500 font-sans">{v.speedLimit}</td>
                    <td className="p-2.5">
                      <span className={`px-1.5 py-0.5 rounded-md font-bold text-[9px] uppercase ${
                        v.status === 'Active' ? 'bg-emerald-100 text-emerald-800' :
                        v.status === 'Unused' ? 'bg-blue-100 text-blue-800' : 'bg-slate-200 text-slate-600'
                      }`}>
                        {v.status}
                      </span>
                    </td>
                    <td className="p-2.5 text-right pr-3 text-slate-400 text-[10px]">
                      {v.usedBy ? v.usedBy : <span className="italic text-slate-300">none yet</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* DHCP Active Sessions & MAC Auth Revocation Stream */}
      <div className="bg-white p-5 rounded-3xl border border-slate-200 shadow-sm">
        <div className="mb-4">
          <h3 className="font-extrabold text-slate-900 text-base flex items-center gap-1">
            <Layers className="w-5 h-5 text-indigo-600" />
            Live DHCP Lease Pool & Active Sessions (MikroTik Sim)
          </h3>
          <p className="text-xs text-slate-500">
            Devices passing heavy traffic or authorized via system bypass token keys. Disconnecting forces them back to the login screen.
          </p>
        </div>

        <div className="overflow-x-auto text-xs">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-slate-50 text-slate-600 font-bold border-b border-slate-200 uppercase tracking-wider text-[10px]">
                <th className="p-3">MAC Lease Address</th>
                <th className="p-3">IP Address</th>
                <th className="p-3">Authenticated Via</th>
                <th className="p-3">Client Hardware OS</th>
                <th className="p-3">Assigned Node</th>
                <th className="p-3 text-right">Data Exchanged</th>
                <th className="p-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-slate-700 font-mono text-[11px]">
              {sessions.map((s) => (
                <tr key={s.id} className="hover:bg-slate-50/60">
                  <td className="p-3 font-bold text-slate-900">{s.macAddress}</td>
                  <td className="p-3 text-indigo-600">{s.ipAddress}</td>
                  <td className="p-3 font-sans">
                    <span className="bg-slate-100 text-slate-700 px-1.5 py-0.5 rounded text-[10px]">
                      {s.voucherCode || 'Static IP Binding'}
                    </span>
                  </td>
                  <td className="p-3 font-sans text-slate-600 text-xs">{s.deviceType}</td>
                  <td className="p-3 font-sans text-xs text-slate-600">{s.node}</td>
                  <td className="p-3 text-right text-slate-900 font-bold">
                    ⬇ {(s.downloadedMb / 1024).toFixed(2)} GB / ⬆ {(s.uploadedMb / 1024).toFixed(2)} GB
                  </td>
                  <td className="p-3 text-right font-sans">
                    <button
                      onClick={() => onKickSession(s.id)}
                      className="text-rose-600 hover:text-white hover:bg-rose-600 p-1 rounded border border-rose-200 transition-all text-[11px] font-bold"
                      title="Kick client instantly"
                    >
                      <LogOut className="w-3 h-3 inline mr-0.5" /> Kick
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Network Nodes Health and Maintenance Controllers */}
      <div className="bg-slate-900 text-white rounded-3xl p-6 shadow-xl">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2 mb-4">
          <div>
            <h3 className="text-base font-extrabold flex items-center gap-2 tracking-tight">
              <Radio className="w-5 h-5 text-cyan-400" />
              Ultrafaiba Core Distribution Access Point Array
            </h3>
            <p className="text-xs text-slate-400">Simulate hardware backhaul down-time to trigger instant routing alerts.</p>
          </div>
          <span className="text-xs font-mono bg-slate-950 text-cyan-400 px-3 py-1 rounded-full border border-slate-800">
            SNMP Monitoring Protocol V3
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
          {nodes.map((node) => (
            <div key={node.id} className="bg-slate-950 p-4 rounded-2xl border border-slate-800/80 flex flex-col justify-between space-y-3">
              <div>
                <div className="flex justify-between items-start">
                  <h4 className="font-bold text-xs text-slate-200 tracking-tight truncate max-w-[120px]">{node.name}</h4>
                  <span className={`w-2.5 h-2.5 rounded-full ${
                    node.status === 'Online' ? 'bg-emerald-500 shadow-sm shadow-emerald-400' :
                    node.status === 'Maintenance' ? 'bg-amber-500' : 'bg-rose-500'
                  }`}></span>
                </div>
                <p className="text-[10px] text-slate-400 font-sans mt-0.5">{node.bandwidthCapacity} capacity</p>
              </div>

              <div className="space-y-1 font-mono text-[11px]">
                <div className="flex justify-between text-slate-500">
                  <span>Conns:</span>
                  <span className="text-slate-300 font-bold">{node.activeUsers} devices</span>
                </div>
                <div className="flex justify-between text-slate-500">
                  <span>Load Ratio:</span>
                  <span className={node.loadPercent > 80 ? 'text-amber-400' : 'text-slate-300'}>
                    {node.loadPercent}%
                  </span>
                </div>
                <div className="w-full bg-slate-900 h-1 rounded-full overflow-hidden mt-1">
                  <div 
                    className={`h-full ${node.loadPercent > 80 ? 'bg-amber-500' : 'bg-cyan-400'}`}
                    style={{ width: `${node.loadPercent}%` }}
                  ></div>
                </div>
              </div>

              <button
                onClick={() => onToggleNodeStatus(node.id)}
                className={`w-full text-[10px] font-sans py-1 rounded transition-colors font-bold ${
                  node.status === 'Online'
                    ? 'bg-slate-900 hover:bg-amber-950 text-amber-400 border border-amber-900/40'
                    : 'bg-emerald-950 text-emerald-400 hover:bg-emerald-900 border border-emerald-800'
                }`}
              >
                {node.status === 'Online' ? '⚡ Force Maintenance' : '✓ Revive Station'}
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

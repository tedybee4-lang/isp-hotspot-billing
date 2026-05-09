import { CheckCircle, AlertTriangle, Radio, Clock, Activity, Shield } from 'lucide-react';
import { NetworkNode } from '../data/mockData';

interface NetworkStatusProps {
  nodes: NetworkNode[];
  darkMode: boolean;
}

const UPTIME_HISTORY = [
  { date: 'Mar 13', status: 'up' },
  { date: 'Mar 12', status: 'up' },
  { date: 'Mar 11', status: 'up' },
  { date: 'Mar 10', status: 'degraded' },
  { date: 'Mar 9', status: 'up' },
  { date: 'Mar 8', status: 'up' },
  { date: 'Mar 7', status: 'up' },
  { date: 'Mar 6', status: 'up' },
  { date: 'Mar 5', status: 'up' },
  { date: 'Mar 4', status: 'up' },
  { date: 'Mar 3', status: 'up' },
  { date: 'Mar 2', status: 'up' },
  { date: 'Mar 1', status: 'up' },
  { date: 'Feb 28', status: 'up' },
  { date: 'Feb 27', status: 'down' },
  { date: 'Feb 26', status: 'up' },
  { date: 'Feb 25', status: 'up' },
  { date: 'Feb 24', status: 'up' },
  { date: 'Feb 23', status: 'up' },
  { date: 'Feb 22', status: 'up' },
  { date: 'Feb 21', status: 'degraded' },
  { date: 'Feb 20', status: 'up' },
  { date: 'Feb 19', status: 'up' },
  { date: 'Feb 18', status: 'up' },
  { date: 'Feb 17', status: 'up' },
  { date: 'Feb 16', status: 'up' },
  { date: 'Feb 15', status: 'up' },
  { date: 'Feb 14', status: 'up' },
  { date: 'Feb 13', status: 'up' },
  { date: 'Feb 12', status: 'up' },
];

const SERVICES = [
  { name: 'Core Routing Engine', status: 'operational', latency: '2ms' },
  { name: 'Radius Authentication Server', status: 'operational', latency: '4ms' },
  { name: 'Billing & Payment Gateway', status: 'operational', latency: '12ms' },
  { name: 'DNS Resolution Cluster', status: 'operational', latency: '1ms' },
  { name: 'Captive Portal Web Server', status: 'operational', latency: '8ms' },
  { name: 'SNMP Monitoring Collector', status: 'operational', latency: '5ms' },
  { name: 'Backup Power UPS Array', status: 'operational', latency: 'N/A' },
  { name: 'CDN Peering Exchange', status: 'operational', latency: '3ms' },
];

const INCIDENTS = [
  {
    id: 'INC-0412',
    title: 'Node Delta Scheduled Maintenance',
    status: 'maintenance',
    time: '2026-03-13 06:00 — 2026-03-13 18:00',
    description: 'Planned firmware upgrade on the Node Delta gateway router. Expected downtime: 12 hours.',
    updates: [
      { time: '06:00', text: 'Maintenance window started. Backup routing engaged.' },
      { time: '09:30', text: 'Firmware flash completed. Running post-upgrade diagnostics.' },
    ]
  },
  {
    id: 'INC-0398',
    title: 'Brief packet loss — Node Bravo',
    status: 'resolved',
    time: '2026-03-10 18:45 — 2026-03-10 20:12',
    description: 'Intermittent 2-3% packet loss observed during heavy rainfall. Root cause: water ingress in outdoor fiber splice closure.',
    updates: [
      { time: '18:45', text: 'Anomaly detected by automated monitoring.' },
      { time: '19:15', text: 'Field technician dispatched.' },
      { time: '20:12', text: 'Splice closure resealed. Service restored to full capacity.' },
    ]
  },
  {
    id: 'INC-0381',
    title: 'DNS resolution latency spike',
    status: 'resolved',
    time: '2026-02-27 14:00 — 2026-02-27 15:30',
    description: 'Upstream DNS provider experienced a brief outage. Failover to secondary DNS cluster activated within 90 seconds.',
    updates: [
      { time: '14:00', text: 'Primary DNS latency exceeded 200ms threshold.' },
      { time: '14:02', text: 'Automatic failover to backup DNS cluster.' },
      { time: '15:30', text: 'Primary DNS restored. All queries nominal.' },
    ]
  }
];

export default function NetworkStatus({ nodes, darkMode }: NetworkStatusProps) {
  const allOnline = nodes.every(n => n.status === 'Online');
  const onlineCount = nodes.filter(n => n.status === 'Online').length;

  return (
    <div className="space-y-8">
      {/* Overall Status Banner */}
      <div className={`rounded-3xl p-8 text-center border ${
        allOnline 
          ? 'bg-gradient-to-br from-emerald-50 to-teal-50 border-emerald-200' 
          : 'bg-gradient-to-br from-amber-50 to-yellow-50 border-amber-200'
      }`}>
        <div className="inline-flex p-4 rounded-full bg-white shadow-md mb-4">
          {allOnline ? (
            <CheckCircle className="w-10 h-10 text-emerald-500" />
          ) : (
            <AlertTriangle className="w-10 h-10 text-amber-500" />
          )}
        </div>
        <h2 className={`text-2xl font-black tracking-tight ${allOnline ? 'text-emerald-900' : 'text-amber-900'}`}>
          {allOnline ? 'All Systems Operational' : 'Partial System Degradation'}
        </h2>
        <p className={`text-sm mt-2 ${allOnline ? 'text-emerald-700' : 'text-amber-700'}`}>
          {allOnline 
            ? 'All network nodes and services are running at full capacity.'
            : `${onlineCount} of ${nodes.length} nodes online. Some services may experience reduced performance.`
          }
        </p>
        <div className="flex items-center justify-center gap-2 mt-4 text-xs text-slate-500">
          <Clock className="w-3 h-3" />
          Last checked: Just now (auto-refreshing every 30 seconds)
        </div>
      </div>

      {/* 30-Day Uptime Bar */}
      <div className={`p-6 rounded-2xl border ${darkMode ? 'bg-slate-800/60 border-slate-700' : 'bg-white border-slate-200'} shadow-xs`}>
        <div className="flex justify-between items-center mb-4">
          <div>
            <h3 className={`font-bold text-sm ${darkMode ? 'text-white' : 'text-slate-900'}`}>30-Day Uptime History</h3>
            <p className={`text-xs ${darkMode ? 'text-slate-400' : 'text-slate-500'}`}>Overall network availability</p>
          </div>
          <span className={`text-xl font-black font-mono ${darkMode ? 'text-emerald-400' : 'text-emerald-600'}`}>99.98%</span>
        </div>

        <div className="flex gap-1 items-end h-10">
          {UPTIME_HISTORY.map((day, i) => (
            <div
              key={i}
              className={`flex-1 rounded-sm transition-all cursor-pointer group relative ${
                day.status === 'up' ? 'bg-emerald-400 hover:bg-emerald-500 h-8' :
                day.status === 'degraded' ? 'bg-amber-400 hover:bg-amber-500 h-6' :
                'bg-rose-400 hover:bg-rose-500 h-4'
              }`}
              title={`${day.date}: ${day.status}`}
            >
              <div className={`absolute -top-8 left-1/2 -translate-x-1/2 text-[9px] font-mono px-1.5 py-0.5 rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none z-10 ${darkMode ? 'bg-slate-700 text-white' : 'bg-slate-900 text-white'}`}>
                {day.date}: {day.status}
              </div>
            </div>
          ))}
        </div>

        <div className="flex justify-between items-center mt-3 text-[10px]">
          <span className={darkMode ? 'text-slate-400' : 'text-slate-500'}>30 days ago</span>
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1"><span className="w-2 h-2 bg-emerald-400 rounded-sm"></span> Operational</span>
            <span className="flex items-center gap-1"><span className="w-2 h-2 bg-amber-400 rounded-sm"></span> Degraded</span>
            <span className="flex items-center gap-1"><span className="w-2 h-2 bg-rose-400 rounded-sm"></span> Outage</span>
          </div>
          <span className={darkMode ? 'text-slate-400' : 'text-slate-500'}>Today</span>
        </div>
      </div>

      {/* Node Status Grid */}
      <div className={`p-6 rounded-2xl border ${darkMode ? 'bg-slate-800/60 border-slate-700' : 'bg-white border-slate-200'} shadow-xs`}>
        <h3 className={`font-bold text-sm mb-4 flex items-center gap-2 ${darkMode ? 'text-white' : 'text-slate-900'}`}>
          <Radio className="w-4 h-4 text-violet-500" />
          Infrastructure Nodes
        </h3>

        <div className="space-y-2">
          {nodes.map(node => (
            <div key={node.id} className={`p-4 rounded-xl border flex flex-col sm:flex-row justify-between sm:items-center gap-3 ${darkMode ? 'bg-slate-900 border-slate-700' : 'bg-slate-50 border-slate-200'}`}>
              <div className="flex items-center gap-3">
                <span className={`w-3 h-3 rounded-full shrink-0 ${
                  node.status === 'Online' ? 'bg-emerald-400 shadow-sm shadow-emerald-400' :
                  node.status === 'Maintenance' ? 'bg-amber-400 animate-pulse' :
                  'bg-rose-400'
                }`}></span>
                <div>
                  <span className={`font-bold text-sm block ${darkMode ? 'text-white' : 'text-slate-900'}`}>{node.name}</span>
                  <span className={`text-xs ${darkMode ? 'text-slate-400' : 'text-slate-500'}`}>{node.bandwidthCapacity} capacity</span>
                </div>
              </div>

              <div className="flex items-center gap-4 text-xs">
                <div className={`font-mono ${darkMode ? 'text-slate-400' : 'text-slate-500'}`}>
                  {node.activeUsers} users • {node.bandwidthCapacity}
                </div>
                <div className={`flex items-center gap-1 font-bold text-[11px] ${
                  node.loadPercent > 80 ? 'text-amber-500' : 'text-emerald-500'
                }`}>
                  <Activity className="w-3 h-3" />
                  {node.loadPercent}% load
                </div>
                <span className={`px-2.5 py-1 rounded-full font-bold text-[10px] uppercase tracking-wider ${
                  node.status === 'Online' ? 'bg-emerald-100 text-emerald-800 border border-emerald-200' :
                  node.status === 'Maintenance' ? 'bg-amber-100 text-amber-800 border border-amber-200' :
                  'bg-rose-100 text-rose-800 border border-rose-200'
                }`}>
                  {node.status}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Core Services Status */}
      <div className={`p-6 rounded-2xl border ${darkMode ? 'bg-slate-800/60 border-slate-700' : 'bg-white border-slate-200'} shadow-xs`}>
        <h3 className={`font-bold text-sm mb-4 flex items-center gap-2 ${darkMode ? 'text-white' : 'text-slate-900'}`}>
          <Shield className="w-4 h-4 text-emerald-500" />
          Core Service Components
        </h3>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {SERVICES.map((svc, i) => (
            <div key={i} className={`p-3 rounded-xl border flex justify-between items-center ${darkMode ? 'bg-slate-900 border-slate-700' : 'bg-slate-50 border-slate-200'}`}>
              <div className="flex items-center gap-2">
                <CheckCircle className="w-4 h-4 text-emerald-500 shrink-0" />
                <span className={`font-medium text-xs ${darkMode ? 'text-slate-300' : 'text-slate-700'}`}>{svc.name}</span>
              </div>
              <div className="flex items-center gap-2 text-[11px]">
                <span className={`font-mono ${darkMode ? 'text-slate-400' : 'text-slate-500'}`}>{svc.latency}</span>
                <span className="bg-emerald-100 text-emerald-800 px-1.5 py-0.5 rounded font-bold text-[9px] uppercase">Operational</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Incident Log */}
      <div className={`p-6 rounded-2xl border ${darkMode ? 'bg-slate-800/60 border-slate-700' : 'bg-white border-slate-200'} shadow-xs`}>
        <h3 className={`font-bold text-sm mb-4 ${darkMode ? 'text-white' : 'text-slate-900'}`}>Recent Incident Reports</h3>

        <div className="space-y-4">
          {INCIDENTS.map((inc) => (
            <div key={inc.id} className={`p-4 rounded-xl border ${darkMode ? 'bg-slate-900 border-slate-700' : 'bg-slate-50 border-slate-200'}`}>
              <div className="flex flex-col sm:flex-row justify-between sm:items-center gap-2 mb-3">
                <div className="flex items-center gap-2">
                  {inc.status === 'resolved' ? (
                    <CheckCircle className="w-4 h-4 text-emerald-500 shrink-0" />
                  ) : (
                    <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0" />
                  )}
                  <span className={`font-bold text-sm ${darkMode ? 'text-white' : 'text-slate-900'}`}>{inc.title}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`font-mono text-[10px] ${darkMode ? 'text-slate-400' : 'text-slate-500'}`}>{inc.id}</span>
                  <span className={`px-2 py-0.5 rounded font-bold text-[10px] uppercase ${
                    inc.status === 'resolved' ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'
                  }`}>
                    {inc.status}
                  </span>
                </div>
              </div>

              <p className={`text-xs mb-3 ${darkMode ? 'text-slate-400' : 'text-slate-500'}`}>{inc.description}</p>
              
              <div className={`text-[11px] font-mono ${darkMode ? 'text-slate-500' : 'text-slate-400'}`}>{inc.time}</div>

              <div className={`mt-3 pt-3 border-t ${darkMode ? 'border-slate-700' : 'border-slate-200'} space-y-2`}>
                {inc.updates.map((upd, idx) => (
                  <div key={idx} className="flex items-start gap-2 text-xs">
                    <span className={`font-mono font-bold shrink-0 ${darkMode ? 'text-slate-500' : 'text-slate-400'}`}>{upd.time}</span>
                    <span className={darkMode ? 'text-slate-300' : 'text-slate-600'}>{upd.text}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

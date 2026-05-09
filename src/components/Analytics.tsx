import { useState } from 'react';
import { BarChart3, TrendingUp, DollarSign, Users, Wifi, ArrowUpRight, ArrowDownRight } from 'lucide-react';
import { Voucher, NetworkNode } from '../data/mockData';

interface AnalyticsProps {
  vouchers: Voucher[];
  nodes: NetworkNode[];
  darkMode: boolean;
}

const MONTHLY_REVENUE = [
  { month: 'Oct', amount: 84200, growth: 12 },
  { month: 'Nov', amount: 91500, growth: 8.6 },
  { month: 'Dec', amount: 112000, growth: 22.4 },
  { month: 'Jan', amount: 108000, growth: -3.6 },
  { month: 'Feb', amount: 124500, growth: 15.3 },
  { month: 'Mar', amount: 142000, growth: 14.1 },
];

const BANDWIDTH_HOURS = [
  { hour: '00:00', download: 45, upload: 12 },
  { hour: '03:00', download: 18, upload: 5 },
  { hour: '06:00', download: 32, upload: 10 },
  { hour: '09:00', download: 78, upload: 34 },
  { hour: '12:00', download: 92, upload: 45 },
  { hour: '15:00', download: 85, upload: 38 },
  { hour: '18:00', download: 96, upload: 52 },
  { hour: '21:00', download: 88, upload: 41 },
];

const TOP_DEVICES = [
  { name: 'Apple iPhone', count: 3420, pct: 34 },
  { name: 'Samsung Galaxy', count: 2180, pct: 22 },
  { name: 'Windows Laptops', count: 1850, pct: 18 },
  { name: 'Xiaomi / Redmi', count: 1120, pct: 11 },
  { name: 'MacBook / iPad', count: 890, pct: 9 },
  { name: 'Other Devices', count: 540, pct: 6 },
];

const DEVICE_COLORS = ['bg-violet-500', 'bg-indigo-500', 'bg-cyan-500', 'bg-emerald-500', 'bg-amber-500', 'bg-slate-400'];

export default function Analytics({ vouchers, nodes, darkMode }: AnalyticsProps) {
  const [timeRange, setTimeRange] = useState<'7d' | '30d' | '90d'>('30d');

  const maxRevenue = Math.max(...MONTHLY_REVENUE.map(r => r.amount));
  const maxBandwidth = Math.max(...BANDWIDTH_HOURS.map(b => b.download));
  const totalConnections = nodes.reduce((sum, n) => sum + n.activeUsers, 0);
  const avgLoad = Math.round(nodes.filter(n => n.status === 'Online').reduce((sum, n) => sum + n.loadPercent, 0) / nodes.filter(n => n.status === 'Online').length);

  const totalVouchersSold = vouchers.filter(v => v.status === 'Active' || v.status === 'Expired').length;
  const conversionRate = vouchers.length > 0 ? Math.round((totalVouchersSold / vouchers.length) * 100) : 0;

  return (
    <div className="space-y-6">
      {/* Header & Time Range Selector */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h2 className={`text-2xl font-black tracking-tight flex items-center gap-2 ${darkMode ? 'text-white' : 'text-slate-900'}`}>
            <BarChart3 className="w-6 h-6 text-violet-600" />
            Network Analytics & Revenue Intelligence
          </h2>
          <p className={`text-xs mt-1 ${darkMode ? 'text-slate-400' : 'text-slate-500'}`}>
            Real-time aggregated telemetry from all distribution nodes and billing pipelines.
          </p>
        </div>

        <div className={`flex p-1 rounded-xl border ${darkMode ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}>
          {(['7d', '30d', '90d'] as const).map(range => (
            <button
              key={range}
              onClick={() => setTimeRange(range)}
              className={`px-3.5 py-1.5 rounded-lg text-xs font-bold transition-all ${
                timeRange === range ? 'bg-violet-600 text-white shadow-sm' : darkMode ? 'text-slate-400' : 'text-slate-500'
              }`}
            >
              {range === '7d' ? 'Last 7 Days' : range === '30d' ? 'Last 30 Days' : 'Last 90 Days'}
            </button>
          ))}
        </div>
      </div>

      {/* KPI Summary Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { label: 'Total Revenue', value: '142,000 BOB', change: '+14.1%', up: true, icon: DollarSign, color: 'text-emerald-500', bg: darkMode ? 'bg-emerald-500/10' : 'bg-emerald-50' },
          { label: 'Active Connections', value: totalConnections.toString(), change: '+8.2%', up: true, icon: Users, color: 'text-indigo-500', bg: darkMode ? 'bg-indigo-500/10' : 'bg-indigo-50' },
          { label: 'Voucher Conversion', value: `${conversionRate}%`, change: '+3.4%', up: true, icon: Wifi, color: 'text-violet-500', bg: darkMode ? 'bg-violet-500/10' : 'bg-violet-50' },
          { label: 'Avg Network Load', value: `${avgLoad}%`, change: '-2.1%', up: false, icon: BarChart3, color: 'text-cyan-500', bg: darkMode ? 'bg-cyan-500/10' : 'bg-cyan-50' },
        ].map((kpi, i) => (
          <div key={i} className={`p-5 rounded-2xl border ${darkMode ? 'bg-slate-800/60 border-slate-700' : 'bg-white border-slate-200'} shadow-xs`}>
            <div className="flex justify-between items-start mb-3">
              <span className={`text-[11px] font-bold uppercase tracking-wider ${darkMode ? 'text-slate-400' : 'text-slate-500'}`}>{kpi.label}</span>
              <div className={`p-2 rounded-xl ${kpi.bg}`}>
                <kpi.icon className={`w-4 h-4 ${kpi.color}`} />
              </div>
            </div>
            <div className={`text-2xl font-black font-mono ${darkMode ? 'text-white' : 'text-slate-900'}`}>{kpi.value}</div>
            <div className={`flex items-center gap-1 text-xs font-bold mt-1 ${kpi.up ? 'text-emerald-500' : 'text-rose-500'}`}>
              {kpi.up ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownRight className="w-3 h-3" />}
              {kpi.change} vs last period
            </div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-7 gap-6">
        {/* Revenue Bar Chart */}
        <div className={`lg:col-span-4 p-6 rounded-2xl border ${darkMode ? 'bg-slate-800/60 border-slate-700' : 'bg-white border-slate-200'} shadow-xs`}>
          <div className="flex justify-between items-center mb-6">
            <div>
              <h3 className={`font-bold text-sm ${darkMode ? 'text-white' : 'text-slate-900'}`}>Monthly Revenue Trend</h3>
              <p className={`text-xs ${darkMode ? 'text-slate-400' : 'text-slate-500'}`}>Combined hotspot + fiber subscription income</p>
            </div>
            <div className="flex items-center gap-1 text-xs text-emerald-500 font-bold">
              <TrendingUp className="w-4 h-4" />
              +68.7% YTD
            </div>
          </div>

          <div className="flex items-end justify-between gap-3 h-48">
            {MONTHLY_REVENUE.map((rev, i) => (
              <div key={i} className="flex-1 flex flex-col items-center gap-1">
                <span className={`text-[10px] font-bold font-mono ${darkMode ? 'text-slate-300' : 'text-slate-700'}`}>
                  {(rev.amount / 1000).toFixed(0)}k
                </span>
                <div className="w-full relative flex items-end justify-center" style={{ height: '140px' }}>
                  <div
                    className={`w-full max-w-[40px] rounded-t-lg transition-all duration-500 ${
                      rev.growth > 0 ? 'bg-gradient-to-t from-violet-600 to-indigo-500' : 'bg-gradient-to-t from-rose-500 to-pink-400'
                    }`}
                    style={{ height: `${(rev.amount / maxRevenue) * 100}%` }}
                  ></div>
                </div>
                <span className={`text-[10px] font-medium ${darkMode ? 'text-slate-400' : 'text-slate-500'}`}>{rev.month}</span>
                <span className={`text-[9px] font-bold ${rev.growth > 0 ? 'text-emerald-500' : 'text-rose-500'}`}>
                  {rev.growth > 0 ? '+' : ''}{rev.growth}%
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Device Breakdown Donut-Style */}
        <div className={`lg:col-span-3 p-6 rounded-2xl border ${darkMode ? 'bg-slate-800/60 border-slate-700' : 'bg-white border-slate-200'} shadow-xs`}>
          <h3 className={`font-bold text-sm mb-1 ${darkMode ? 'text-white' : 'text-slate-900'}`}>Connected Device Types</h3>
          <p className={`text-xs mb-5 ${darkMode ? 'text-slate-400' : 'text-slate-500'}`}>Breakdown by hardware manufacturer fingerprint</p>

          {/* Stacked horizontal bar */}
          <div className="w-full h-5 rounded-full overflow-hidden flex mb-6">
            {TOP_DEVICES.map((dev, i) => (
              <div
                key={i}
                className={`${DEVICE_COLORS[i]} h-full transition-all`}
                style={{ width: `${dev.pct}%` }}
                title={dev.name}
              ></div>
            ))}
          </div>

          <div className="space-y-3">
            {TOP_DEVICES.map((dev, i) => (
              <div key={i} className="flex items-center justify-between text-xs">
                <div className="flex items-center gap-2">
                  <span className={`w-3 h-3 rounded-sm ${DEVICE_COLORS[i]}`}></span>
                  <span className={`font-medium ${darkMode ? 'text-slate-300' : 'text-slate-700'}`}>{dev.name}</span>
                </div>
                <div className="flex items-center gap-3">
                  <span className={`font-mono text-[11px] ${darkMode ? 'text-slate-400' : 'text-slate-500'}`}>{dev.count.toLocaleString()}</span>
                  <span className={`font-bold ${darkMode ? 'text-white' : 'text-slate-900'}`}>{dev.pct}%</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Bandwidth Usage Timeline */}
      <div className={`p-6 rounded-2xl border ${darkMode ? 'bg-slate-800/60 border-slate-700' : 'bg-white border-slate-200'} shadow-xs`}>
        <div className="flex justify-between items-center mb-6">
          <div>
            <h3 className={`font-bold text-sm ${darkMode ? 'text-white' : 'text-slate-900'}`}>Bandwidth Utilization by Hour (Today)</h3>
            <p className={`text-xs ${darkMode ? 'text-slate-400' : 'text-slate-500'}`}>Aggregate throughput across all online access points</p>
          </div>
          <div className="flex items-center gap-4 text-xs">
            <span className="flex items-center gap-1.5"><span className="w-3 h-1.5 bg-indigo-500 rounded-full"></span> <span className={darkMode ? 'text-slate-400' : 'text-slate-500'}>Download</span></span>
            <span className="flex items-center gap-1.5"><span className="w-3 h-1.5 bg-cyan-400 rounded-full"></span> <span className={darkMode ? 'text-slate-400' : 'text-slate-500'}>Upload</span></span>
          </div>
        </div>

        <div className="flex items-end justify-between gap-2 h-40">
          {BANDWIDTH_HOURS.map((bw, i) => (
            <div key={i} className="flex-1 flex flex-col items-center gap-1">
              <div className="w-full flex items-end justify-center gap-0.5" style={{ height: '120px' }}>
                <div
                  className="w-[40%] bg-gradient-to-t from-indigo-600 to-indigo-400 rounded-t-md transition-all"
                  style={{ height: `${(bw.download / maxBandwidth) * 100}%` }}
                ></div>
                <div
                  className="w-[40%] bg-gradient-to-t from-cyan-500 to-cyan-300 rounded-t-md transition-all"
                  style={{ height: `${(bw.upload / maxBandwidth) * 100}%` }}
                ></div>
              </div>
              <span className={`text-[9px] font-mono ${darkMode ? 'text-slate-400' : 'text-slate-500'}`}>{bw.hour}</span>
            </div>
          ))}
        </div>

        {/* Summary row */}
        <div className={`mt-4 pt-4 border-t grid grid-cols-3 gap-4 text-center ${darkMode ? 'border-slate-700' : 'border-slate-100'}`}>
          <div>
            <div className={`text-lg font-black font-mono ${darkMode ? 'text-white' : 'text-slate-900'}`}>2.4 TB</div>
            <div className={`text-[10px] ${darkMode ? 'text-slate-400' : 'text-slate-500'}`}>Total Download Today</div>
          </div>
          <div>
            <div className={`text-lg font-black font-mono ${darkMode ? 'text-white' : 'text-slate-900'}`}>892 GB</div>
            <div className={`text-[10px] ${darkMode ? 'text-slate-400' : 'text-slate-500'}`}>Total Upload Today</div>
          </div>
          <div>
            <div className={`text-lg font-black font-mono ${darkMode ? 'text-white' : 'text-slate-900'}`}>6:00 PM</div>
            <div className={`text-[10px] ${darkMode ? 'text-slate-400' : 'text-slate-500'}`}>Peak Usage Hour</div>
          </div>
        </div>
      </div>

      {/* Per-Node Load Map */}
      <div className={`p-6 rounded-2xl border ${darkMode ? 'bg-slate-800/60 border-slate-700' : 'bg-white border-slate-200'} shadow-xs`}>
        <h3 className={`font-bold text-sm mb-1 ${darkMode ? 'text-white' : 'text-slate-900'}`}>Node Load Distribution Heat Map</h3>
        <p className={`text-xs mb-5 ${darkMode ? 'text-slate-400' : 'text-slate-500'}`}>Capacity utilization across all access points</p>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
          {nodes.map(node => {
            return (
              <div key={node.id} className={`p-4 rounded-xl border ${darkMode ? 'bg-slate-900 border-slate-700' : 'bg-slate-50 border-slate-200'}`}>
                <div className="flex justify-between items-start mb-2">
                  <span className={`font-bold text-xs truncate max-w-[100px] ${darkMode ? 'text-white' : 'text-slate-900'}`}>{node.name}</span>
                  <span className={`w-2 h-2 rounded-full mt-1 ${node.status === 'Online' ? 'bg-emerald-400' : 'bg-amber-400'}`}></span>
                </div>

                {/* Circular progress indicator */}
                <div className="relative w-20 h-20 mx-auto my-3">
                  <svg className="w-20 h-20 -rotate-90" viewBox="0 0 36 36">
                    <path
                      d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                      fill="none"
                      stroke={darkMode ? '#334155' : '#e2e8f0'}
                      strokeWidth="3"
                    />
                    <path
                      d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                      fill="none"
                      stroke={node.loadPercent > 80 ? '#ef4444' : node.loadPercent > 50 ? '#f59e0b' : '#10b981'}
                      strokeWidth="3"
                      strokeDasharray={`${node.loadPercent}, 100`}
                      strokeLinecap="round"
                    />
                  </svg>
                  <div className={`absolute inset-0 flex items-center justify-center text-sm font-black font-mono ${darkMode ? 'text-white' : 'text-slate-900'}`}>
                    {node.loadPercent}%
                  </div>
                </div>

                <div className={`text-center text-[10px] font-mono ${darkMode ? 'text-slate-400' : 'text-slate-500'}`}>
                  {node.activeUsers} devices • {node.bandwidthCapacity}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

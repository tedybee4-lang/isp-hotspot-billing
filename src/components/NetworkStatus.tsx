import type { ReactNode } from 'react';
import { Radio, AlertTriangle, CheckCircle2, Clock, Server } from 'lucide-react';
import type { Node } from '../lib/types';

/**
 * Network status derived strictly from real router records.
 *
 * Nothing here is invented: a metric only appears when a router has actually
 * reported it. Where there is no telemetry the field renders "No data" rather
 * than a plausible-looking placeholder.
 */
export default function NetworkStatus({ nodes }: { nodes: Node[] }) {
  const online = nodes.filter((n) => n.status === 'online');
  const offline = nodes.filter((n) => n.status === 'offline');
  const maintenance = nodes.filter((n) => n.status === 'maintenance');

  // A heartbeat older than 5 minutes means we cannot trust 'online'.
  const STALE_MS = 5 * 60 * 1000;
  const stale = nodes.filter(
    (n) => n.status !== 'offline'
      && (!n.last_seen || Date.now() - new Date(n.last_seen).getTime() > STALE_MS),
  );

  if (nodes.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-slate-300 dark:border-slate-700 p-12 text-center">
        <Server className="w-10 h-10 mx-auto text-slate-300 dark:text-slate-600 mb-3" />
        <p className="text-sm font-bold text-slate-600 dark:text-slate-300">No routers registered</p>
        <p className="text-[11px] text-slate-400 mt-1">
          Add a router to start collecting network telemetry.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Tile label="Online" value={online.length} tone="emerald" icon={<CheckCircle2 className="w-4 h-4" />} />
        <Tile label="Offline" value={offline.length} tone="rose" icon={<AlertTriangle className="w-4 h-4" />} />
        <Tile label="Maintenance" value={maintenance.length} tone="amber" icon={<Server className="w-4 h-4" />} />
        <Tile label="Stale heartbeat" value={stale.length} tone="amber" icon={<Clock className="w-4 h-4" />} />
      </div>

      {stale.length > 0 && (
        <div className="flex items-start gap-2.5 rounded-xl border border-amber-200 bg-amber-50 dark:border-amber-500/30 dark:bg-amber-500/10 px-4 py-3">
          <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-px" />
          <p className="text-xs text-amber-800 dark:text-amber-200">
            <strong>{stale.length} router{stale.length === 1 ? '' : 's'}</strong> report online
            but have not sent a heartbeat in over 5 minutes. They are probably unreachable.
          </p>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {nodes.map((n) => (
          <div key={n.id}
            className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-3 min-w-0">
                <span className={`p-2 rounded-lg shrink-0 ${
                  n.status === 'online' ? 'bg-emerald-50 text-emerald-600'
                  : n.status === 'maintenance' ? 'bg-amber-50 text-amber-600'
                  : 'bg-rose-50 text-rose-600'
                }`}>
                  <Radio className="w-4 h-4" />
                </span>
                <div className="min-w-0">
                  <p className="text-sm font-black text-slate-900 dark:text-white truncate">{n.name}</p>
                  <p className="text-[11px] text-slate-400 font-mono truncate">
                    {n.model ?? 'Model not reported'}
                    {n.os_version && ` · RouterOS ${n.os_version}`}
                  </p>
                </div>
              </div>
              <StatusBadge status={n.status} />
            </div>

            <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5 mt-4 text-[11px]">
              <Metric label="IP / address" value={n.host ?? null} mono />
              <Metric label="Connected users"
                value={n.active_users !== null ? String(n.active_users) : null} />
              <Metric label="CPU load"
                value={n.cpu_load !== null ? `${n.cpu_load}%` : null} />
              <Metric label="RAM" value={
                n.ram_used_mb !== null && n.ram_total_mb
                  ? `${Math.round((n.ram_used_mb / n.ram_total_mb) * 100)}%`
                  : null
              } />
              <Metric label="Uptime"
                value={n.uptime_seconds !== null ? formatUptime(n.uptime_seconds) : null} />
              <Metric label="Last heartbeat"
                value={n.last_seen ? relativeTime(n.last_seen) : null} />
            </dl>
          </div>
        ))}
      </div>

      <p className="text-[10px] text-slate-400 leading-relaxed">
        Telemetry appears only when a router has actually reported it. Connect a MikroTik
        collector to populate CPU, RAM, uptime and heartbeat automatically — until then
        those fields stay empty rather than showing invented numbers.
      </p>
    </div>
  );
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function relativeTime(iso: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function Metric({ label, value, mono }: { label: string; value: string | null; mono?: boolean }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-wide text-slate-400 font-mono">{label}</dt>
      <dd className={`text-xs font-bold mt-0.5 ${
        value
          ? (mono ? 'text-slate-700 dark:text-slate-200 font-mono' : 'text-slate-800 dark:text-white')
          : 'text-slate-300 dark:text-slate-600 italic'
      }`}>
        {value ?? 'No data'}
      </dd>
    </div>
  );
}

function StatusBadge({ status }: { status: Node['status'] }) {
  const tone = {
    online: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300',
    offline: 'bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300',
    maintenance: 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300',
  }[status];
  return (
    <span className={`px-2 py-0.5 rounded-md text-[10px] font-bold uppercase tracking-wide font-mono whitespace-nowrap ${tone}`}>
      {status}
    </span>
  );
}

function Tile({ label, value, tone, icon }: {
  label: string; value: number; tone: 'emerald' | 'rose' | 'amber'; icon: ReactNode;
}) {
  const tones = {
    emerald: 'text-emerald-600 bg-emerald-50 dark:bg-emerald-500/10',
    rose: 'text-rose-600 bg-rose-50 dark:bg-rose-500/10',
    amber: 'text-amber-600 bg-amber-50 dark:bg-amber-500/10',
  }[tone];
  return (
    <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
      <div className="flex items-start justify-between">
        <div>
          <span className="text-[10px] font-bold text-slate-400 uppercase font-mono tracking-wider block">
            {label}
          </span>
          <span className="block mt-1 text-2xl font-black text-slate-900 dark:text-white font-mono">
            {value}
          </span>
        </div>
        <div className={`p-2 rounded-xl ${tones}`}>{icon}</div>
      </div>
    </div>
  );
}
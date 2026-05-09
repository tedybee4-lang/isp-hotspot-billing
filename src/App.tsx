import { useState } from 'react';
import { Wifi, CreditCard, Globe, Server, CheckCircle, Smartphone, Moon, Sun, Home, BarChart3, Radio, FileText, HardDrive } from 'lucide-react';
import {
  INITIAL_HOTSPOT_PLANS,
  INITIAL_VOUCHERS,
  INITIAL_CLIENT,
  INITIAL_INVOICES,
  INITIAL_TICKETS,
  INITIAL_SESSIONS,
  INITIAL_NODES,
  HotspotPlan,
  Voucher,
  Invoice,
  SupportTicket,
  ActiveSession,
  NetworkNode
} from './data/mockData';

import LandingPage from './components/LandingPage';
import HotspotPortal from './components/HotspotPortal';
import ClientBilling from './components/ClientBilling';
import AdminDashboard from './components/AdminDashboard';
import Analytics from './components/Analytics';
import NetworkStatus from './components/NetworkStatus';
import LiveChat from './components/LiveChat';
import TermsAndConditions from './components/TermsAndConditions';
import MikrotikConfig from './components/MikrotikConfig';
import CopyTextButton from './components/CopyTextButton';

type ViewType = 'home' | 'hotspot' | 'billing' | 'admin' | 'analytics' | 'status' | 'legal' | 'mikrotik';

export default function App() {
  // Global State Pools
  const [currentView, setCurrentView] = useState<ViewType>('home');
  const [darkMode, setDarkMode] = useState(false);
  const [hotspotPrefillCode, setHotspotPrefillCode] = useState('');
  const [plans] = useState<HotspotPlan[]>(INITIAL_HOTSPOT_PLANS);
  const [vouchers, setVouchers] = useState<Voucher[]>(INITIAL_VOUCHERS);
  const [client, setClient] = useState(INITIAL_CLIENT);
  const [invoices, setInvoices] = useState<Invoice[]>(INITIAL_INVOICES);
  const [tickets, setTickets] = useState<SupportTicket[]>(INITIAL_TICKETS);
  const [sessions, setSessions] = useState<ActiveSession[]>(INITIAL_SESSIONS);
  const [nodes, setNodes] = useState<NetworkNode[]>(INITIAL_NODES);

  // Captive Portal Specific Connection State
  const [isConnected, setIsConnected] = useState(false);
  const [activeVoucherCode, setActiveVoucherCode] = useState<string | null>(null);

  // Legal page tab state
  const [legalTab, setLegalTab] = useState<'terms' | 'privacy' | 'acceptable' | 'refund' | 'sla'>('terms');

  // General Notification System Banner Alert
  const [globalNotification, setGlobalNotification] = useState<string | null>(
    '🚀 High-Speed Fiber Upgrade notice: All core nodes have been upgraded to 10 Gbps backhaul.'
  );

  // -- HANDLER METHODS --

  const handleActivateVoucher = (code: string) => {
    const match = vouchers.find(v => v.code.toUpperCase() === code.toUpperCase());
    if (!match) {
      return { success: false, message: 'This voucher token could not be verified on the Ultrafaiba server database.' };
    }
    if (match.status === 'Expired') {
      return { success: false, message: 'Authentication failed. This prepaid voucher time limit has expired.' };
    }
    setVouchers(prev => prev.map(v =>
      v.code.toUpperCase() === code.toUpperCase()
        ? { ...v, status: 'Active', activatedAt: 'Just Now', usedBy: '08:E2:AA:BC:44:19' }
        : v
    ));
    setIsConnected(true);
    setActiveVoucherCode(match.code);
    const newSession: ActiveSession = {
      id: 's_auto_' + Math.floor(Math.random() * 9000),
      macAddress: '08:E2:AA:BC:44:19',
      ipAddress: '10.150.1.' + Math.floor(20 + Math.random() * 200),
      voucherCode: match.code,
      deviceType: 'Authorized Client Device',
      downloadedMb: 42,
      uploadedMb: 8,
      uptime: '00h 01m',
      node: nodes[Math.floor(Math.random() * nodes.length)]?.name || 'Ultrafaiba Main Hub'
    };
    setSessions(prev => [newSession, ...prev]);
    return { success: true, message: `Access token validated! Connected via profile ${match.planName} (${match.speedLimit}).` };
  };

  const handleDisconnect = () => {
    if (activeVoucherCode) {
      setVouchers(prev => prev.map(v => v.code === activeVoucherCode ? { ...v, status: 'Expired' } : v));
    }
    setSessions(prev => prev.filter(s => s.voucherCode !== activeVoucherCode));
    setIsConnected(false);
    setActiveVoucherCode(null);
  };

  const handlePurchaseVoucher = (plan: HotspotPlan, method: string) => {
    console.log(`Payment via ${method} registered for ${plan.name}`);
    const generatedCode = 'FAIBA-' + Math.floor(100 + Math.random() * 899) + String.fromCharCode(65 + Math.floor(Math.random() * 26));
    const newVoucher: Voucher = {
      code: generatedCode,
      planName: plan.name,
      duration: plan.duration,
      speedLimit: plan.speedLimit,
      status: 'Unused'
    };
    setVouchers(prev => [newVoucher, ...prev]);
    return generatedCode;
  };

  const handlePayInvoice = (invoiceId: string) => {
    setInvoices(prev => prev.map(inv =>
      inv.id === invoiceId ? { ...inv, status: 'Paid', paidAt: 'Just Now' } : inv
    ));
    setGlobalNotification(`💳 Payment Success! Invoice ${invoiceId} has been acknowledged & routing terminal updated.`);
  };

  const handleAddTicket = (
    subject: string,
    category: 'Speed Issue' | 'Payment Failed' | 'Router Offline' | 'Voucher Code Error',
    priority: 'Low' | 'Medium' | 'High'
  ) => {
    const newId = 'TCK-' + Math.floor(200 + Math.random() * 700);
    const newTicket: SupportTicket = {
      id: newId, subject, category, status: 'Open', date: 'Just Now', priority,
      messages: [
        { sender: 'client', text: subject, time: 'Just Now' },
        { sender: 'admin', text: 'Thank you for contacting Ultrafaiba NOC. An automated diagnostic ping has been transmitted to your fiber terminal switch box. An engineer will respond shortly.', time: 'System Automated' }
      ]
    };
    setTickets(prev => [newTicket, ...prev]);
  };

  const handleUpgradePlan = (planName: string) => {
    // Look up the matching plan to get the internal speed
    const matchedPlan = plans.find(p => p.name === planName);
    setClient(prev => ({
      ...prev,
      currentPlan: planName,
      bandwidth: matchedPlan ? `${matchedPlan.speedLimit} Symmetrical` : prev.bandwidth
    }));
    setGlobalNotification(`🚀 Account profile adjusted successfully to ${planName}. Provisions updated.`);
  };

  const handleBulkGenerateVouchers = (prefix: string, planId: string, count: number) => {
    const selectedPlan = plans.find(p => p.id === planId);
    if (!selectedPlan) return;
    const newBatch: Voucher[] = [];
    for (let i = 0; i < count; i++) {
      newBatch.push({
        code: `${prefix}-${Math.floor(1000 + Math.random() * 8999)}`,
        planName: selectedPlan.name,
        duration: selectedPlan.duration,
        speedLimit: selectedPlan.speedLimit,
        status: 'Unused'
      });
    }
    setVouchers(prev => [...newBatch, ...prev]);
  };

  const handleClearExpiredVouchers = () => {
    setVouchers(prev => prev.filter(v => v.status !== 'Expired'));
  };

  const handleKickSession = (sessionId: string) => {
    const targetSession = sessions.find(s => s.id === sessionId);
    if (targetSession && targetSession.voucherCode === activeVoucherCode) {
      setIsConnected(false);
      setActiveVoucherCode(null);
    }
    setSessions(prev => prev.filter(s => s.id !== sessionId));
  };

  const handleToggleNodeStatus = (nodeId: string) => {
    setNodes(prev => prev.map(n =>
      n.id === nodeId
        ? { ...n, status: n.status === 'Online' ? 'Maintenance' : 'Online', activeUsers: n.status === 'Online' ? 0 : Math.floor(50 + Math.random() * 200) }
        : n
    ));
  };

  const handleQuickConnect = (code: string) => {
    setHotspotPrefillCode(code.trim().toUpperCase());
    setCurrentView('hotspot');
  };

  const navItems: { key: ViewType; label: string; icon: typeof Wifi; badge?: string }[] = [
    { key: 'home', label: 'Home', icon: Home },
    { key: 'hotspot', label: 'Hotspot', icon: Wifi, badge: isConnected ? '●' : undefined },
    { key: 'billing', label: 'Billing', icon: CreditCard, badge: invoices.some(i => i.status === 'Unpaid') ? 'DUE' : undefined },
    { key: 'admin', label: 'ISP Panel', icon: Server },
    { key: 'analytics', label: 'Analytics', icon: BarChart3 },
    { key: 'status', label: 'Status', icon: Radio },
    { key: 'mikrotik', label: 'MikroTik', icon: HardDrive },
    { key: 'legal', label: 'Legal', icon: FileText },
  ];

  return (
    <div className={`min-h-screen font-sans antialiased flex flex-col transition-colors duration-300 ${
      darkMode ? 'bg-slate-950 text-slate-200' : 'bg-slate-50 text-slate-800'
    }`}>

      {/* ═══════════ HEADER ═══════════ */}
      <header className={`sticky top-0 z-40 border-b shadow-lg transition-colors duration-300 ${
        darkMode ? 'bg-slate-900 border-slate-800' : 'bg-slate-900 border-violet-900/40'
      }`}>
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center h-16 md:h-20">
            {/* Logo */}
            <button onClick={() => setCurrentView('home')} className="flex items-center space-x-3 group">
              <div className="h-10 w-10 md:h-11 md:w-11 bg-gradient-to-tr from-violet-600 to-cyan-500 rounded-xl flex items-center justify-center shadow-md shadow-violet-900/40 group-hover:scale-105 transition-transform">
                <Wifi className="w-5 h-5 md:w-6 md:h-6 text-white stroke-[2.5]" />
              </div>
              <div className="hidden sm:block">
                <h1 className="text-xl md:text-2xl font-black tracking-tight text-white flex items-center gap-1">
                  Ultra<span className="text-cyan-400">faiba</span>
                </h1>
                <span className="text-[9px] md:text-[10px] text-slate-400 font-mono tracking-widest block uppercase">Next-Gen ISP Solutions</span>
              </div>
            </button>

            {/* Right side */}
            <div className="flex items-center gap-3">
              {/* Live indicator */}
              <div className="hidden lg:flex items-center gap-1.5 bg-slate-950 px-3 py-1.5 rounded-lg border border-slate-800 text-xs text-slate-300 font-mono">
                <span className="w-2 h-2 bg-emerald-400 rounded-full animate-ping"></span>
                <span>Nodes: <strong className="text-emerald-400">99.98% Up</strong></span>
              </div>

              {/* Dark mode toggle */}
              <button
                onClick={() => setDarkMode(!darkMode)}
                className={`p-2.5 rounded-xl border transition-all ${
                  darkMode
                    ? 'bg-slate-800 border-slate-700 text-amber-400 hover:bg-slate-700'
                    : 'bg-slate-800 border-slate-700 text-slate-400 hover:text-white'
                }`}
                title={darkMode ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
              >
                {darkMode ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
              </button>

              {/* Phone */}
              <div className="hidden md:block text-slate-400 text-xs">
                Call/M-Pesa: <span className="text-white font-bold">0724167975</span>
                <CopyTextButton
                  value="0724167975"
                  label="Copy"
                  className="ml-2 inline-flex items-center gap-1 rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-[10px] font-bold text-slate-200 transition-colors hover:bg-slate-800"
                />
              </div>
            </div>
          </div>
        </div>

        {/* Global Notification */}
        {globalNotification && (
          <div className="bg-gradient-to-r from-violet-900 to-indigo-900 px-4 py-2 text-xs text-center text-violet-100 border-t border-violet-800 flex items-center justify-center gap-2 relative">
            <span className="font-bold bg-violet-700 px-1.5 py-0.5 rounded text-[10px] uppercase font-mono shrink-0">NOC Broadcast</span>
            <span className="truncate">{globalNotification}</span>
            <button onClick={() => setGlobalNotification(null)} className="ml-3 text-violet-400 hover:text-white font-bold shrink-0">✕</button>
          </div>
        )}
      </header>

      {/* ═══════════ MAIN CONTENT ═══════════ */}
      <main className="max-w-7xl w-full mx-auto p-4 sm:p-6 lg:p-8 flex-1 space-y-8">

        {/* Navigation Tabs */}
        <div className={`p-1.5 rounded-2xl border shadow-xs max-w-4xl mx-auto overflow-x-auto transition-colors duration-300 ${
          darkMode ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'
        }`}>
          <div className="flex gap-1 min-w-max">
            {navItems.map(item => (
              <button
                key={item.key}
                onClick={() => setCurrentView(item.key)}
                className={`py-2.5 px-3 md:px-4 rounded-xl text-[11px] md:text-xs font-bold tracking-tight transition-all flex items-center justify-center gap-1.5 whitespace-nowrap ${
                  currentView === item.key
                    ? 'bg-gradient-to-r from-violet-600 to-indigo-600 text-white shadow-md shadow-indigo-200/50'
                    : darkMode ? 'text-slate-400 hover:bg-slate-800 hover:text-white' : 'text-slate-500 hover:bg-slate-50 hover:text-slate-900'
                }`}
              >
                <item.icon className="w-3.5 h-3.5 shrink-0" />
                <span className="hidden sm:inline">{item.label}</span>
                {item.badge && (
                  item.badge === '●'
                    ? <span className="w-1.5 h-1.5 bg-emerald-400 rounded-full"></span>
                    : <span className="bg-amber-500 text-white font-extrabold text-[7px] px-1 rounded">{item.badge}</span>
                )}
              </button>
            ))}
          </div>
        </div>

        {/* View Renderer */}
        <div className="transition-opacity duration-200">
          {currentView === 'home' && (
            <LandingPage
              plans={plans}
              onNavigate={(v) => setCurrentView(v)}
              onQuickConnect={handleQuickConnect}
              darkMode={darkMode}
            />
          )}

          {currentView === 'hotspot' && (
            <HotspotPortal
              plans={plans}
              vouchers={vouchers}
              initialVoucherCode={hotspotPrefillCode}
              onActivateVoucher={handleActivateVoucher}
              isConnected={isConnected}
              activeVoucherCode={activeVoucherCode}
              onDisconnect={handleDisconnect}
              onPurchaseVoucher={handlePurchaseVoucher}
            />
          )}

          {currentView === 'billing' && (
            <ClientBilling
              client={client}
              invoices={invoices}
              tickets={tickets}
              plans={plans}
              darkMode={darkMode}
              onPayInvoice={handlePayInvoice}
              onAddTicket={handleAddTicket}
              onUpgradePlan={handleUpgradePlan}
            />
          )}

          {currentView === 'admin' && (
            <AdminDashboard
              plans={plans}
              vouchers={vouchers}
              sessions={sessions}
              nodes={nodes}
              onBulkGenerateVouchers={handleBulkGenerateVouchers}
              onClearExpiredVouchers={handleClearExpiredVouchers}
              onKickSession={handleKickSession}
              onToggleNodeStatus={handleToggleNodeStatus}
            />
          )}

          {currentView === 'analytics' && (
            <Analytics
              vouchers={vouchers}
              nodes={nodes}
              darkMode={darkMode}
            />
          )}

          {currentView === 'status' && (
            <NetworkStatus
              nodes={nodes}
              darkMode={darkMode}
            />
          )}

          {currentView === 'legal' && (
            <TermsAndConditions
              darkMode={darkMode}
              activeTab={legalTab}
              onTabChange={setLegalTab}
            />
          )}

          {currentView === 'mikrotik' && (
            <MikrotikConfig
              plans={plans}
              darkMode={darkMode}
            />
          )}
        </div>

        {/* Bottom Trust Section (only on non-home views) */}
        {currentView !== 'home' && (
          <div className={`rounded-3xl border p-6 md:p-8 shadow-xs grid grid-cols-1 md:grid-cols-3 gap-6 transition-colors duration-300 ${
            darkMode ? 'bg-slate-900/60 border-slate-800' : 'bg-gradient-to-br from-white to-slate-50 border-slate-200'
          }`}>
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-violet-600 font-bold text-sm uppercase font-mono tracking-wider">
                <Globe className="w-4 h-4 text-cyan-500" /> Ultra-Low Latency Fiber
              </div>
              <h4 className={`text-base font-black tracking-tight ${darkMode ? 'text-white' : 'text-slate-900'}`}>Pure Symmetrical Contention</h4>
              <p className={`text-xs leading-relaxed ${darkMode ? 'text-slate-400' : 'text-slate-500'}`}>
                Ultrafaiba provides pure lightwave technology without legacy copper bottlenecks. Get high download burst frequencies and consistent streaming throughput.
              </p>
            </div>
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-violet-600 font-bold text-sm uppercase font-mono tracking-wider">
                <CheckCircle className="w-4 h-4 text-emerald-500" /> Automated Micro-Billing
              </div>
              <h4 className={`text-base font-black tracking-tight ${darkMode ? 'text-white' : 'text-slate-900'}`}>Instant Radius Voucher Sync</h4>
              <p className={`text-xs leading-relaxed ${darkMode ? 'text-slate-400' : 'text-slate-500'}`}>
                Our automated system links directly to hardware routerboards. Once a code is acquired, bandwidth leases adjust in real-time.
              </p>
            </div>
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-violet-600 font-bold text-sm uppercase font-mono tracking-wider">
                <Smartphone className="w-4 h-4 text-indigo-500" /> 24/7 NOC Assistance
              </div>
              <h4 className={`text-base font-black tracking-tight ${darkMode ? 'text-white' : 'text-slate-900'}`}>Proactive Support Center</h4>
              <p className={`text-xs leading-relaxed ${darkMode ? 'text-slate-400' : 'text-slate-500'}`}>
                Log tickets instantly from any device. Our NOC engineers monitor lines continuously to dispatch field repair crews fast.
              </p>
            </div>
          </div>
        )}
      </main>

      {/* ═══════════ FOOTER ═══════════ */}
      <footer className={`text-xs border-t py-8 transition-colors duration-300 ${
        darkMode ? 'bg-slate-900 text-slate-400 border-slate-800' : 'bg-slate-950 text-slate-400 border-slate-900'
      }`}>
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-8 mb-8">
            {/* Brand Column */}
            <div className="md:col-span-1">
              <div className="flex items-center gap-2 mb-3">
                <div className="w-8 h-8 bg-gradient-to-tr from-violet-600 to-cyan-500 rounded-lg flex items-center justify-center">
                  <Wifi className="w-4 h-4 text-white" />
                </div>
                <span className="font-black text-white text-lg">Ultra<span className="text-cyan-400">faiba</span></span>
              </div>
              <p className="text-slate-500 text-[11px] leading-relaxed">
                Next-generation fiber optic internet service provider. Delivering blazing-fast connectivity to homes and businesses.
              </p>
            </div>

            {/* Quick Links */}
            <div>
              <h5 className="font-bold text-slate-200 uppercase text-[10px] tracking-widest mb-3">Services</h5>
              <ul className="space-y-1.5">
                {['Home Fiber Plans', 'Hotspot Vouchers', 'Business Solutions', 'Enterprise Leased Lines'].map(link => (
                  <li key={link}>
                    <button onClick={() => setCurrentView('home')} className="text-slate-500 hover:text-white transition-colors text-[11px]">
                      {link}
                    </button>
                  </li>
                ))}
              </ul>
            </div>

            <div>
              <h5 className="font-bold text-slate-200 uppercase text-[10px] tracking-widest mb-3">Support</h5>
              <ul className="space-y-1.5">
                {['Network Status', 'Knowledge Base', 'Contact NOC', 'Report Outage'].map(link => (
                  <li key={link}>
                    <button onClick={() => setCurrentView('status')} className="text-slate-500 hover:text-white transition-colors text-[11px]">
                      {link}
                    </button>
                  </li>
                ))}
              </ul>
            </div>

            <div>
              <h5 className="font-bold text-slate-200 uppercase text-[10px] tracking-widest mb-3">Contact & Payments</h5>
              <ul className="space-y-1.5 text-[11px] text-slate-500">
                <li>📞 0724167975</li>
                <li>📧 support@ultrafaiba.net</li>
                <li>🌐 ultrafaiba</li>
                <li>🕐 NOC: 24/7/365</li>
              </ul>
              <div className="mt-3 bg-emerald-950/50 border border-emerald-800/50 rounded-lg p-2.5">
                <span className="text-[9px] text-emerald-500 uppercase font-mono tracking-wider block mb-0.5">M-Pesa Payments</span>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-black text-emerald-400 font-mono">0724167975</span>
                  <CopyTextButton
                    value="0724167975"
                    label="Copy"
                    className="inline-flex items-center gap-1 rounded-md border border-emerald-800/60 bg-emerald-950 px-2 py-1 text-[10px] font-bold text-emerald-300 transition-colors hover:bg-emerald-900"
                  />
                </div>
              </div>
            </div>
          </div>

          <div className="pt-6 border-t border-slate-800 flex flex-col sm:flex-row justify-between items-center gap-4 text-center sm:text-left">
            <div className="space-y-1">
              <p className="font-bold text-slate-300">
                ⚡ Ultrafaiba Network Operations & High Speed Hotspots Inc.
              </p>
              <p className="text-[10px] text-slate-500 font-mono">
                Central Core ID: AS-99411-FAIBANET • MikroTik Hotspot RouterOS v7.x Authenticated
              </p>
            </div>
            <div className="flex gap-4 font-medium text-[11px]">
              <button className="hover:text-white transition-colors" onClick={() => { setLegalTab('terms'); setCurrentView('legal'); window.scrollTo(0,0); }}>Terms of Service</button>
              <span className="text-slate-700">•</span>
              <button className="hover:text-white transition-colors" onClick={() => { setLegalTab('privacy'); setCurrentView('legal'); window.scrollTo(0,0); }}>Privacy Policy</button>
              <span className="text-slate-700">•</span>
              <button className="hover:text-white transition-colors" onClick={() => { setLegalTab('refund'); setCurrentView('legal'); window.scrollTo(0,0); }}>Refund Policy</button>
              <span className="text-slate-700">•</span>
              <span className="text-violet-400 font-bold">© 2026</span>
            </div>
          </div>
        </div>
      </footer>

      {/* ═══════════ LIVE CHAT WIDGET ═══════════ */}
      <LiveChat darkMode={darkMode} />
    </div>
  );
}

import React, { useState } from 'react';
import { ShieldCheck, Mail, Phone, Calendar, ArrowUpRight, MessageSquare, PlusCircle, Activity, Gauge, Smartphone, Send, Loader2, CheckCircle } from 'lucide-react';
import { ClientProfile, Invoice, SupportTicket, HotspotPlan } from '../data/mockData';
import CopyTextButton from './CopyTextButton';
import { initiateStkPush, queryStkPushStatus } from '../services/darajaApi';

interface ClientBillingProps {
  client: ClientProfile;
  invoices: Invoice[];
  tickets: SupportTicket[];
  plans: HotspotPlan[];
  darkMode: boolean;
  onPayInvoice: (invoiceId: string) => void;
  onAddTicket: (subject: string, category: 'Speed Issue' | 'Payment Failed' | 'Router Offline' | 'Voucher Code Error', priority: 'Low' | 'Medium' | 'High') => void;
  onUpgradePlan: (planName: string) => void;
}

export default function ClientBilling({
  client,
  invoices,
  tickets,
  plans,
  darkMode,
  onPayInvoice,
  onAddTicket,
  onUpgradePlan
}: ClientBillingProps) {
  const [activeTab, setActiveTab] = useState<'overview' | 'invoices' | 'support'>('overview');
  
  // New ticket state
  const [showNewTicketForm, setShowNewTicketForm] = useState(false);
  const [ticketSubject, setTicketSubject] = useState('');
  const [ticketCategory, setTicketCategory] = useState<'Speed Issue' | 'Payment Failed' | 'Router Offline' | 'Voucher Code Error'>('Speed Issue');
  const [ticketPriority, setTicketPriority] = useState<'Low' | 'Medium' | 'High'>('Medium');

  // Plan upgrading state
  const [showUpgradeModal, setShowUpgradeModal] = useState(false);

  // M-Pesa autopay state
  const [autopayPhone, setAutopayPhone] = useState('');
  const [autopayOpen, setAutopayOpen] = useState(false);
  const [autopayStage, setAutopayStage] = useState<'idle' | 'sending' | 'awaiting-pin' | 'success'>('idle');

  // Speed test simulation state
  const [isTestingSpeed, setIsTestingSpeed] = useState(false);
  const [testDownSpeed, setTestDownSpeed] = useState<number | null>(null);
  const [testUpSpeed, setTestUpSpeed] = useState<number | null>(null);
  const [testPing, setTestPing] = useState<number | null>(null);

  const unpaidInvoice = invoices.find((inv) => inv.status === 'Unpaid') ?? invoices[0];
  const autopayAmount = unpaidInvoice?.amount ?? 0;
  const autopayPlan = unpaidInvoice?.planName ?? client.currentPlan;

  const fiberPlans = plans.filter(p => p.type === 'fiber');

  const handleStartSpeedTest = () => {
    setIsTestingSpeed(true);
    setTestDownSpeed(null);
    setTestUpSpeed(null);
    setTestPing(null);

    let progress = 0;
    const interval = setInterval(() => {
      progress += 20;
      if (progress >= 100) {
        clearInterval(interval);
        // Base results on active client plan speed
        const multiplier = client.currentPlan.includes('100 Mbps') ? 2.0 : client.currentPlan.includes('50 Mbps') ? 1.0 : 0.4;
        setTestDownSpeed(Math.floor(45 + Math.random() * 8) * multiplier);
        setTestUpSpeed(Math.floor(42 + Math.random() * 6) * multiplier);
        setTestPing(Math.floor(4 + Math.random() * 7));
        setIsTestingSpeed(false);
      }
    }, 400);
  };

  const submitTicket = (e: React.FormEvent) => {
    e.preventDefault();
    if (!ticketSubject.trim()) return;
    onAddTicket(ticketSubject, ticketCategory, ticketPriority);
    setTicketSubject('');
    setShowNewTicketForm(false);
  };

  const [checkoutRequestId, setCheckoutRequestId] = useState('');
  const [apiError, setApiError] = useState<string | null>(null);

  const startAutopay = async () => {
    const cleanedPhone = autopayPhone.replace(/\s+/g, '');
    if (!cleanedPhone) return;

    setAutopayOpen(true);
    setAutopayStage('sending');
    setApiError(null);

    try {
      // Call real Daraja API
      const response = await initiateStkPush({
        phoneNumber: cleanedPhone,
        amount: autopayAmount,
        accountReference: `INV-${unpaidInvoice?.id || 'NEW'}`,
        transactionDesc: `Payment for ${autopayPlan}`
      });

      if (response.ResponseCode === '0') {
        setCheckoutRequestId(response.CheckoutRequestID);
        setAutopayStage('awaiting-pin');
        
        // Start polling for payment status
        pollPaymentStatus(response.CheckoutRequestID);
      } else {
        setApiError(response.ResponseDescription || 'Failed to initiate payment');
        setAutopayStage('idle');
      }
    } catch (error: any) {
      setApiError(error.message || 'Network error. Please try again.');
      setAutopayStage('idle');
    }
  };

  const pollPaymentStatus = async (checkoutId: string) => {
    // Poll every 5 seconds for up to 2 minutes
    let attempts = 0;
    const maxAttempts = 24; // 2 minutes
    
    const checkStatus = async () => {
      try {
        const status = await queryStkPushStatus(checkoutId);
        
        if (status.ResultCode === '0') {
          // Payment successful
          if (unpaidInvoice) {
            onPayInvoice(unpaidInvoice.id);
          }
          setAutopayStage('success');
          
          window.setTimeout(() => {
            setAutopayOpen(false);
            setAutopayStage('idle');
            setAutopayPhone('');
            setCheckoutRequestId('');
          }, 2000);
          return;
        } else if (status.ResultCode && status.ResultCode !== '0') {
          // Payment failed
          setApiError(status.ResultDesc || 'Payment failed');
          setAutopayStage('idle');
          return;
        }
        
        // Still pending, continue polling
        attempts++;
        if (attempts < maxAttempts) {
          window.setTimeout(checkStatus, 5000);
        } else {
          setApiError('Payment confirmation timeout. Please check your M-Pesa messages.');
          setAutopayStage('idle');
        }
      } catch (error) {
        attempts++;
        if (attempts < maxAttempts) {
          window.setTimeout(checkStatus, 5000);
        }
      }
    };
    
    window.setTimeout(checkStatus, 5000);
  };

  const completeAutopay = () => {
    // Manual confirmation fallback
    if (unpaidInvoice) {
      onPayInvoice(unpaidInvoice.id);
    }
    setAutopayStage('success');

    window.setTimeout(() => {
      setAutopayOpen(false);
      setAutopayStage('idle');
      setAutopayPhone('');
      setCheckoutRequestId('');
    }, 1600);
  };

  return (
    <div className="space-y-6">
      {/* Client Quick Stats Badge & Tab Switcher */}
      <div className="bg-slate-900 text-white rounded-3xl p-6 shadow-xl border border-slate-800">
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
          <div className="flex items-center space-x-4">
            <div className="w-14 h-14 rounded-2xl bg-gradient-to-tr from-violet-500 to-indigo-600 flex items-center justify-center font-bold text-white text-xl shadow-md">
              {client.name.split(' ').map(n => n[0]).join('')}
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-xl font-bold tracking-tight">{client.name}</h3>
                <span className="bg-emerald-500/20 text-emerald-400 text-xs font-bold px-2 py-0.5 rounded border border-emerald-500/30 flex items-center gap-1">
                  <ShieldCheck className="w-3 h-3" /> Account Active
                </span>
              </div>
              <p className="text-xs text-slate-400 font-mono mt-0.5">Subscriber ID: <span className="text-violet-400 font-semibold">{client.accountNo}</span></p>
            </div>
          </div>

          <div className="flex items-center gap-2 bg-slate-950 p-1.5 rounded-xl border border-slate-800 w-full md:w-auto overflow-x-auto">
            <button
              onClick={() => setActiveTab('overview')}
              className={`px-4 py-2 rounded-lg text-xs font-bold transition-all whitespace-nowrap ${
                activeTab === 'overview' ? 'bg-violet-600 text-white shadow-sm' : 'text-slate-400 hover:text-white'
              }`}
            >
              Subscription Overview
            </button>
            <button
              onClick={() => setActiveTab('invoices')}
              className={`px-4 py-2 rounded-lg text-xs font-bold transition-all relative whitespace-nowrap ${
                activeTab === 'invoices' ? 'bg-violet-600 text-white shadow-sm' : 'text-slate-400 hover:text-white'
              }`}
            >
              Billing & Invoices
              {invoices.some(i => i.status === 'Unpaid') && (
                <span className="absolute top-1 right-1 w-2 h-2 bg-amber-500 rounded-full"></span>
              )}
            </button>
            <button
              onClick={() => setActiveTab('support')}
              className={`px-4 py-2 rounded-lg text-xs font-bold transition-all whitespace-nowrap ${
                activeTab === 'support' ? 'bg-violet-600 text-white shadow-sm' : 'text-slate-400 hover:text-white'
              }`}
            >
              Support Tickets ({tickets.length})
            </button>
          </div>
        </div>

        {/* Extended metadata list */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-6 pt-6 border-t border-slate-800/80 text-xs text-slate-300">
          <div className="flex items-center gap-2">
            <Mail className="w-4 h-4 text-slate-500" />
            <div>
              <span className="text-[10px] text-slate-500 block uppercase">Email Contact</span>
              <span className="font-medium truncate block max-w-[140px]">{client.email}</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Phone className="w-4 h-4 text-slate-500" />
            <div>
              <span className="text-[10px] text-slate-500 block uppercase">Phone Number</span>
              <span className="font-medium">{client.phone}</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Calendar className="w-4 h-4 text-slate-500" />
            <div>
              <span className="text-[10px] text-slate-500 block uppercase">Next Invoice Date</span>
              <span className="font-semibold text-cyan-400">{client.expiryDate}</span>
            </div>
          </div>
        </div>
      </div>

      {/* CONDITIONAL TAB COMPONENTS */}
      
      {activeTab === 'overview' && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {/* Active Plan Detail widget */}
          <div className="bg-white rounded-3xl border border-slate-200 p-6 shadow-sm flex flex-col justify-between">
            <div>
              <span className="text-xs font-bold text-violet-600 uppercase tracking-widest block mb-1">CURRENT ASSIGNED TARIFF</span>
              <h4 className="text-2xl font-black text-slate-900 tracking-tight">{client.currentPlan}</h4>
              <p className="text-sm text-slate-500 mt-2">
                Delivered over low-latency FTTH (Fiber to the Home) architecture with 1:1 dedicated contention ratio.
              </p>
              
              <div className="mt-4 bg-slate-50 rounded-xl p-3 border border-slate-150 space-y-2 text-xs">
                <div className="flex justify-between">
                  <span className="text-slate-500">Connection Type:</span>
                  <span className="font-bold text-slate-800">FTTH Fiber Optic</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Fair Usage Cap:</span>
                  <span className="font-semibold text-emerald-600">Truly Unlimited</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Account Status:</span>
                  <span className="font-mono text-emerald-600 text-[11px] font-semibold">Active & Provisioned</span>
                </div>
              </div>
            </div>

            <div className="mt-6 pt-4 border-t border-slate-100">
              <button
                onClick={() => setShowUpgradeModal(true)}
                className="w-full bg-slate-900 hover:bg-slate-800 text-white font-bold py-2.5 px-4 rounded-xl text-xs tracking-wide transition-colors flex items-center justify-center gap-1"
              >
                <ArrowUpRight className="w-4 h-4" />
                Change / Upgrade Fiber Plan
              </button>
            </div>
          </div>

          {/* Real-time Bandwidth Line Simulator */}
          <div className="bg-white rounded-3xl border border-slate-200 p-6 shadow-sm md:col-span-2">
            <div className="flex justify-between items-center mb-4">
              <div>
                <h4 className="font-bold text-slate-900 text-base flex items-center gap-1">
                  <Gauge className="w-5 h-5 text-indigo-600" />
                  Live Fiber Telemetry & Speed Utility
                </h4>
                <p className="text-xs text-slate-500">Test actual link state straight to the Ultrafaiba Core Server node</p>
              </div>
              <button
                onClick={handleStartSpeedTest}
                disabled={isTestingSpeed}
                className="bg-indigo-50 hover:bg-indigo-100 text-indigo-700 font-bold text-xs py-1.5 px-3 rounded-lg border border-indigo-200 transition-colors"
              >
                {isTestingSpeed ? 'Measuring...' : 'Run Speed Diagnostics'}
              </button>
            </div>

            {/* Speed Test Graphic Display */}
            <div className="bg-slate-950 text-slate-100 rounded-2xl p-4 grid grid-cols-3 gap-2 text-center relative overflow-hidden">
              {isTestingSpeed && (
                <div className="absolute inset-0 bg-slate-900/80 backdrop-blur-xs flex flex-col items-center justify-center text-xs text-indigo-400">
                  <Activity className="w-8 h-8 animate-spin text-indigo-400 mb-1" />
                  <span>Pinging gateway & saturating pipeline...</span>
                </div>
              )}

              <div className="p-2 bg-slate-900 rounded-xl border border-slate-800">
                <span className="text-[10px] text-slate-500 uppercase block font-mono">Ping Latency</span>
                <span className="text-xl font-black text-cyan-400 font-mono">
                  {testPing !== null ? `${testPing} ms` : '5 ms'}
                </span>
                <span className="text-[9px] text-slate-400 block mt-0.5">Ultra Stable</span>
              </div>

              <div className="p-2 bg-slate-900 rounded-xl border border-slate-800">
                <span className="text-[10px] text-slate-500 uppercase block font-mono">Download Rate</span>
                <span className="text-xl font-black text-emerald-400 font-mono">
                  {testDownSpeed !== null ? `${testDownSpeed} Mbps` : `${client.bandwidth.split(' ')[0]} Mbps`}
                </span>
                <span className="text-[9px] text-emerald-500/80 block mt-0.5">✓ 100% Provisioned</span>
              </div>

              <div className="p-2 bg-slate-900 rounded-xl border border-slate-800">
                <span className="text-[10px] text-slate-500 uppercase block font-mono">Upload Rate</span>
                <span className="text-xl font-black text-violet-400 font-mono">
                  {testUpSpeed !== null ? `${testUpSpeed} Mbps` : `${client.bandwidth.split(' ')[0]} Mbps`}
                </span>
                <span className="text-[9px] text-slate-400 block mt-0.5">Symmetrical Link</span>
              </div>
            </div>

            {/* Simulated Live Bandwidth Usage Blocks */}
            <div className="mt-4 space-y-2">
              <div className="flex justify-between items-center text-xs text-slate-600">
                <span>Monthly Telemetry Data Consumption:</span>
                <span className="font-bold text-slate-800">412.84 GB / Unlimited</span>
              </div>
              <div className="w-full bg-slate-100 h-2 rounded-full overflow-hidden">
                <div className="bg-gradient-to-r from-violet-600 to-indigo-500 h-2 rounded-full" style={{ width: '42%' }}></div>
              </div>
              <p className="text-[11px] text-slate-400 italic">
                *Ultrafaiba does not throttle speed caps regardless of download volume. Contentment factor remains fixed.
              </p>
            </div>
          </div>
        </div>
      )}

      {activeTab === 'invoices' && (
        <div className="bg-white rounded-3xl border border-slate-200 p-6 shadow-sm">
          <div className="mb-4">
            <h4 className="font-extrabold text-slate-900 text-lg">Billing History & Automated Statements</h4>
            <p className="text-xs text-slate-500">Pay your upcoming invoices or download certified transaction tokens.</p>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="bg-slate-50 text-slate-600 border-b border-slate-150 uppercase tracking-wider font-semibold">
                  <th className="p-3">Invoice Code</th>
                  <th className="p-3">Billing Cycle</th>
                  <th className="p-3">Assigned Plan</th>
                  <th className="p-3">Amount Due</th>
                  <th className="p-3">Due Date</th>
                  <th className="p-3">Payment Status</th>
                  <th className="p-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-slate-700">
                {invoices.map((inv) => (
                  <tr key={inv.id} className="hover:bg-slate-50/60 transition-colors">
                    <td className="p-3 font-mono font-bold text-slate-900">{inv.id}</td>
                    <td className="p-3 font-medium text-slate-800">{inv.billingMonth}</td>
                    <td className="p-3 text-slate-600">{inv.planName}</td>
                    <td className="p-3 font-bold text-slate-900">{inv.amount.toLocaleString()} BOB</td>
                    <td className="p-3 text-slate-500">{inv.dueDate}</td>
                    <td className="p-3">
                      <span className={`px-2 py-0.5 rounded-full font-bold text-[10px] uppercase ${
                        inv.status === 'Paid' 
                          ? 'bg-emerald-100 text-emerald-800 border border-emerald-200' 
                          : 'bg-amber-100 text-amber-800 border border-amber-200'
                      }`}>
                        {inv.status}
                      </span>
                    </td>
                    <td className="p-3 text-right">
                      {inv.status === 'Unpaid' ? (
                        <button
                          onClick={() => onPayInvoice(inv.id)}
                          className="bg-emerald-600 hover:bg-emerald-700 text-white font-extrabold px-3 py-1 rounded-md text-[11px] shadow-sm transition-transform active:scale-95"
                        >
                          💸 Pay Online Now
                        </button>
                      ) : (
                        <span className="text-slate-400 italic text-[11px]">Paid Receipt ✓</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* M-Pesa Payment Info */}
          <div className="mt-6 bg-gradient-to-br from-emerald-50 to-teal-50 border-2 border-emerald-300 rounded-2xl p-5">
            <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4">
              <div className="flex-1 space-y-2">
                <h4 className="font-bold text-emerald-900 text-sm flex items-center gap-2">
                  📱 Pay via M-Pesa
                </h4>
                <p className="text-xs text-emerald-700 leading-relaxed">
                  Send your monthly subscription payment directly to our M-Pesa line. Your account will be activated automatically once payment is confirmed.
                </p>
                <ol className="text-[11px] text-emerald-700 space-y-0.5 list-decimal list-inside">
                  <li>Open M-Pesa → <strong>Send Money</strong></li>
                  <li>Enter number: <strong className="font-mono">0724167975</strong></li>
                  <li>Enter your invoice amount</li>
                  <li>Confirm with your M-Pesa PIN</li>
                </ol>
              </div>
              <div className="bg-white rounded-xl p-4 border border-emerald-200 text-center min-w-[160px] shadow-sm">
                <span className="text-[10px] text-slate-400 block uppercase font-mono tracking-widest mb-1">Pay to Number</span>
                <div className="flex items-center justify-center gap-2 flex-wrap">
                  <span className="text-2xl font-black text-emerald-700 font-mono tracking-wider block">0724167975</span>
                  <CopyTextButton
                    value="0724167975"
                    label="Copy"
                    className="inline-flex items-center gap-1 rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[11px] font-bold text-emerald-700 transition-colors hover:bg-emerald-100"
                  />
                </div>
                <span className="text-[10px] text-slate-500 block mt-1">Ultrafaiba Internet</span>
              </div>
            </div>
          </div>

          {/* AutoPay STK Push */}
          <div className={`mt-4 rounded-2xl border p-5 ${darkMode ? 'bg-slate-900 border-slate-700' : 'bg-slate-50 border-slate-200'}`}>
            <div className="flex items-start justify-between gap-4 flex-col md:flex-row">
              <div className="space-y-2 flex-1">
                <h4 className={`font-bold text-sm flex items-center gap-2 ${darkMode ? 'text-white' : 'text-slate-900'}`}>
                  <Smartphone className="w-4 h-4 text-emerald-500" />
                  AutoPay via M-Pesa STK Push
                </h4>
                <p className={`text-xs leading-relaxed ${darkMode ? 'text-slate-400' : 'text-slate-500'}`}>
                  Type the customer's phone number and Ultrafaiba will trigger an STK push for the subscribed amount automatically.
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
                  <div>
                    <label className={`block text-[10px] font-bold uppercase tracking-wider mb-1 ${darkMode ? 'text-slate-400' : 'text-slate-500'}`}>
                      Customer Phone Number
                    </label>
                    <input
                      type="tel"
                      value={autopayPhone}
                      onChange={(e) => setAutopayPhone(e.target.value)}
                      placeholder="0712 345 678"
                      className={`w-full rounded-xl border px-3 py-2 text-sm font-mono outline-none ${darkMode ? 'bg-slate-950 border-slate-700 text-white placeholder-slate-500' : 'bg-white border-slate-300 text-slate-800 placeholder-slate-400'}`}
                    />
                  </div>
                  <div className={`rounded-xl border px-3 py-2 ${darkMode ? 'bg-slate-950 border-slate-700' : 'bg-white border-slate-200'}`}>
                    <span className={`text-[10px] font-bold uppercase tracking-wider block ${darkMode ? 'text-slate-500' : 'text-slate-400'}`}>Subscribed Amount</span>
                    <span className={`text-lg font-black ${darkMode ? 'text-emerald-400' : 'text-emerald-700'}`}>{autopayAmount.toLocaleString()} BOB</span>
                    <span className={`text-[10px] block ${darkMode ? 'text-slate-500' : 'text-slate-400'}`}>{autopayPlan}</span>
                  </div>
                </div>
              </div>

              <button
                type="button"
                onClick={startAutopay}
                className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-bold text-white shadow-sm transition-colors hover:bg-emerald-700 disabled:opacity-60"
                disabled={!autopayPhone.trim()}
              >
                <Send className="w-4 h-4" />
                Send STK Push
              </button>
            </div>
          </div>
        </div>
      )}

      {activeTab === 'support' && (
        <div className="bg-white rounded-3xl border border-slate-200 p-6 shadow-sm space-y-6">
          <div className="flex justify-between items-center">
            <div>
              <h4 className="font-extrabold text-slate-900 text-lg flex items-center gap-2">
                <MessageSquare className="w-5 h-5 text-violet-600" />
                Line Operation Helpdesk Tickets
              </h4>
              <p className="text-xs text-slate-500">Direct integration to the NOC (Network Operations Center) engineers.</p>
            </div>
            <button
              onClick={() => setShowNewTicketForm(!showNewTicketForm)}
              className="bg-violet-600 hover:bg-violet-700 text-white font-bold text-xs py-2 px-3 rounded-xl flex items-center gap-1 shadow-sm transition-all"
            >
              <PlusCircle className="w-4 h-4" />
              {showNewTicketForm ? 'Cancel Form' : 'Log Line Issue'}
            </button>
          </div>

          {/* New Ticket Form Panel */}
          {showNewTicketForm && (
            <form onSubmit={submitTicket} className="bg-slate-50 p-4 rounded-2xl border border-slate-200 space-y-3">
              <h5 className="font-bold text-xs text-slate-700 uppercase tracking-wider">Report New Terminal Failure / Speed Drop</h5>
              
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="sm:col-span-2">
                  <label className="block text-[11px] text-slate-500 mb-1">Brief Description of Issue</label>
                  <input
                    type="text"
                    value={ticketSubject}
                    onChange={(e) => setTicketSubject(e.target.value)}
                    placeholder="e.g. Extreme high latency during evening stream caps"
                    className="w-full text-xs p-2 rounded-lg border border-slate-300 bg-white"
                    required
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-slate-500 mb-1">Problem Category</label>
                  <select
                    value={ticketCategory}
                    onChange={(e: any) => setTicketCategory(e.target.value)}
                    className="w-full text-xs p-2 rounded-lg border border-slate-300 bg-white text-slate-800"
                  >
                    <option value="Speed Issue">Speed Issue</option>
                    <option value="Payment Failed">Payment Failed</option>
                    <option value="Router Offline">Router Offline</option>
                    <option value="Voucher Code Error">Voucher Code Error</option>
                  </select>
                </div>
              </div>

              <div className="flex justify-between items-center pt-2">
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-slate-500">Urgency:</span>
                  {['Low', 'Medium', 'High'].map((p: any) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => setTicketPriority(p)}
                      className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                        ticketPriority === p 
                          ? 'bg-slate-900 text-white' 
                          : 'bg-slate-200 text-slate-600 hover:bg-slate-300'
                      }`}
                    >
                      {p}
                    </button>
                  ))}
                </div>
                <button
                  type="submit"
                  className="bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold py-1.5 px-4 rounded-lg"
                >
                  Broadcast to Engineers
                </button>
              </div>
            </form>
          )}

          {/* Ticket Iteration Feed */}
          <div className="space-y-4">
            {tickets.map((t) => (
              <div key={t.id} className="border border-slate-200 rounded-2xl overflow-hidden shadow-xs">
                {/* Header info */}
                <div className="bg-slate-50 p-3 border-b border-slate-200 flex flex-col sm:flex-row justify-between sm:items-center gap-2 text-xs">
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-extrabold text-slate-900 bg-slate-200/80 px-1.5 py-0.5 rounded text-[11px]">
                      {t.id}
                    </span>
                    <strong className="text-slate-800 text-sm">{t.subject}</strong>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-slate-400 text-[11px]">{t.date}</span>
                    <span className={`px-2 py-0.5 rounded font-mono text-[10px] font-bold ${
                      t.priority === 'High' ? 'bg-rose-100 text-rose-800' : 'bg-slate-100 text-slate-800'
                    }`}>
                      {t.priority} Priority
                    </span>
                    <span className={`px-2 py-0.5 rounded font-bold text-[10px] uppercase ${
                      t.status === 'Resolved' ? 'bg-emerald-100 text-emerald-800' : 'bg-blue-100 text-blue-800'
                    }`}>
                      • {t.status}
                    </span>
                  </div>
                </div>

                {/* Messages stream */}
                <div className="p-3 bg-white space-y-2.5">
                  {t.messages.map((m, idx) => (
                    <div
                      key={idx}
                      className={`p-2.5 rounded-xl text-xs max-w-[85%] ${
                        m.sender === 'client' 
                          ? 'bg-slate-100 text-slate-800 ml-0' 
                          : 'bg-violet-50 text-violet-900 ml-auto border border-violet-100'
                      }`}
                    >
                      <div className="flex justify-between font-bold text-[10px] mb-1 text-slate-400">
                        <span>{m.sender === 'client' ? 'Alex Mercer (You)' : 'Ultrafaiba Support Bot NOC'}</span>
                        <span>{m.time}</span>
                      </div>
                      <p className="leading-relaxed font-medium">{m.text}</p>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* PLAN UPGRADE MODAL WIDGET SIMULATOR */}
      {showUpgradeModal && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-3xl p-6 max-w-lg w-full border border-slate-200 shadow-2xl space-y-4">
            <div className="flex justify-between items-start">
              <div>
                <h4 className="text-lg font-black text-slate-900">Select Instant Upgrade Fiber Tier</h4>
                <p className="text-xs text-slate-500">Your router provisioning lease automatically scales instantly upon change.</p>
              </div>
              <button
                onClick={() => setShowUpgradeModal(false)}
                className="text-slate-400 hover:text-slate-600 font-bold p-1"
              >
                ✕
              </button>
            </div>

            <div className="space-y-2">
              {fiberPlans.map((fp) => (
                <div
                  key={fp.id}
                  onClick={() => {
                    onUpgradePlan(fp.name);
                    setShowUpgradeModal(false);
                  }}
                  className="p-3 border rounded-xl hover:border-violet-600 hover:bg-violet-50/40 cursor-pointer transition-all flex justify-between items-center"
                >
                  <div>
                    <span className="font-bold text-sm text-slate-900 block">{fp.name}</span>
                    <span className="text-xs text-slate-500">⚡ High Speed Fiber • {fp.duration}</span>
                  </div>
                  <span className="font-extrabold text-violet-600 text-sm">{fp.price.toLocaleString()} BOB/mo</span>
                </div>
              ))}
            </div>

            <p className="text-[11px] text-slate-400 text-center italic">
              *Pro-rated pricing updates automatically inside upcoming invoice statement log.
            </p>
          </div>
        </div>
      )}

      {/* Autopay Modal */}
      {autopayOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4 backdrop-blur-sm">
          <div className={`w-full max-w-md rounded-3xl border p-6 shadow-2xl ${darkMode ? 'bg-slate-900 border-slate-700' : 'bg-white border-slate-200'}`}>
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className={`text-lg font-black ${darkMode ? 'text-white' : 'text-slate-900'}`}>M-Pesa STK Push</h3>
                <p className={`text-xs ${darkMode ? 'text-slate-400' : 'text-slate-500'}`}>
                  Approve the payment on the customer's phone
                </p>
              </div>
              <button
                type="button"
                onClick={() => setAutopayOpen(false)}
                className={`rounded-lg p-2 transition-colors ${darkMode ? 'text-slate-400 hover:bg-slate-800 hover:text-white' : 'text-slate-500 hover:bg-slate-100 hover:text-slate-900'}`}
              >
                ✕
              </button>
            </div>

            <div className="mt-5 rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-emerald-700 font-semibold">Phone</span>
                  <span className="font-mono font-bold text-emerald-900">{autopayPhone}</span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-emerald-700 font-semibold">Amount</span>
                  <span className="font-mono font-black text-emerald-900">{autopayAmount.toLocaleString()} BOB</span>
                </div>
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-emerald-700 font-semibold">Plan</span>
                    <span className="font-medium text-emerald-900">{autopayPlan}</span>
                  </div>
                  {checkoutRequestId && (
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-emerald-700 font-semibold">Reference</span>
                      <span className="font-mono text-emerald-900">{checkoutRequestId.slice(-8)}</span>
                    </div>
                  )}
                </div>
              </div>

            {apiError && (
              <div className={`mt-4 rounded-xl border p-3 ${darkMode ? 'border-rose-800 bg-rose-950/40' : 'border-rose-200 bg-rose-50'}`}>
                <div className="flex items-start gap-2 text-sm text-rose-700">
                  <span className="text-lg">⚠️</span>
                  <span>{apiError}</span>
                </div>
              </div>
            )}

            <div className={`mt-4 rounded-2xl border p-4 ${darkMode ? 'border-slate-700 bg-slate-950' : 'border-slate-200 bg-slate-50'}`}>
              {autopayStage === 'sending' && (
                <div className="flex items-center gap-3 text-sm">
                  <Loader2 className="w-5 h-5 animate-spin text-emerald-500" />
                  <span className={darkMode ? 'text-slate-300' : 'text-slate-700'}>Sending STK push via Safaricom Daraja API...</span>
                </div>
              )}
              {autopayStage === 'awaiting-pin' && (
                <div className="space-y-3">
                  <div className="flex items-center gap-3 text-sm">
                    <CheckCircle className="w-5 h-5 text-emerald-500" />
                    <span className={darkMode ? 'text-slate-300' : 'text-slate-700'}>STK push sent! Check the customer's phone for the M-Pesa PIN prompt.</span>
                  </div>
                  <div className="text-xs text-slate-500">
                    Waiting for customer to enter PIN and confirm...
                  </div>
                  <button
                    type="button"
                    onClick={completeAutopay}
                    className="w-full rounded-xl bg-slate-200 px-4 py-2.5 text-sm font-bold text-slate-700 transition-colors hover:bg-slate-300"
                  >
                    Mark as Complete (Manual)
                  </button>
                </div>
              )}
              {autopayStage === 'success' && (
                <div className="flex items-center gap-3 text-sm text-emerald-700">
                  <CheckCircle className="w-5 h-5" />
                  <span>Payment confirmed! Invoice marked as paid.</span>
                </div>
              )}
            </div>

            <p className={`mt-4 text-[11px] leading-relaxed ${darkMode ? 'text-slate-500' : 'text-slate-400'}`}>
              Connected to Safaricom Daraja API. The STK push is sent directly to the customer's phone.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

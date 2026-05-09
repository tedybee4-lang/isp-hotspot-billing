import React, { useState } from 'react';
import { Wifi, ShieldAlert, ShieldCheck, Ticket, Zap, Smartphone, CheckCircle, RefreshCw, Layers } from 'lucide-react';
import { HotspotPlan, Voucher } from '../data/mockData';
import CopyTextButton from './CopyTextButton';

interface HotspotPortalProps {
  plans: HotspotPlan[];
  vouchers: Voucher[];
  initialVoucherCode?: string;
  onActivateVoucher: (code: string) => { success: boolean; message: string };
  isConnected: boolean;
  activeVoucherCode: string | null;
  onDisconnect: () => void;
  onPurchaseVoucher: (plan: HotspotPlan, method: string) => string; 
}

export default function HotspotPortal({
  plans,
  vouchers,
  initialVoucherCode,
  onActivateVoucher,
  isConnected,
  activeVoucherCode,
  onDisconnect,
  onPurchaseVoucher
}: HotspotPortalProps) {
  const [inputCode, setInputCode] = useState('');
  const [selectedPlanId, setSelectedPlanId] = useState(plans.filter(p => p.type === 'hotspot')[1]?.id || plans[0].id);
  const [phoneNumber, setPhoneNumber] = useState('');
  const [recentGeneratedCode, setRecentGeneratedCode] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authSuccess, setAuthSuccess] = useState<string | null>(null);

  React.useEffect(() => {
    if (initialVoucherCode) {
      setInputCode(initialVoucherCode.toUpperCase());
    }
  }, [initialVoucherCode]);

  const hotspotPlans = plans.filter(p => p.type === 'hotspot');
  const activePlanDetails = plans.find(p => p.id === selectedPlanId);

  const handleConnect = (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError(null);
    setAuthSuccess(null);
    
    if (!inputCode.trim()) {
      setAuthError('Please enter a valid Ultrafaiba voucher code.');
      return;
    }

    const result = onActivateVoucher(inputCode.trim());
    if (result.success) {
      setAuthSuccess(result.message);
      setInputCode('');
    } else {
      setAuthError(result.message);
    }
  };

  const handleBuy = (e: React.FormEvent) => {
    e.preventDefault();
    if (!activePlanDetails) return;

    setLoading(true);
    setTimeout(() => {
      const targetMethodName = 'M-Pesa (0724167975)';
      
      const codeGenerated = onPurchaseVoucher(activePlanDetails, targetMethodName);
      setRecentGeneratedCode(codeGenerated);
      setInputCode(codeGenerated); // Auto-fill for convenience!
      setLoading(false);
    }, 1200);
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
      {/* Active Gateway Connectivity Status Card */}
      <div className="lg:col-span-5 space-y-6">
        <div className={`p-6 rounded-3xl border shadow-xl backdrop-blur-md transition-all ${
          isConnected 
            ? 'bg-gradient-to-br from-emerald-950 via-slate-900 to-zinc-950 border-emerald-500/40 text-white' 
            : 'bg-gradient-to-br from-indigo-950 via-slate-900 to-zinc-950 border-violet-500/40 text-white'
        }`}>
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center space-x-3">
              <div className={`p-3 rounded-2xl ${isConnected ? 'bg-emerald-500/20 text-emerald-400' : 'bg-amber-500/20 text-amber-400'}`}>
                <Wifi className={`w-6 h-6 ${isConnected ? 'animate-pulse' : ''}`} />
              </div>
              <div>
                <span className="text-xs text-slate-400 font-mono tracking-widest block">NETWORK NODE GATEWAY</span>
                <h3 className="font-bold text-lg tracking-tight">Ultrafaiba Zone Max</h3>
              </div>
            </div>
            <span className={`px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wider ${
              isConnected ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30' : 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
            }`}>
              {isConnected ? 'Connected' : 'Action Required'}
            </span>
          </div>

          <div className="bg-slate-900/60 rounded-2xl p-4 border border-slate-800 my-4 space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-slate-400">Connection Status:</span>
              <span className={`font-semibold flex items-center gap-1 ${isConnected ? 'text-emerald-400' : 'text-amber-400'}`}>
                {isConnected ? <ShieldCheck className="w-4 h-4" /> : <ShieldAlert className="w-4 h-4" />}
                {isConnected ? 'Fully Authenticated' : 'Captive Portal Restricted'}
              </span>
            </div>
            {isConnected && (
              <>
                <div className="flex justify-between text-sm">
                  <span className="text-slate-400">Active Voucher:</span>
                  <span className="font-mono text-cyan-400 font-bold bg-cyan-950/50 px-2 py-0.5 rounded border border-cyan-800 text-xs">
                    {activeVoucherCode}
                  </span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-slate-400">Assigned IP Address:</span>
                  <span className="text-slate-200 font-mono text-xs">10.150.1.144</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-slate-400">Download Tier:</span>
                  <span className="text-violet-300 font-medium">Symmetrical Burst Cap</span>
                </div>
              </>
            )}
            {!isConnected && (
              <p className="text-xs text-slate-400 italic">
                💡 Enter a prepaid voucher token code below or purchase an instant high-speed micro-bundle to unlock full broad-spectrum internet coverage.
              </p>
            )}
          </div>

          {/* Connect / Authenticate Form */}
          {!isConnected ? (
            <form onSubmit={handleConnect} className="space-y-4 pt-2">
              <div>
                <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
                  Enter Hotspot Voucher Code
                </label>
                <div className="relative">
                  <Ticket className="absolute left-3.5 top-1/2 transform -translate-y-1/2 text-slate-500 w-5 h-5" />
                  <input
                    type="text"
                    value={inputCode}
                    onChange={(e) => setInputCode(e.target.value.toUpperCase())}
                    placeholder="e.g. FAIBA-872A"
                    className="w-full bg-slate-950 border border-slate-700 rounded-xl py-3 pl-11 pr-4 text-white placeholder-slate-500 font-mono tracking-widest focus:outline-none focus:border-violet-500 transition-colors"
                  />
                </div>
              </div>

              {authError && (
                <div className="p-3 bg-rose-950/40 border border-rose-800 text-rose-300 rounded-xl text-xs font-medium">
                  ⚠️ {authError}
                </div>
              )}

              {authSuccess && (
                <div className="p-3 bg-emerald-950/40 border border-emerald-800 text-emerald-300 rounded-xl text-xs font-medium">
                  🎉 {authSuccess}
                </div>
              )}

              <button
                type="submit"
                className="w-full bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 text-white font-semibold py-3 px-4 rounded-xl shadow-lg transition-all active:scale-[0.98] flex items-center justify-center gap-2"
              >
                <Zap className="w-4 h-4 fill-current" />
                Activate & Start Browsing
              </button>
            </form>
          ) : (
            <div className="pt-2">
              <button
                type="button"
                onClick={onDisconnect}
                className="w-full bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 font-semibold py-2.5 px-4 rounded-xl transition-all active:scale-[0.98]"
              >
                Disconnect This Session
              </button>
            </div>
          )}
        </div>

        {/* Hints or active voucher lookup panel */}
        <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-4">
          <h4 className="text-xs font-bold tracking-wider text-slate-400 uppercase mb-2 flex items-center justify-between">
            <span>Pre-loaded System Test Vouchers</span>
            <span className="text-[10px] text-violet-400 font-normal">Ready for simulation</span>
          </h4>
          <p className="text-xs text-slate-400 mb-3">
            Copy any of these sample codes or buy a custom one to verify the billing engine database sync:
          </p>
          <div className="space-y-2">
            {vouchers.filter(v => v.status === 'Unused').slice(0, 3).map((v, i) => (
              <div key={i} className="flex justify-between items-center text-xs bg-slate-950 p-2 rounded border border-slate-800/80 font-mono">
                <span className="text-cyan-400 font-bold">{v.code}</span>
                <span className="text-slate-400 text-[11px]">{v.planName} • {v.duration}</span>
                <button
                  onClick={() => {
                    setInputCode(v.code);
                    setAuthError(null);
                  }}
                  className="text-[10px] text-violet-400 hover:underline px-1"
                >
                  Apply
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Buy Voucher Online Dynamic Counter Store */}
      <div className="lg:col-span-7 space-y-6">
        <div className="bg-white rounded-3xl border border-slate-200 shadow-xl p-6">
          <div className="mb-4">
            <h2 className="text-xl font-extrabold text-slate-900 tracking-tight flex items-center gap-2">
              <Layers className="w-5 h-5 text-violet-600" />
              Instant Hotspot Pass Dispenser
            </h2>
            <p className="text-sm text-slate-500">
              No subscription required. Choose high-speed airtime packets with automated instantaneous wireless delivery.
            </p>
          </div>

          <form onSubmit={handleBuy} className="space-y-6">
            {/* Step 1: Packages list */}
            <div>
              <label className="block text-xs font-bold text-slate-600 uppercase tracking-wider mb-2.5">
                Step 1: Select Internet Package
              </label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {hotspotPlans.map((plan) => (
                  <label
                    key={plan.id}
                    onClick={() => setSelectedPlanId(plan.id)}
                    className={`relative p-4 rounded-2xl border-2 cursor-pointer transition-all flex flex-col justify-between ${
                      selectedPlanId === plan.id
                        ? 'border-violet-600 bg-violet-50/70 shadow-sm'
                        : 'border-slate-200 hover:border-slate-300 bg-white'
                    }`}
                  >
                    {plan.popular && (
                      <span className="absolute top-0 right-4 transform -translate-y-1/2 bg-violet-600 text-white font-extrabold text-[9px] px-2 py-0.5 rounded-full uppercase tracking-wider">
                        Best Value
                      </span>
                    )}
                    <div>
                      <div className="flex justify-between items-start">
                        <span className="font-bold text-slate-900 text-base">{plan.name}</span>
                        <span className="font-extrabold text-violet-600 text-lg">{plan.price.toLocaleString()} BOB</span>
                      </div>
                      <div className="text-xs text-slate-500 mt-1 flex items-center gap-1 font-mono">
                        <span>⌛ Duration: <strong>{plan.duration}</strong></span>
                      </div>
                    </div>
                    <div className="mt-3 pt-2 border-t border-dashed border-slate-200 flex justify-between items-center text-xs text-slate-600">
                      <span className="bg-slate-100 px-1.5 py-0.5 rounded text-[11px] font-medium text-slate-700">🚀 High Speed Internet</span>
                      <div className="flex items-center gap-2">
                        <span className="text-slate-400 text-[11px]">{plan.dataLimit}</span>
                        {plan.sharedUsers === 1 && (
                          <span className="bg-amber-100 text-amber-800 px-1.5 py-0.5 rounded text-[10px] font-bold">📱 1 Device</span>
                        )}
                        {plan.sharedUsers > 1 && (
                          <span className="bg-blue-50 text-blue-700 px-1.5 py-0.5 rounded text-[10px] font-medium">📱 {plan.sharedUsers} Devices</span>
                        )}
                      </div>
                    </div>
                  </label>
                ))}
              </div>
            </div>

            {/* Step 2: Payment */}
            <div>
              <label className="block text-xs font-bold text-slate-600 uppercase tracking-wider mb-2.5">
                Step 2: Send Payment via M-Pesa
              </label>

              {/* Payment Number Highlight Box */}
              <div className="bg-gradient-to-br from-emerald-50 to-teal-50 border-2 border-emerald-300 rounded-2xl p-4 space-y-3">
                <div className="flex items-center gap-2 text-emerald-800">
                  <Smartphone className="w-5 h-5 text-emerald-600" />
                  <span className="font-bold text-sm">M-Pesa Payment</span>
                </div>

                <div className="bg-white rounded-xl p-3 border border-emerald-200 text-center">
                  <span className="text-[10px] text-slate-400 block uppercase font-mono tracking-widest mb-1">Send to this Number</span>
                  <div className="flex items-center justify-center gap-2 flex-wrap">
                    <span className="text-2xl font-black text-emerald-700 font-mono tracking-wider block">0724167975</span>
                    <CopyTextButton
                      value="0724167975"
                      label="Copy"
                      className="inline-flex items-center gap-1 rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[11px] font-bold text-emerald-700 transition-colors hover:bg-emerald-100"
                    />
                  </div>
                  <span className="text-[11px] text-slate-500 block mt-1">Ultrafaiba Internet Services</span>
                </div>

                <div className="bg-emerald-100/60 rounded-xl p-3 border border-emerald-200 space-y-1.5">
                  <p className="text-xs text-emerald-800 font-semibold">📋 How to Pay:</p>
                  <ol className="text-[11px] text-emerald-700 space-y-1 list-decimal list-inside leading-relaxed">
                    <li>Go to <strong>M-Pesa</strong> → <strong>Send Money</strong></li>
                    <li>Enter number: <strong className="font-mono">0724167975</strong></li>
                    <li>Enter the amount for your selected package</li>
                    <li>Enter your M-Pesa PIN and confirm</li>
                    <li>You will receive your voucher code via SMS</li>
                  </ol>
                </div>

                <div>
                  <label className="block text-xs text-slate-500 font-medium mb-1">Your M-Pesa Phone Number (for confirmation):</label>
                  <input
                    type="tel"
                    value={phoneNumber}
                    onChange={(e) => setPhoneNumber(e.target.value)}
                    placeholder="e.g. 0712345678"
                    className="w-full text-sm bg-white border border-slate-300 rounded-lg p-2.5 font-mono"
                  />
                </div>
              </div>
            </div>

            {/* Submit Button */}
            <div>
              <button
                type="submit"
                disabled={loading}
                className="w-full bg-slate-900 hover:bg-slate-800 text-white font-bold py-3 px-4 rounded-xl shadow transition-all disabled:opacity-60 flex items-center justify-center gap-2"
              >
                {loading ? (
                  <>
                    <RefreshCw className="w-4 h-4 animate-spin text-violet-400" />
                    Querying Router Gateway & Triggering Billing...
                  </>
                ) : (
                  <>
                    <span>Generate Active Voucher for</span>
                    <span className="underline">{activePlanDetails?.price.toLocaleString()} BOB</span>
                  </>
                )}
              </button>
            </div>
          </form>

          {/* Success Result Container */}
          {recentGeneratedCode && (
            <div className="mt-5 p-4 bg-emerald-50 border-2 border-emerald-300 rounded-2xl">
              <div className="flex items-start gap-3">
                <CheckCircle className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" />
                <div className="space-y-1 w-full">
                  <h4 className="font-bold text-emerald-900 text-sm">Voucher Dispensed Successfully!</h4>
                  <p className="text-xs text-emerald-700">
                    Your automated billing request went through. The high-speed router credential voucher has been registered on the server database.
                  </p>
                  
                  <div className="mt-3 flex flex-col sm:flex-row gap-3 items-center justify-between bg-white p-3 rounded-xl border border-emerald-200">
                    <div>
                      <span className="text-[10px] text-slate-400 block uppercase font-mono">YOUR VOUCHER CODE</span>
                      <span className="text-xl font-mono font-black text-violet-700 tracking-wider selection:bg-yellow-200">
                        {recentGeneratedCode}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setInputCode(recentGeneratedCode);
                        setAuthError(null);
                        // Optional scroll up or prompt connect
                        onActivateVoucher(recentGeneratedCode);
                      }}
                      className="w-full sm:w-auto bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs py-2 px-3.5 rounded-lg transition-all shadow-sm"
                    >
                      🚀 Instant One-Click Connect
                    </button>
                  </div>
                  <p className="text-[11px] text-slate-400 italic pt-1 text-center sm:text-left">
                    💡 This code has been pre-filled into the active network prompt input on the left column.
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

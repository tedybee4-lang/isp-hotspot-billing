import { useState } from 'react';
import { Wifi, Zap, Shield, Globe, Clock, Users, ChevronDown, ChevronUp, Star, ArrowRight, Check, Play, Headphones, Smartphone } from 'lucide-react';
import { HotspotPlan } from '../data/mockData';
import CopyTextButton from './CopyTextButton';

interface LandingPageProps {
  plans: HotspotPlan[];
  onNavigate: (view: 'hotspot' | 'billing' | 'admin') => void;
  onQuickConnect: (code: string) => void;
  darkMode: boolean;
}

const TESTIMONIALS = [
  {
    name: 'Sarah Kimani',
    role: 'Remote Software Developer',
    avatar: 'https://images.pexels.com/photos/30087070/pexels-photo-30087070.jpeg?auto=compress&cs=tinysrgb&dpr=2&h=650&w=940',
    quote: 'Ultrafaiba changed my work-from-home experience completely. I stream 4K, run Zoom calls, and push Docker containers simultaneously without a single hiccup.',
    rating: 5,
    plan: 'Home Fiber Gold'
  },
  {
    name: 'David Ochieng',
    role: 'Gaming & Content Creator',
    avatar: 'https://images.pexels.com/photos/20819787/pexels-photo-20819787.jpeg?auto=compress&cs=tinysrgb&dpr=2&h=650&w=940',
    quote: 'My ping dropped from 80ms to 4ms after switching. Live streaming on Twitch has never been smoother. The hotspot voucher system is genius for my gaming cafe.',
    rating: 5,
    plan: 'Home Fiber Silver'
  },
  {
    name: 'Amira Hassan',
    role: 'Cafe Owner & Entrepreneur',
    avatar: 'https://images.pexels.com/photos/7793740/pexels-photo-7793740.jpeg?auto=compress&cs=tinysrgb&dpr=2&h=650&w=940',
    quote: 'I set up Ultrafaiba hotspot in my cafe and customers love the instant voucher codes. The admin panel lets me monitor everything from my phone. Revenue went up 30%!',
    rating: 5,
    plan: 'Business Hotspot'
  }
];

const FAQS = [
  {
    q: 'How fast can I get connected after purchasing a voucher?',
    a: 'Instantly! Once you purchase a voucher code through our portal, the Radius server authenticates your device within 2 seconds. There is zero waiting time — your bandwidth profile activates the moment you enter the code.'
  },
  {
    q: 'What areas does Ultrafaiba cover?',
    a: 'We currently operate 5 major distribution nodes with wide coverage across the region. We are continuously expanding our network to bring high-speed fiber to more areas. Contact us at 0724167975 to check availability in your area.'
  },
  {
    q: 'Can I upgrade my fiber plan mid-cycle?',
    a: 'Absolutely. Plan upgrades are instant and pro-rated. Navigate to the Subscriber Billing portal, click "Change / Upgrade Fiber Speed Profile," and select your new tier. Your router provisions adjust in real-time.'
  },
  {
    q: 'Do you throttle speeds or impose fair usage caps?',
    a: 'No. Ultrafaiba operates a truly unlimited policy. We do not shape, throttle, or deprioritize any traffic type. Your subscribed speed is your guaranteed minimum at all times, regardless of download volume.'
  },
  {
    q: 'What payment methods do you accept?',
    a: 'We accept M-Pesa payments. Simply send money to 0724167975 (Ultrafaiba Internet Services) with the exact amount for your chosen plan. Your voucher or subscription will be activated automatically once payment is confirmed.'
  },
  {
    q: 'What happens if my fiber line goes down?',
    a: 'Log a support ticket directly from the Subscriber Portal. Our NOC engineers monitor all fiber terminals 24/7 and dispatch field technicians within 2 hours for Priority High tickets. We maintain a 99.98% uptime SLA.'
  }
];

const STATS = [
  { label: 'Active Subscribers', value: '12,400+', icon: Users },
  { label: 'Network Uptime SLA', value: '99.98%', icon: Shield },
  { label: 'Avg. Latency', value: '4ms', icon: Zap },
  { label: 'Coverage Nodes', value: '5 Active', icon: Globe },
];

export default function LandingPage({ plans, onNavigate, onQuickConnect, darkMode }: LandingPageProps) {
  const [openFaq, setOpenFaq] = useState<number | null>(null);
  const [billingCycle, setBillingCycle] = useState<'hotspot' | 'fiber'>('fiber');
  const [quickCode, setQuickCode] = useState('');

  const filteredPlans = plans.filter(p => p.type === billingCycle);

  return (
    <div className="space-y-0">
      {/* ═══════════ HERO SECTION ═══════════ */}
      <section className="relative overflow-hidden rounded-3xl">
        <div className="absolute inset-0 bg-gradient-to-br from-slate-950 via-violet-950 to-indigo-950"></div>
        <div className="absolute inset-0 opacity-25" style={{
          backgroundImage: `url('/images/hero-fiber.jpg')`,
          backgroundSize: 'cover',
          backgroundPosition: 'center',
          mixBlendMode: 'luminosity'
        }}></div>
        {/* Animated gradient orbs */}
        <div className="absolute top-10 left-10 w-72 h-72 bg-violet-600/20 rounded-full blur-3xl animate-pulse"></div>
        <div className="absolute bottom-10 right-10 w-96 h-96 bg-cyan-500/15 rounded-full blur-3xl animate-pulse" style={{ animationDelay: '1s' }}></div>

        <div className="relative z-10 px-6 py-16 md:py-24 lg:py-32 text-center max-w-4xl mx-auto">
          <div className="inline-flex items-center gap-2 bg-white/10 backdrop-blur-md border border-white/20 rounded-full px-4 py-1.5 mb-6">
            <span className="w-2 h-2 bg-emerald-400 rounded-full animate-ping"></span>
            <span className="text-xs text-white/80 font-mono tracking-wider">FIBER NETWORK LIVE • ALL NODES OPERATIONAL</span>
          </div>

          <h1 className="text-4xl sm:text-5xl md:text-6xl lg:text-7xl font-black text-white tracking-tight leading-[1.1] mb-6">
            Blazing Fast Internet
            <br />
            <span className="bg-gradient-to-r from-cyan-400 via-violet-400 to-indigo-400 bg-clip-text text-transparent">
              Zero Compromises
            </span>
          </h1>

          <p className="text-base sm:text-lg text-slate-300 max-w-2xl mx-auto mb-8 leading-relaxed">
            Ultrafaiba delivers pure fiber-optic internet with symmetrical speeds up to 100 Mbps, 
            4ms latency, and truly unlimited data. No throttling. No caps. Just blazing connectivity.
          </p>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-3 mb-12">
            <button
              onClick={() => onNavigate('hotspot')}
              className="w-full sm:w-auto bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 text-white font-bold py-3.5 px-8 rounded-xl shadow-lg shadow-violet-900/40 transition-all active:scale-[0.97] flex items-center justify-center gap-2 text-sm"
            >
              <Wifi className="w-5 h-5" />
              Connect to Hotspot
              <ArrowRight className="w-4 h-4" />
            </button>
            <button
              onClick={() => onNavigate('billing')}
              className="w-full sm:w-auto bg-white/10 hover:bg-white/20 backdrop-blur-md text-white font-bold py-3.5 px-8 rounded-xl border border-white/20 transition-all flex items-center justify-center gap-2 text-sm"
            >
              <Play className="w-4 h-4 fill-current" />
              View Subscriber Portal
            </button>
          </div>

          {/* Quick Connect Bar */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (quickCode.trim()) {
                onQuickConnect(quickCode);
              }
            }}
            className="mx-auto mb-12 w-full max-w-2xl"
          >
            <div className="rounded-2xl border border-white/15 bg-white/10 backdrop-blur-md p-2.5 shadow-xl shadow-black/10">
              <div className="flex flex-col sm:flex-row gap-2">
                <div className="flex-1">
                  <label className="sr-only" htmlFor="quick-connect-code">Voucher code</label>
                  <input
                    id="quick-connect-code"
                    value={quickCode}
                    onChange={(e) => setQuickCode(e.target.value.toUpperCase())}
                    placeholder="Type voucher code or account number"
                    className="w-full rounded-xl border border-white/10 bg-slate-950/80 px-4 py-3 text-sm font-mono tracking-wider text-white placeholder:text-slate-500 outline-none focus:border-cyan-400"
                  />
                </div>
                <button
                  type="submit"
                  className="rounded-xl bg-white px-5 py-3 text-sm font-bold text-violet-700 transition-colors hover:bg-cyan-50"
                >
                  Connect Instantly
                </button>
              </div>
              <p className="mt-2 text-left text-[11px] text-white/65">
                Fastest way to connect: enter your voucher and jump straight to the hotspot login portal.
              </p>
            </div>
          </form>

          {/* Trust Stats Row */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 max-w-3xl mx-auto">
            {STATS.map((stat, i) => (
              <div key={i} className="bg-white/5 backdrop-blur-md border border-white/10 rounded-2xl p-4 text-center">
                <stat.icon className="w-5 h-5 text-cyan-400 mx-auto mb-1" />
                <div className="text-2xl font-black text-white font-mono">{stat.value}</div>
                <div className="text-[11px] text-slate-400 font-medium">{stat.label}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ═══════════ FEATURES GRID ═══════════ */}
      <section className="py-16 md:py-20">
        <div className="text-center mb-12">
          <span className="text-xs font-bold text-violet-600 uppercase tracking-widest font-mono">Why Choose Ultrafaiba</span>
          <h2 className={`text-3xl md:text-4xl font-black tracking-tight mt-2 ${darkMode ? 'text-white' : 'text-slate-900'}`}>
            Built for Speed. Designed for Everyone.
          </h2>
          <p className={`text-sm max-w-xl mx-auto mt-3 ${darkMode ? 'text-slate-400' : 'text-slate-500'}`}>
            From casual browsing to enterprise-grade cloud computing, our infrastructure adapts to your needs.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {[
            { icon: Zap, color: 'from-amber-500 to-orange-600', bg: 'bg-amber-50', title: 'Ultra-Low Latency', desc: 'Sub-5ms ping to our core servers. Perfect for competitive gaming, VoIP calls, and real-time trading platforms.' },
            { icon: Shield, color: 'from-emerald-500 to-teal-600', bg: 'bg-emerald-50', title: 'DDoS Protection', desc: 'Enterprise-grade firewall with automated threat detection. Your connection is protected by multi-layered security protocols.' },
            { icon: Globe, color: 'from-blue-500 to-indigo-600', bg: 'bg-blue-50', title: 'Global Peering', desc: 'Direct peering with Netflix, Google, AWS, and 200+ CDN networks for the fastest possible content delivery.' },
            { icon: Clock, color: 'from-violet-500 to-purple-600', bg: 'bg-violet-50', title: 'Instant Activation', desc: 'Buy a voucher, enter the code, and you are online in under 3 seconds. No waiting, no contracts, no installation delays.' },
            { icon: Headphones, color: 'from-rose-500 to-pink-600', bg: 'bg-rose-50', title: '24/7 NOC Support', desc: 'Our Network Operations Center never sleeps. Log tickets, get real-time diagnostics, and reach engineers any time of day.' },
            { icon: Smartphone, color: 'from-cyan-500 to-sky-600', bg: 'bg-cyan-50', title: 'Easy M-Pesa Payments', desc: 'Pay instantly via M-Pesa to 0724167975. Your internet access activates automatically once payment is confirmed. No hassle, no delays.' },
          ].map((feat, i) => (
            <div key={i} className={`group p-6 rounded-2xl border transition-all hover:shadow-lg hover:-translate-y-1 ${darkMode ? 'bg-slate-800/60 border-slate-700 hover:border-violet-600' : 'bg-white border-slate-200 hover:border-violet-300'}`}>
              <div className={`inline-flex p-3 rounded-xl bg-gradient-to-br ${feat.color} text-white mb-4 shadow-md group-hover:scale-110 transition-transform`}>
                <feat.icon className="w-5 h-5" />
              </div>
              <h3 className={`font-bold text-base mb-2 ${darkMode ? 'text-white' : 'text-slate-900'}`}>{feat.title}</h3>
              <p className={`text-xs leading-relaxed ${darkMode ? 'text-slate-400' : 'text-slate-500'}`}>{feat.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ═══════════ PRICING SECTION ═══════════ */}
      <section className={`py-16 md:py-20 rounded-3xl px-6 md:px-10 ${darkMode ? 'bg-slate-800/40' : 'bg-gradient-to-br from-violet-50 via-indigo-50 to-slate-50'}`}>
        <div className="text-center mb-10">
          <span className="text-xs font-bold text-violet-600 uppercase tracking-widest font-mono">Transparent Pricing</span>
          <h2 className={`text-3xl md:text-4xl font-black tracking-tight mt-2 ${darkMode ? 'text-white' : 'text-slate-900'}`}>
            Simple Plans. Powerful Speeds.
          </h2>
          <p className={`text-sm max-w-lg mx-auto mt-3 ${darkMode ? 'text-slate-400' : 'text-slate-500'}`}>
            Whether you need a quick hotspot pass or dedicated home fiber, we have the perfect plan for you.
          </p>

          {/* Toggle */}
          <div className={`inline-flex items-center p-1 rounded-xl mt-6 ${darkMode ? 'bg-slate-900 border border-slate-700' : 'bg-white border border-slate-200'} shadow-sm`}>
            <button
              onClick={() => setBillingCycle('hotspot')}
              className={`px-5 py-2 rounded-lg text-xs font-bold transition-all ${
                billingCycle === 'hotspot' ? 'bg-violet-600 text-white shadow-sm' : darkMode ? 'text-slate-400' : 'text-slate-500'
              }`}
            >
              ⚡ Hotspot Passes
            </button>
            <button
              onClick={() => setBillingCycle('fiber')}
              className={`px-5 py-2 rounded-lg text-xs font-bold transition-all ${
                billingCycle === 'fiber' ? 'bg-violet-600 text-white shadow-sm' : darkMode ? 'text-slate-400' : 'text-slate-500'
              }`}
            >
              🏠 Home Fiber Plans
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5 max-w-5xl mx-auto">
          {filteredPlans.map((plan) => (
            <div
              key={plan.id}
              className={`relative p-6 rounded-2xl border-2 flex flex-col justify-between transition-all hover:shadow-xl hover:-translate-y-1 ${
                plan.popular
                  ? 'border-violet-600 shadow-lg shadow-violet-100 ' + (darkMode ? 'bg-slate-800' : 'bg-white')
                  : darkMode ? 'border-slate-700 bg-slate-800/80' : 'border-slate-200 bg-white'
              }`}
            >
              {plan.popular && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2 bg-gradient-to-r from-violet-600 to-indigo-600 text-white text-[10px] font-extrabold px-3 py-1 rounded-full uppercase tracking-wider shadow-md">
                  ⭐ Most Popular
                </div>
              )}

              <div>
                <h3 className={`font-bold text-sm ${darkMode ? 'text-white' : 'text-slate-900'}`}>{plan.name}</h3>
                <div className="mt-3 mb-4">
                  <span className={`text-3xl font-black ${plan.popular ? 'text-violet-600' : darkMode ? 'text-white' : 'text-slate-900'}`}>
                    {plan.price.toLocaleString()}
                  </span>
                  <span className={`text-xs ml-1 ${darkMode ? 'text-slate-400' : 'text-slate-500'}`}>BOB / {plan.duration}</span>
                </div>

                <ul className="space-y-2 mb-6">
                  {[
                    `Data: ${plan.dataLimit}`,
                    `Duration: ${plan.duration}`,
                    'High Speed Internet',
                    plan.sharedUsers === 1 ? '1 Device per voucher' : `Up to ${plan.sharedUsers} devices`,
                    'No contracts required',
                    '24/7 Support access'
                  ].map((item, idx) => (
                    <li key={idx} className={`flex items-center gap-2 text-xs ${darkMode ? 'text-slate-300' : 'text-slate-600'}`}>
                      <Check className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                      {item}
                    </li>
                  ))}
                </ul>
              </div>

              <button
                onClick={() => onNavigate('hotspot')}
                className={`w-full py-2.5 rounded-xl text-xs font-bold transition-all ${
                  plan.popular
                    ? 'bg-gradient-to-r from-violet-600 to-indigo-600 text-white shadow-md hover:shadow-lg active:scale-[0.97]'
                    : darkMode ? 'bg-slate-700 text-white hover:bg-slate-600' : 'bg-slate-100 text-slate-800 hover:bg-slate-200'
                }`}
              >
                Get Started →
              </button>
            </div>
          ))}
        </div>
      </section>

      {/* ═══════════ TESTIMONIALS ═══════════ */}
      <section className="py-16 md:py-20">
        <div className="text-center mb-12">
          <span className="text-xs font-bold text-violet-600 uppercase tracking-widest font-mono">Customer Stories</span>
          <h2 className={`text-3xl md:text-4xl font-black tracking-tight mt-2 ${darkMode ? 'text-white' : 'text-slate-900'}`}>
            Loved by Thousands
          </h2>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {TESTIMONIALS.map((t, i) => (
            <div key={i} className={`p-6 rounded-2xl border transition-all hover:shadow-lg ${darkMode ? 'bg-slate-800/60 border-slate-700' : 'bg-white border-slate-200'}`}>
              <div className="flex items-center gap-1 mb-3">
                {Array.from({ length: t.rating }).map((_, si) => (
                  <Star key={si} className="w-4 h-4 text-amber-400 fill-amber-400" />
                ))}
              </div>
              <p className={`text-sm leading-relaxed mb-5 italic ${darkMode ? 'text-slate-300' : 'text-slate-600'}`}>
                "{t.quote}"
              </p>
              <div className="flex items-center gap-3 pt-4 border-t border-dashed border-slate-200">
                <img
                  src={t.avatar}
                  alt={t.name}
                  className="w-10 h-10 rounded-full object-cover ring-2 ring-violet-200"
                />
                <div>
                  <div className={`font-bold text-sm ${darkMode ? 'text-white' : 'text-slate-900'}`}>{t.name}</div>
                  <div className={`text-[11px] ${darkMode ? 'text-slate-400' : 'text-slate-500'}`}>{t.role} • {t.plan}</div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ═══════════ FAQ ACCORDION ═══════════ */}
      <section className={`py-16 md:py-20 rounded-3xl px-6 md:px-10 ${darkMode ? 'bg-slate-800/40' : 'bg-slate-50'}`}>
        <div className="text-center mb-10">
          <span className="text-xs font-bold text-violet-600 uppercase tracking-widest font-mono">FAQ</span>
          <h2 className={`text-3xl md:text-4xl font-black tracking-tight mt-2 ${darkMode ? 'text-white' : 'text-slate-900'}`}>
            Frequently Asked Questions
          </h2>
        </div>

        <div className="max-w-2xl mx-auto space-y-3">
          {FAQS.map((faq, i) => (
            <div
              key={i}
              className={`rounded-2xl border overflow-hidden transition-all ${
                darkMode
                  ? openFaq === i ? 'bg-slate-800 border-violet-600' : 'bg-slate-800/60 border-slate-700'
                  : openFaq === i ? 'bg-white border-violet-300 shadow-sm' : 'bg-white border-slate-200'
              }`}
            >
              <button
                onClick={() => setOpenFaq(openFaq === i ? null : i)}
                className="w-full p-4 flex justify-between items-center text-left"
              >
                <span className={`font-bold text-sm pr-4 ${darkMode ? 'text-white' : 'text-slate-900'}`}>{faq.q}</span>
                {openFaq === i ? (
                  <ChevronUp className="w-4 h-4 text-violet-500 shrink-0" />
                ) : (
                  <ChevronDown className={`w-4 h-4 shrink-0 ${darkMode ? 'text-slate-400' : 'text-slate-400'}`} />
                )}
              </button>
              {openFaq === i && (
                <div className={`px-4 pb-4 text-xs leading-relaxed ${darkMode ? 'text-slate-300' : 'text-slate-600'}`}>
                  {faq.a}
                </div>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* ═══════════ CTA BANNER ═══════════ */}
      <section className="relative py-16 md:py-20 rounded-3xl overflow-hidden mt-8">
        <div className="absolute inset-0 bg-gradient-to-r from-violet-600 via-indigo-600 to-cyan-600"></div>
        <div className="absolute inset-0 opacity-10" style={{
          backgroundImage: 'radial-gradient(circle at 20% 80%, white 1px, transparent 1px), radial-gradient(circle at 80% 20%, white 1px, transparent 1px)',
          backgroundSize: '40px 40px'
        }}></div>
        <div className="relative z-10 text-center px-6">
          <h2 className="text-3xl md:text-4xl font-black text-white tracking-tight mb-4">
            Ready for Lightning-Fast Internet?
          </h2>
          <p className="text-sm text-white/80 max-w-lg mx-auto mb-6">
            Join 12,400+ subscribers who already enjoy Ultrafaiba's premium fiber network. Get connected in under 60 seconds.
          </p>

          {/* M-Pesa Payment CTA */}
          <div className="inline-flex items-center gap-3 bg-white/10 backdrop-blur-md border border-white/20 rounded-2xl px-5 py-3 mb-8">
            <div className="text-left">
              <span className="text-[10px] text-white/60 uppercase font-mono tracking-widest block">Pay via M-Pesa</span>
              <div className="flex items-center gap-2">
                <span className="text-xl font-black text-white font-mono tracking-wider">0724167975</span>
                <CopyTextButton
                  value="0724167975"
                  label="Copy"
                  className="inline-flex items-center gap-1 rounded-lg border border-white/20 bg-white/10 px-2.5 py-1 text-[11px] font-bold text-white transition-colors hover:bg-white/20"
                />
              </div>
            </div>
            <div className="w-px h-8 bg-white/20"></div>
            <span className="text-xs text-white/70">Send money to get<br/>instant internet access</span>
          </div>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
            <button
              onClick={() => onNavigate('hotspot')}
              className="bg-white text-violet-700 font-bold py-3 px-8 rounded-xl shadow-lg hover:shadow-xl transition-all active:scale-[0.97] text-sm flex items-center gap-2"
            >
              <Wifi className="w-4 h-4" />
              Get Connected Now
            </button>
            <button
              onClick={() => onNavigate('billing')}
              className="bg-white/10 backdrop-blur-md text-white font-bold py-3 px-8 rounded-xl border border-white/30 hover:bg-white/20 transition-all text-sm"
            >
              View My Account
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

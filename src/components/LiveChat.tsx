import { useState, useRef, useEffect } from 'react';
import { MessageCircle, X, Send, Bot, User } from 'lucide-react';

interface Message {
  sender: 'user' | 'bot';
  text: string;
  time: string;
}

const BOT_RESPONSES: Record<string, string> = {
  'default': "Thank you for reaching out! I'm the Ultrafaiba support assistant. I can help with billing questions, connection issues, and plan upgrades. How can I assist you today?",
  'speed': "If you're experiencing slowdowns, try: 1) Restart your router 2) Run a speed test from our portal 3) If issues persist, I'll escalate to our NOC team right away.",
  'billing': "For billing inquiries, you can view all your invoices from the Subscriber Billing tab. To pay, send money via M-Pesa to 0724167975 (Ultrafaiba Internet). Your account activates automatically!",
  'plan': "We offer: Home Fiber Starter (1,000 BOB/mo), Standard (1,500 BOB/mo), Premium (2,000 BOB/mo), and Ultra (2,500 BOB/mo). All plans include truly unlimited data. Pay via M-Pesa to 0724167975!",
  'voucher': "Hotspot vouchers: Ultra Lite (2 Hours - 15 BOB, 1 device), Daily Super (10 Hours - 30 BOB, 1 device), Daily Max (24 Hours - 40 BOB, 1 device), Weekpass (7 Days - 245 BOB, 3 devices). Send payment to 0724167975 via M-Pesa!",
  'down': "I'm sorry to hear about connectivity issues. Our automated monitoring shows most nodes are operational. Try power-cycling your router (unplug for 30 seconds). If the issue continues, call us at 0724167975.",
  'price': "Our pricing: Hotspot from 15 BOB (2 hours) and home fiber from 1,000 BOB/month. All plans include unlimited data and 24/7 support. Pay via M-Pesa to 0724167975!",
};

function getBotResponse(userMessage: string): string {
  const lower = userMessage.toLowerCase();
  if (lower.includes('speed') || lower.includes('slow') || lower.includes('fast') || lower.includes('mbps')) return BOT_RESPONSES['speed'];
  if (lower.includes('bill') || lower.includes('invoice') || lower.includes('pay') || lower.includes('charge')) return BOT_RESPONSES['billing'];
  if (lower.includes('plan') || lower.includes('upgrade') || lower.includes('change') || lower.includes('package')) return BOT_RESPONSES['plan'];
  if (lower.includes('voucher') || lower.includes('code') || lower.includes('hotspot') || lower.includes('wifi')) return BOT_RESPONSES['voucher'];
  if (lower.includes('down') || lower.includes('offline') || lower.includes('not working') || lower.includes('disconnect')) return BOT_RESPONSES['down'];
  if (lower.includes('price') || lower.includes('cost') || lower.includes('how much') || lower.includes('cheap')) return BOT_RESPONSES['price'];
  return BOT_RESPONSES['default'];
}

function getTimeNow(): string {
  const now = new Date();
  return now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export default function LiveChat({ darkMode }: { darkMode: boolean }) {
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([
    {
      sender: 'bot',
      text: "👋 Hi there! Welcome to Ultrafaiba Support. I'm your AI assistant. Ask me about plans, billing, speed issues, or anything else!",
      time: getTimeNow()
    }
  ]);
  const [inputValue, setInputValue] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputValue.trim()) return;

    const userMsg: Message = { sender: 'user', text: inputValue.trim(), time: getTimeNow() };
    setMessages(prev => [...prev, userMsg]);
    const userText = inputValue;
    setInputValue('');
    setIsTyping(true);

    setTimeout(() => {
      const botReply: Message = { sender: 'bot', text: getBotResponse(userText), time: getTimeNow() };
      setMessages(prev => [...prev, botReply]);
      setIsTyping(false);
    }, 800 + Math.random() * 700);
  };

  const quickActions = ['Speed issue', 'Billing help', 'Upgrade plan', 'Get voucher'];

  return (
    <>
      {/* Floating Button */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={`fixed bottom-6 right-6 z-50 p-4 rounded-full shadow-2xl transition-all hover:scale-110 active:scale-95 ${
          isOpen
            ? 'bg-slate-800 text-white'
            : 'bg-gradient-to-r from-violet-600 to-indigo-600 text-white shadow-violet-400/30'
        }`}
      >
        {isOpen ? <X className="w-6 h-6" /> : <MessageCircle className="w-6 h-6" />}
        {!isOpen && (
          <span className="absolute -top-1 -right-1 w-4 h-4 bg-emerald-400 rounded-full border-2 border-white animate-pulse"></span>
        )}
      </button>

      {/* Chat Window */}
      {isOpen && (
        <div className={`fixed bottom-24 right-6 z-50 w-[360px] max-w-[calc(100vw-2rem)] rounded-3xl shadow-2xl border overflow-hidden flex flex-col ${
          darkMode ? 'bg-slate-900 border-slate-700' : 'bg-white border-slate-200'
        }`} style={{ height: '500px' }}>
          {/* Chat Header */}
          <div className="bg-gradient-to-r from-violet-600 to-indigo-600 px-5 py-4 text-white">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-white/20 backdrop-blur-md rounded-xl flex items-center justify-center">
                <Bot className="w-5 h-5" />
              </div>
              <div>
                <h4 className="font-bold text-sm">Ultrafaiba Support</h4>
                <span className="text-[11px] text-white/70 flex items-center gap-1">
                  <span className="w-1.5 h-1.5 bg-emerald-400 rounded-full"></span>
                  Online • Avg. reply: &lt;30s
                </span>
              </div>
            </div>
          </div>

          {/* Messages Area */}
          <div className="flex-1 overflow-y-auto p-4 space-y-3" style={{ scrollBehavior: 'smooth' }}>
            {messages.map((msg, i) => (
              <div
                key={i}
                className={`flex items-end gap-2 ${msg.sender === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                {msg.sender === 'bot' && (
                  <div className="w-7 h-7 bg-gradient-to-tr from-violet-500 to-indigo-500 rounded-lg flex items-center justify-center shrink-0">
                    <Bot className="w-3.5 h-3.5 text-white" />
                  </div>
                )}
                <div className={`max-w-[75%] px-3.5 py-2.5 rounded-2xl text-xs leading-relaxed ${
                  msg.sender === 'user'
                    ? 'bg-violet-600 text-white rounded-br-md'
                    : darkMode ? 'bg-slate-800 text-slate-200 rounded-bl-md border border-slate-700' : 'bg-slate-100 text-slate-700 rounded-bl-md'
                }`}>
                  <p>{msg.text}</p>
                  <span className={`text-[9px] block mt-1 ${msg.sender === 'user' ? 'text-violet-200' : darkMode ? 'text-slate-500' : 'text-slate-400'}`}>
                    {msg.time}
                  </span>
                </div>
                {msg.sender === 'user' && (
                  <div className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${darkMode ? 'bg-slate-700' : 'bg-slate-200'}`}>
                    <User className={`w-3.5 h-3.5 ${darkMode ? 'text-slate-300' : 'text-slate-500'}`} />
                  </div>
                )}
              </div>
            ))}

            {isTyping && (
              <div className="flex items-end gap-2">
                <div className="w-7 h-7 bg-gradient-to-tr from-violet-500 to-indigo-500 rounded-lg flex items-center justify-center shrink-0">
                  <Bot className="w-3.5 h-3.5 text-white" />
                </div>
                <div className={`px-4 py-3 rounded-2xl rounded-bl-md ${darkMode ? 'bg-slate-800' : 'bg-slate-100'}`}>
                  <div className="flex gap-1">
                    <span className={`w-2 h-2 rounded-full animate-bounce ${darkMode ? 'bg-slate-500' : 'bg-slate-400'}`} style={{ animationDelay: '0ms' }}></span>
                    <span className={`w-2 h-2 rounded-full animate-bounce ${darkMode ? 'bg-slate-500' : 'bg-slate-400'}`} style={{ animationDelay: '150ms' }}></span>
                    <span className={`w-2 h-2 rounded-full animate-bounce ${darkMode ? 'bg-slate-500' : 'bg-slate-400'}`} style={{ animationDelay: '300ms' }}></span>
                  </div>
                </div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          {/* Quick Action Chips */}
          {messages.length <= 2 && (
            <div className={`px-4 py-2 flex flex-wrap gap-1.5 border-t ${darkMode ? 'border-slate-700' : 'border-slate-100'}`}>
              {quickActions.map((action, i) => (
                <button
                  key={i}
                  onClick={() => {
                    setInputValue(action);
                    const userMsg: Message = { sender: 'user', text: action, time: getTimeNow() };
                    setMessages(prev => [...prev, userMsg]);
                    setIsTyping(true);
                    setTimeout(() => {
                      const botReply: Message = { sender: 'bot', text: getBotResponse(action), time: getTimeNow() };
                      setMessages(prev => [...prev, botReply]);
                      setIsTyping(false);
                      setInputValue('');
                    }, 800);
                  }}
                  className={`px-3 py-1 rounded-full text-[11px] font-medium border transition-colors ${
                    darkMode ? 'bg-slate-800 border-slate-600 text-slate-300 hover:bg-slate-700' : 'bg-white border-slate-200 text-slate-600 hover:bg-violet-50 hover:border-violet-300'
                  }`}
                >
                  {action}
                </button>
              ))}
            </div>
          )}

          {/* Input Area */}
          <form onSubmit={handleSend} className={`p-3 border-t flex items-center gap-2 ${darkMode ? 'border-slate-700 bg-slate-900' : 'border-slate-200 bg-white'}`}>
            <input
              type="text"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              placeholder="Type your message..."
              className={`flex-1 text-xs py-2.5 px-4 rounded-xl border focus:outline-none focus:border-violet-500 transition-colors ${
                darkMode ? 'bg-slate-800 border-slate-600 text-white placeholder-slate-500' : 'bg-slate-50 border-slate-200 text-slate-800'
              }`}
            />
            <button
              type="submit"
              disabled={!inputValue.trim()}
              className="p-2.5 bg-violet-600 hover:bg-violet-700 text-white rounded-xl transition-colors disabled:opacity-40 shrink-0"
            >
              <Send className="w-4 h-4" />
            </button>
          </form>
        </div>
      )}
    </>
  );
}

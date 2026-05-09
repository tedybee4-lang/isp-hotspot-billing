import { Shield, FileText, CreditCard, Ban, Scale, Phone, ChevronDown, ChevronUp } from 'lucide-react';
import CopyTextButton from './CopyTextButton';
import { useState } from 'react';

interface TermsProps {
  darkMode: boolean;
  activeTab: 'terms' | 'privacy' | 'acceptable' | 'refund' | 'sla';
  onTabChange: (tab: 'terms' | 'privacy' | 'acceptable' | 'refund' | 'sla') => void;
}

const LAST_UPDATED = 'March 13, 2026';

export default function TermsAndConditions({ darkMode, activeTab, onTabChange }: TermsProps) {
  const [expandedSection, setExpandedSection] = useState<number | null>(0);

  const toggle = (idx: number) => {
    setExpandedSection(expandedSection === idx ? null : idx);
  };

  const tabs = [
    { key: 'terms' as const, label: 'Terms of Service', icon: FileText },
    { key: 'privacy' as const, label: 'Privacy Policy', icon: Shield },
    { key: 'acceptable' as const, label: 'Acceptable Use', icon: Ban },
    { key: 'refund' as const, label: 'Refund Policy', icon: CreditCard },
    { key: 'sla' as const, label: 'Service Level Agreement', icon: Scale },
  ];

  const sectionClass = `text-xs leading-relaxed ${darkMode ? 'text-slate-300' : 'text-slate-600'}`;
  const headingClass = `font-bold text-sm ${darkMode ? 'text-white' : 'text-slate-900'}`;


  // ─── TERMS OF SERVICE ───
  const termsOfService = [
    {
      title: '1. Introduction & Acceptance',
      content: `By accessing, browsing, or using any services provided by Ultrafaiba Internet Services ("Ultrafaiba", "we", "us", or "our"), including but not limited to hotspot voucher access, home fiber subscriptions, and any related digital services, you ("Customer", "User", "Subscriber", or "you") acknowledge that you have read, understood, and agree to be bound by these Terms of Service ("Terms"). If you do not agree to these Terms, you must immediately discontinue use of all Ultrafaiba services.\n\nThese Terms constitute a legally binding agreement between you and Ultrafaiba. We reserve the right to modify these Terms at any time without prior notice. Continued use of our services after any modifications constitutes your acceptance of the revised Terms. It is your responsibility to review these Terms periodically for updates.`
    },
    {
      title: '2. Service Description',
      content: `Ultrafaiba provides internet connectivity services through the following channels:\n\n• Hotspot Voucher Access: Prepaid internet access vouchers with defined time durations (2 hours, 10 hours, 24 hours, 7 days) that grant access to Ultrafaiba WiFi hotspot zones.\n\n• Home Fiber Subscriptions: Monthly recurring broadband internet service delivered via fiber-optic technology to residential and commercial premises.\n\n• All services are subject to network availability, technical capacity, and these Terms. Ultrafaiba does not guarantee uninterrupted or error-free service at all times. Scheduled maintenance, force majeure events, and unforeseen technical issues may temporarily affect service availability.`
    },
    {
      title: '3. Account Registration & Eligibility',
      content: `• You must be at least 18 years of age or have parental/guardian consent to use Ultrafaiba services.\n\n• You agree to provide accurate, current, and complete information during registration and to update such information to keep it accurate.\n\n• You are solely responsible for maintaining the confidentiality of your account credentials, voucher codes, and any activity that occurs under your account.\n\n• You must not share, resell, or redistribute voucher codes or account access without written authorization from Ultrafaiba.\n\n• Ultrafaiba reserves the right to suspend or terminate any account that we reasonably believe violates these Terms or is being used fraudulently.`
    },
    {
      title: '4. Payment Terms & Billing',
      content: `• All payments for Ultrafaiba services are made via M-Pesa to the designated payment number: 0724167975.\n\n• Hotspot voucher payments are one-time, prepaid transactions. The voucher activates upon first use and expires after the stated duration regardless of actual usage.\n\n• Home fiber subscriptions are billed on a monthly recurring basis. Payment is due on or before the 5th of each billing month.\n\n• Late payments may result in service suspension. A reconnection fee may apply to restore suspended services.\n\n• All prices are quoted in BOB (Boliviano) and are inclusive of applicable taxes unless otherwise stated.\n\n• Ultrafaiba reserves the right to adjust pricing with 30 days written notice to subscribers. Continued use after a price change constitutes acceptance of the new pricing.\n\n• Payment confirmation is sent via SMS to the M-Pesa registered phone number. Retain your M-Pesa confirmation message as proof of payment.`
    },
    {
      title: '5. Voucher Terms & Activation',
      content: `• Each hotspot voucher code is unique and can only be activated once on a single device at a time.\n\n• Voucher validity period begins from the moment of first authentication (first login), NOT from the time of purchase.\n\n• Unused vouchers remain valid indefinitely until first activation. Once activated, the countdown timer begins and cannot be paused, extended, or transferred.\n\n• Lost, stolen, or compromised voucher codes will not be replaced or refunded. It is your responsibility to safeguard your voucher codes.\n\n• Ultrafaiba is not responsible for voucher codes shared with third parties. Any misuse arising from shared codes is your sole responsibility.\n\n• Voucher codes are non-transferable between devices once activated. If you need to switch devices, you must purchase a new voucher.`
    },
    {
      title: '6. Service Modifications & Termination',
      content: `• Ultrafaiba reserves the right to modify, suspend, or discontinue any service, temporarily or permanently, with or without notice.\n\n• We may terminate or suspend your access to services immediately, without prior notice, for conduct that we believe violates these Terms, is harmful to other users, or is otherwise objectionable.\n\n• Upon termination of a home fiber subscription, any outstanding balance becomes immediately due and payable.\n\n• You may cancel your home fiber subscription at any time by contacting our support team at 0724167975. Cancellation takes effect at the end of the current billing cycle. No pro-rated refunds will be issued for partial months.`
    },
    {
      title: '7. Intellectual Property',
      content: `• All content, trademarks, logos, branding, software, and materials on the Ultrafaiba platform are the exclusive property of Ultrafaiba Internet Services and are protected by intellectual property laws.\n\n• You may not copy, reproduce, modify, distribute, display, or create derivative works from any Ultrafaiba materials without explicit written permission.\n\n• The Ultrafaiba name, logo, and all related product and service names are trademarks of Ultrafaiba Internet Services.`
    },
    {
      title: '8. Limitation of Liability',
      content: `• TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, ULTRAFAIBA SHALL NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES, INCLUDING BUT NOT LIMITED TO LOSS OF PROFITS, DATA, BUSINESS OPPORTUNITIES, OR GOODWILL.\n\n• Ultrafaiba's total liability for any claim arising from the use of our services shall not exceed the amount paid by you for the specific service giving rise to the claim during the 3 months preceding the claim.\n\n• Ultrafaiba is not liable for any damages resulting from: (a) your failure to maintain adequate security of your account; (b) unauthorized access to your data or transmissions; (c) interruption or cessation of service; (d) any third-party content accessed through our network.`
    },
    {
      title: '9. Indemnification',
      content: `You agree to indemnify, defend, and hold harmless Ultrafaiba, its officers, directors, employees, agents, and affiliates from and against any and all claims, damages, losses, liabilities, costs, and expenses (including reasonable attorney fees) arising from or related to:\n\n• Your use or misuse of Ultrafaiba services\n• Your violation of these Terms\n• Your violation of any third-party rights\n• Any content you transmit through our network\n• Any illegal activity conducted using our services`
    },
    {
      title: '10. Governing Law & Dispute Resolution',
      content: `• These Terms shall be governed by and construed in accordance with applicable local laws.\n\n• Any disputes arising from or relating to these Terms or the use of Ultrafaiba services shall first be attempted to be resolved through good-faith negotiation between the parties.\n\n• If negotiation fails, disputes shall be submitted to binding arbitration. The arbitration shall be conducted by a single arbitrator in accordance with applicable arbitration rules.\n\n• Notwithstanding the foregoing, Ultrafaiba reserves the right to seek injunctive or other equitable relief in any court of competent jurisdiction.\n\n• If any provision of these Terms is found to be unenforceable, the remaining provisions shall continue in full force and effect.`
    },
    {
      title: '11. Force Majeure',
      content: `Ultrafaiba shall not be liable for any failure or delay in performing its obligations under these Terms where such failure or delay results from circumstances beyond its reasonable control, including but not limited to: natural disasters, acts of God, war, terrorism, riots, embargoes, acts of civil or military authorities, fire, floods, earthquakes, power outages, fiber cuts by third parties, equipment failures, telecommunications failures, or internet service provider failures.`
    },
    {
      title: '12. Contact Information',
      content: `For any questions, concerns, or complaints regarding these Terms of Service, please contact us:\n\n• Phone / M-Pesa: 0724167975\n• Email: support@ultrafaiba.net\n• Support Hours: 24/7/365\n\nWe aim to respond to all inquiries within 24 hours.`
    }
  ];

  // ─── PRIVACY POLICY ───
  const privacyPolicy = [
    {
      title: '1. Information We Collect',
      content: `Ultrafaiba collects the following categories of information:\n\n• Personal Information: Name, phone number, email address, and M-Pesa transaction details provided during registration or payment.\n\n• Device Information: MAC addresses, IP addresses, device type/model, operating system, and browser information collected automatically when you connect to our network.\n\n• Usage Data: Connection timestamps, session duration, data consumption volumes (upload/download), and authentication logs.\n\n• Payment Information: M-Pesa transaction IDs, payment amounts, and timestamps. We do NOT store M-Pesa PINs or full mobile money credentials.\n\n• Technical Data: Network performance metrics, signal strength readings, and diagnostic logs used for service improvement.`
    },
    {
      title: '2. How We Use Your Information',
      content: `We use collected information for the following purposes:\n\n• Service Delivery: To authenticate your devices, provision bandwidth, manage voucher activations, and deliver internet connectivity.\n\n• Billing & Payments: To process M-Pesa transactions, generate invoices, track payment history, and manage account balances.\n\n• Network Management: To monitor network performance, manage bandwidth allocation, troubleshoot technical issues, and plan capacity upgrades.\n\n• Security: To detect and prevent unauthorized access, fraud, abuse, and violations of our Acceptable Use Policy.\n\n• Communication: To send service notifications, payment confirmations, maintenance alerts, and respond to support inquiries.\n\n• Service Improvement: To analyze usage patterns and improve network performance, user experience, and service reliability.`
    },
    {
      title: '3. Data Sharing & Disclosure',
      content: `Ultrafaiba does NOT sell, trade, or rent your personal information to third parties. We may share your information only in the following circumstances:\n\n• Service Providers: With trusted third-party service providers who assist in payment processing (M-Pesa/Safaricom), subject to confidentiality agreements.\n\n• Legal Requirements: When required by law, regulation, legal process, or governmental request.\n\n• Protection of Rights: When necessary to protect the rights, property, or safety of Ultrafaiba, our users, or the public.\n\n• Business Transfers: In connection with any merger, acquisition, or sale of company assets, where user data may be among transferred assets.\n\n• With Your Consent: When you have given explicit consent for a specific purpose.`
    },
    {
      title: '4. Data Retention',
      content: `• Active account data is retained for the duration of your subscription plus 12 months after account closure.\n\n• Payment transaction records are retained for 7 years for accounting and regulatory compliance.\n\n• Network connection logs (MAC addresses, IP addresses, session data) are retained for 90 days for security and troubleshooting purposes.\n\n• Expired voucher records are retained for 30 days after expiration, then permanently deleted.\n\n• You may request deletion of your personal data by contacting us at 0724167975 or support@ultrafaiba.net. Certain data may be retained where required by law.`
    },
    {
      title: '5. Data Security',
      content: `We implement appropriate technical and organizational security measures to protect your personal information, including:\n\n• Encryption of data in transit using TLS/SSL protocols\n• Secure storage of authentication credentials using industry-standard hashing algorithms\n• Regular security audits and vulnerability assessments\n• Access controls limiting employee access to personal data on a need-to-know basis\n• Firewall and intrusion detection systems on all network infrastructure\n\nDespite our best efforts, no method of electronic transmission or storage is 100% secure. We cannot guarantee absolute security of your data.`
    },
    {
      title: '6. Your Rights',
      content: `You have the following rights regarding your personal data:\n\n• Right of Access: You may request a copy of the personal data we hold about you.\n\n• Right of Correction: You may request correction of inaccurate or incomplete personal data.\n\n• Right of Deletion: You may request deletion of your personal data, subject to legal retention requirements.\n\n• Right to Object: You may object to certain processing activities, such as marketing communications.\n\n• Right to Data Portability: You may request your data in a commonly used, machine-readable format.\n\nTo exercise any of these rights, contact us at 0724167975 or support@ultrafaiba.net.`
    },
    {
      title: '7. Cookies & Tracking',
      content: `The Ultrafaiba captive portal and subscriber dashboard may use cookies and similar technologies to:\n\n• Maintain your login session\n• Remember your preferences\n• Analyze portal usage patterns\n\nYou may disable cookies in your browser settings, but this may affect the functionality of our portal. We do not use cookies for third-party advertising or cross-site tracking.`
    },
    {
      title: '8. Children\'s Privacy',
      content: `Ultrafaiba services are not directed at children under the age of 13. We do not knowingly collect personal information from children under 13. If we become aware that we have collected personal information from a child under 13, we will take steps to delete such information promptly. If you believe a child has provided us with personal information, please contact us at 0724167975.`
    }
  ];

  // ─── ACCEPTABLE USE POLICY ───
  const acceptableUse = [
    {
      title: '1. Prohibited Activities',
      content: `You agree NOT to use Ultrafaiba services for any of the following:\n\n• Illegal Activities: Any activity that violates local, national, or international laws or regulations.\n\n• Hacking & Unauthorized Access: Attempting to gain unauthorized access to any computer system, network, or data, including Ultrafaiba's own infrastructure.\n\n• Malware Distribution: Creating, distributing, or transmitting viruses, worms, trojans, ransomware, or any other malicious software.\n\n• Spam & Unsolicited Communications: Sending bulk unsolicited emails, messages, or any form of spam.\n\n• Denial of Service: Launching or participating in denial-of-service (DoS/DDoS) attacks against any target.\n\n• Network Abuse: Engaging in activities that degrade network performance for other users, including excessive bandwidth consumption through automated scripts or bots.\n\n• Identity Fraud: Impersonating any person or entity, or falsely stating or misrepresenting your affiliation with any person or entity.\n\n• Copyright Infringement: Distributing, downloading, or sharing copyrighted material without proper authorization from the rights holder.\n\n• Illegal Content: Hosting, transmitting, or accessing child exploitation material, or content that promotes violence, hate, or discrimination.`
    },
    {
      title: '2. Fair Usage Guidelines',
      content: `While Ultrafaiba offers unlimited data on all plans, we maintain fair usage guidelines to ensure equitable service quality for all subscribers:\n\n• Do not operate commercial servers (web hosting, game servers, file sharing servers) on residential plans without prior written consent.\n\n• Do not resell or redistribute your internet connection to third parties without authorization.\n\n• Do not use automated tools to circumvent authentication or voucher systems.\n\n• Do not attempt to bypass bandwidth management or traffic shaping systems.\n\n• Ultrafaiba reserves the right to implement temporary traffic management during periods of extreme network congestion to ensure fair access for all users.`
    },
    {
      title: '3. Consequences of Violation',
      content: `Violations of this Acceptable Use Policy may result in:\n\n• First Offense: Written warning via SMS or email.\n\n• Second Offense: Temporary suspension of service for up to 7 days.\n\n• Third Offense: Permanent termination of service and account closure without refund.\n\n• Severe Violations: Immediate termination without prior warning for activities including but not limited to: distribution of malware, DDoS attacks, child exploitation content, or any activity causing significant harm to the network or other users.\n\n• Ultrafaiba may report illegal activities to appropriate law enforcement authorities and cooperate fully with any resulting investigations.`
    },
    {
      title: '4. Reporting Abuse',
      content: `If you become aware of any abuse of Ultrafaiba's network or violation of this Acceptable Use Policy, please report it immediately:\n\n• Phone: 0724167975\n• Email: support@ultrafaiba.net\n\nAll reports are treated confidentially. We will investigate all reports and take appropriate action.`
    }
  ];

  // ─── REFUND POLICY ───
  const refundPolicy = [
    {
      title: '1. Hotspot Voucher Refunds',
      content: `• Unused Vouchers: Vouchers that have NOT been activated (never used for login) are eligible for a full refund within 30 days of purchase. Contact us at 0724167975 with your M-Pesa transaction ID.\n\n• Activated Vouchers: Once a voucher has been activated (used for first login), NO refund will be issued regardless of remaining time or unused portion.\n\n• Partial Use: No pro-rated refunds are available for partially used vouchers. The full duration begins at first authentication.\n\n• Technical Issues: If you experience a confirmed service outage that affects more than 50% of your voucher's active duration, you may be eligible for a replacement voucher of equal value. Contact support with your voucher code and outage details.`
    },
    {
      title: '2. Home Fiber Subscription Refunds',
      content: `• Installation Fees: Installation and setup fees are non-refundable once the installation has been scheduled or commenced.\n\n• Monthly Subscription: No refunds are issued for partial months of service. If you cancel mid-cycle, service continues until the end of the current billing period.\n\n• Overpayment: If you accidentally overpay, the excess amount will be credited to your next billing cycle. You may also request a refund of overpayments within 60 days.\n\n• Service Quality: If you experience persistent service quality issues (documented over 3 or more consecutive days) that we are unable to resolve, you may be eligible for a pro-rated credit for the affected period.`
    },
    {
      title: '3. Refund Processing',
      content: `• All eligible refunds are processed via M-Pesa reversal to the original payment number.\n\n• Refund requests must include: your name, phone number, M-Pesa transaction ID, voucher code (if applicable), and reason for refund.\n\n• Refund processing takes 3-7 business days from the date of approval.\n\n• Ultrafaiba reserves the right to deny refund requests that do not meet the criteria outlined in this policy or that appear to be fraudulent.\n\n• Refund decisions by Ultrafaiba management are final and binding.`
    },
    {
      title: '4. How to Request a Refund',
      content: `To request a refund:\n\n1. Call or SMS: 0724167975\n2. Email: support@ultrafaiba.net\n3. Provide your M-Pesa transaction ID and reason for refund\n4. Our team will review your request within 48 hours\n5. If approved, refund will be processed via M-Pesa within 3-7 business days\n\nPlease retain your M-Pesa confirmation messages as proof of payment. Refund requests without valid transaction IDs may be denied.`
    }
  ];

  // ─── SLA ───
  const sla = [
    {
      title: '1. Uptime Guarantee',
      content: `Ultrafaiba commits to the following uptime targets:\n\n• Core Network Infrastructure: 99.9% monthly uptime\n• Home Fiber Connections: 99.5% monthly uptime\n• Hotspot Access Points: 99.0% monthly uptime\n\nUptime is measured as the percentage of time the service is available during a calendar month, excluding scheduled maintenance windows. Scheduled maintenance is performed during off-peak hours (typically 2:00 AM - 6:00 AM) with at least 24 hours advance notice to affected subscribers.`
    },
    {
      title: '2. Performance Targets',
      content: `• Latency: Average round-trip latency to Ultrafaiba core servers shall not exceed 10ms under normal network conditions.\n\n• Packet Loss: Packet loss rate shall not exceed 0.1% under normal network conditions.\n\n• Provisioned Speed: Subscribers shall receive a minimum of 80% of their subscribed speed during non-peak hours and 60% during peak hours (6:00 PM - 11:00 PM).\n\n• These targets represent best-effort commitments. Actual performance may vary based on factors including but not limited to: network congestion, device capabilities, WiFi interference, and distance from access points.`
    },
    {
      title: '3. Service Credits',
      content: `If Ultrafaiba fails to meet the uptime guarantees specified above, affected home fiber subscribers may be eligible for service credits:\n\n• 99.0% - 99.5% uptime: 5% credit on the monthly bill\n• 98.0% - 99.0% uptime: 10% credit on the monthly bill\n• 95.0% - 98.0% uptime: 25% credit on the monthly bill\n• Below 95.0% uptime: 50% credit on the monthly bill\n\nService credits must be requested within 30 days of the affected month. Credits are applied to future billing cycles and are not redeemable for cash. Service credits do not apply to outages caused by scheduled maintenance, customer equipment issues, or force majeure events.`
    },
    {
      title: '4. Support Response Times',
      content: `Ultrafaiba provides the following target response times for support requests:\n\n• Critical (Complete service outage): Initial response within 1 hour, resolution target within 4 hours\n• High (Significant service degradation): Initial response within 2 hours, resolution target within 8 hours\n• Medium (Intermittent issues): Initial response within 4 hours, resolution target within 24 hours\n• Low (General inquiries): Initial response within 24 hours, resolution target within 72 hours\n\nResponse times are measured during business hours. Critical issues are monitored and responded to 24/7.\n\nContact support at 0724167975 or support@ultrafaiba.net.`
    },
    {
      title: '5. Maintenance Windows',
      content: `• Scheduled Maintenance: Performed during off-peak hours with minimum 24 hours advance notice via SMS to affected subscribers.\n\n• Emergency Maintenance: May be performed at any time without advance notice when necessary to address critical security vulnerabilities, prevent data loss, or restore service after unexpected outages.\n\n• Maintenance notifications are sent to the phone number on file. Ensure your contact information is up to date.`
    },
    {
      title: '6. Exclusions',
      content: `This SLA does not apply to service disruptions caused by:\n\n• Customer equipment failures or misconfigurations\n• Power outages at the customer premises\n• Force majeure events (natural disasters, civil unrest, government actions)\n• Scheduled maintenance windows\n• Third-party network or ISP issues beyond Ultrafaiba's control\n• Customer-initiated changes or modifications\n• Exceeding published service specifications or fair use guidelines`
    }
  ];

  const contentMap = {
    terms: termsOfService,
    privacy: privacyPolicy,
    acceptable: acceptableUse,
    refund: refundPolicy,
    sla: sla
  };

  const titleMap = {
    terms: 'Terms of Service',
    privacy: 'Privacy Policy',
    acceptable: 'Acceptable Use Policy',
    refund: 'Refund & Cancellation Policy',
    sla: 'Service Level Agreement (SLA)'
  };

  const currentSections = contentMap[activeTab];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className={`rounded-3xl p-6 md:p-8 border ${darkMode ? 'bg-slate-800/60 border-slate-700' : 'bg-gradient-to-br from-violet-50 to-indigo-50 border-violet-200'}`}>
        <div className="flex items-center gap-3 mb-3">
          <div className="p-3 rounded-xl bg-gradient-to-br from-violet-600 to-indigo-600 text-white shadow-md">
            <Scale className="w-6 h-6" />
          </div>
          <div>
            <h2 className={`text-2xl font-black tracking-tight ${darkMode ? 'text-white' : 'text-slate-900'}`}>
              Legal & Policies
            </h2>
            <p className={`text-xs ${darkMode ? 'text-slate-400' : 'text-slate-500'}`}>
              Last updated: {LAST_UPDATED} • Ultrafaiba Internet Services
            </p>
          </div>
        </div>
        <p className={`text-sm leading-relaxed ${darkMode ? 'text-slate-300' : 'text-slate-600'}`}>
          Please read these documents carefully before using Ultrafaiba services. By using our services, you agree to be bound by all applicable terms and policies listed below.
        </p>
      </div>

      {/* Policy Tabs */}
      <div className={`p-1.5 rounded-2xl border overflow-x-auto ${darkMode ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'}`}>
        <div className="flex gap-1 min-w-max">
          {tabs.map(tab => (
            <button
              key={tab.key}
              onClick={() => { onTabChange(tab.key); setExpandedSection(0); }}
              className={`py-2.5 px-3 md:px-4 rounded-xl text-[11px] md:text-xs font-bold transition-all flex items-center gap-1.5 whitespace-nowrap ${
                activeTab === tab.key
                  ? 'bg-gradient-to-r from-violet-600 to-indigo-600 text-white shadow-md'
                  : darkMode ? 'text-slate-400 hover:bg-slate-800 hover:text-white' : 'text-slate-500 hover:bg-slate-50 hover:text-slate-900'
              }`}
            >
              <tab.icon className="w-3.5 h-3.5 shrink-0" />
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Active Policy Title */}
      <div className="flex items-center justify-between">
        <h3 className={`text-lg font-black tracking-tight ${darkMode ? 'text-white' : 'text-slate-900'}`}>
          {titleMap[activeTab]}
        </h3>
        <div className="flex gap-2">
          <button
            onClick={() => setExpandedSection(null)}
            className={`text-[10px] font-bold px-2.5 py-1 rounded-lg border transition-colors ${darkMode ? 'border-slate-700 text-slate-400 hover:text-white' : 'border-slate-200 text-slate-500 hover:text-slate-900'}`}
          >
            Collapse All
          </button>
          <button
            onClick={() => setExpandedSection(-1)}
            className={`text-[10px] font-bold px-2.5 py-1 rounded-lg border transition-colors ${darkMode ? 'border-slate-700 text-slate-400 hover:text-white' : 'border-slate-200 text-slate-500 hover:text-slate-900'}`}
          >
            Expand All
          </button>
        </div>
      </div>

      {/* Accordion Sections */}
      <div className="space-y-2">
        {currentSections.map((section, idx) => {
          const isOpen = expandedSection === -1 || expandedSection === idx;
          return (
            <div
              key={idx}
              className={`rounded-2xl border overflow-hidden transition-all ${
                darkMode
                  ? isOpen ? 'bg-slate-800 border-violet-600/50' : 'bg-slate-800/60 border-slate-700'
                  : isOpen ? 'bg-white border-violet-200 shadow-sm' : 'bg-white border-slate-200'
              }`}
            >
              <button
                onClick={() => toggle(idx)}
                className="w-full p-4 flex justify-between items-center text-left"
              >
                <span className={headingClass}>{section.title}</span>
                {isOpen ? (
                  <ChevronUp className="w-4 h-4 text-violet-500 shrink-0" />
                ) : (
                  <ChevronDown className={`w-4 h-4 shrink-0 ${darkMode ? 'text-slate-500' : 'text-slate-400'}`} />
                )}
              </button>
              {isOpen && (
                <div className="px-4 pb-4">
                  <div className={sectionClass} style={{ whiteSpace: 'pre-line' }}>
                    {section.content}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Contact & Questions Box */}
      <div className={`rounded-2xl p-5 border ${darkMode ? 'bg-emerald-950/30 border-emerald-800/50' : 'bg-emerald-50 border-emerald-200'}`}>
        <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4">
          <div className="flex-1">
            <h4 className={`font-bold text-sm flex items-center gap-2 ${darkMode ? 'text-emerald-400' : 'text-emerald-800'}`}>
              <Phone className="w-4 h-4" />
              Questions About Our Policies?
            </h4>
            <p className={`text-xs mt-1 leading-relaxed ${darkMode ? 'text-emerald-300/80' : 'text-emerald-700'}`}>
              If you have any questions about these terms, privacy practices, or our policies, don't hesitate to reach out. We're here to help 24/7.
            </p>
          </div>
          <div className={`text-center px-5 py-3 rounded-xl border ${darkMode ? 'bg-slate-900 border-emerald-800' : 'bg-white border-emerald-200'}`}>
            <span className={`text-[10px] uppercase font-mono tracking-widest block ${darkMode ? 'text-slate-400' : 'text-slate-500'}`}>Call / M-Pesa</span>
            <div className="flex items-center justify-center gap-2 flex-wrap">
              <span className={`text-lg font-black font-mono ${darkMode ? 'text-emerald-400' : 'text-emerald-700'}`}>0724167975</span>
              <CopyTextButton
                value="0724167975"
                label="Copy"
                className={`inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-[10px] font-bold transition-colors ${darkMode ? 'border-emerald-800 bg-slate-900 text-emerald-300 hover:bg-slate-800' : 'border-emerald-200 bg-white text-emerald-700 hover:bg-emerald-50'}`}
              />
            </div>
            <span className={`text-[10px] block ${darkMode ? 'text-slate-500' : 'text-slate-400'}`}>support@ultrafaiba.net</span>
          </div>
        </div>
      </div>

      {/* Legal Footer */}
      <div className={`text-center text-[10px] py-4 ${darkMode ? 'text-slate-500' : 'text-slate-400'}`}>
        <p>© 2026 Ultrafaiba Internet Services. All rights reserved.</p>
        <p className="mt-1">These policies are effective as of {LAST_UPDATED} and supersede all prior versions.</p>
      </div>
    </div>
  );
}

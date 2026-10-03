/**
 * Legacy view-shape types.
 *
 * These describe what the original UI components render (durations as strings,
 * statuses as display labels). Live data comes from `src/lib/types.ts` and is
 * translated by `src/lib/adapters.ts` — these interfaces are the target shapes.
 *
 * ⚠️ The `INITIAL_*` constants below are retained only as a visual reference for
 *    component development. The app no longer seeds from them.
 */

export interface HotspotPlan {
  id: string;
  name: string;
  duration: string;
  durationHours: number;
  price: number;
  speedLimit: string;
  uploadLimit?: string;
  sharedUsers: number;
  dataLimit: string;
  popular?: boolean;
  type: 'hotspot' | 'fiber';
}

export interface Voucher {
  code: string;
  planName: string;
  duration: string;
  speedLimit: string;
  status: 'Unused' | 'Active' | 'Expired';
  activatedAt?: string;
  expiresAt?: string;
  usedBy?: string;
}

export interface ClientProfile {
  accountNo: string;
  name: string;
  phone: string;
  email: string;
  currentPlan: string;
  status: 'Active' | 'Suspended' | 'Expired';
  balance: number;
  expiryDate: string;
  bandwidth: string;
}

export interface Invoice {
  id: string;
  billingMonth: string;
  amount: number;
  dueDate: string;
  status: 'Paid' | 'Unpaid' | 'Overdue';
  paidAt?: string;
  planName: string;
}

export interface SupportTicket {
  id: string;
  subject: string;
  category: 'Speed Issue' | 'Payment Failed' | 'Router Offline' | 'Voucher Code Error';
  status: 'Open' | 'In Progress' | 'Resolved';
  date: string;
  priority: 'Low' | 'Medium' | 'High';
  messages: Array<{ sender: 'client' | 'admin'; text: string; time: string }>;
}

export interface ActiveSession {
  id: string;
  /**
   * The RADIUS account the session authenticated as. This is the identifier an
   * ISP actually recognises; the MAC address is not carried by RADIUS accounting
   * and is therefore null rather than invented.
   */
  username: string;
  acctSessionId?: string | null;
  macAddress: string;
  ipAddress: string;
  voucherCode?: string;
  deviceType: string;
  downloadedMb: number;
  uploadedMb: number;
  uptime: string;
  node: string;
  /** True only when RADIUS says the session has not ended. */
  isActive: boolean;
  /** False for an ended session, so the UI can disable a pointless Kick. */
  canDisconnect: boolean;
  endReason?: string | null;
}

export interface NetworkNode {
  id: string;
  name: string;
  activeUsers: number;
  loadPercent: number;
  status: 'Online' | 'Maintenance' | 'Offline';
  bandwidthCapacity: string;
}

export const INITIAL_HOTSPOT_PLANS: HotspotPlan[] = [
  { id: 'h1', name: 'Ultra Lite', duration: '2 Hours', durationHours: 2, price: 15, speedLimit: '1 Mbps', uploadLimit: '2 Mbps', sharedUsers: 1, dataLimit: 'Unlimited', type: 'hotspot' },
  { id: 'h2', name: 'Ultra Daily Super', duration: '10 Hours', durationHours: 10, price: 30, speedLimit: '1 Mbps', uploadLimit: '2 Mbps', sharedUsers: 1, dataLimit: 'Unlimited', type: 'hotspot' },
  { id: 'h3', name: 'Ultra Daily Max', duration: '24 Hours', durationHours: 24, price: 40, speedLimit: '1 Mbps', uploadLimit: '2 Mbps', sharedUsers: 1, dataLimit: 'Unlimited', popular: true, type: 'hotspot' },
  { id: 'h4', name: 'Ultra Weekpass', duration: '7 Days', durationHours: 168, price: 245, speedLimit: '3 Mbps', sharedUsers: 3, dataLimit: 'Unlimited', type: 'hotspot' },
  { id: 'f1', name: 'Home Fiber Starter', duration: 'Monthly', durationHours: 720, price: 1000, speedLimit: '3 Mbps', sharedUsers: 5, dataLimit: 'Truly Unlimited', type: 'fiber' },
  { id: 'f2', name: 'Home Fiber Standard', duration: 'Monthly', durationHours: 720, price: 1500, speedLimit: '5 Mbps', sharedUsers: 5, dataLimit: 'Truly Unlimited', type: 'fiber' },
  { id: 'f3', name: 'Home Fiber Premium', duration: 'Monthly', durationHours: 720, price: 2000, speedLimit: '10 Mbps', sharedUsers: 10, dataLimit: 'Truly Unlimited', popular: true, type: 'fiber' },
  { id: 'f4', name: 'Home Fiber Ultra', duration: 'Monthly', durationHours: 720, price: 2500, speedLimit: '15 Mbps', sharedUsers: 10, dataLimit: 'Truly Unlimited', type: 'fiber' },
];

export const INITIAL_VOUCHERS: Voucher[] = [
  { code: 'FAIBA-872A', planName: 'Ultra Daily Super', duration: '10 Hours', speedLimit: '1 Mbps', status: 'Unused' },
  { code: 'FAIBA-112B', planName: 'Ultra Weekpass', duration: '7 Days', speedLimit: '3 Mbps', status: 'Unused' },
  { code: 'FAIBA-994X', planName: 'Ultra Daily Max', duration: '24 Hours', speedLimit: '1 Mbps', status: 'Active', activatedAt: '2026-03-01 09:15', expiresAt: '2026-03-02 09:15', usedBy: '04:A3:43:11:F2:BC' },
  { code: 'FAIBA-445M', planName: 'Ultra Lite', duration: '2 Hours', speedLimit: '1 Mbps', status: 'Expired', activatedAt: '2026-02-28 14:00', expiresAt: '2026-02-28 16:00', usedBy: 'BC:EE:7B:88:99:11' },
  { code: 'FAIBA-223K', planName: 'Ultra Daily Max', duration: '24 Hours', speedLimit: '1 Mbps', status: 'Unused' },
  { code: 'FAIBA-776P', planName: 'Ultra Weekpass', duration: '7 Days', speedLimit: '3 Mbps', status: 'Unused' },
];

export const INITIAL_CLIENT: ClientProfile = {
  accountNo: 'UFB-74291-NX',
  name: 'Alex Mercer',
  phone: '+254 712 349 882',
  email: 'alex.mercer@faibamail.net',
  currentPlan: 'Home Fiber Standard',
  status: 'Active',
  balance: 0.00,
  expiryDate: '2026-04-05',
  bandwidth: '5 Mbps Symmetrical'
};

export const INITIAL_INVOICES: Invoice[] = [
  { id: 'INV-2026-003', billingMonth: 'March 2026', amount: 1500, dueDate: '2026-03-05', status: 'Paid', paidAt: '2026-03-04', planName: 'Home Fiber Standard' },
  { id: 'INV-2026-002', billingMonth: 'February 2026', amount: 1500, dueDate: '2026-02-05', status: 'Paid', paidAt: '2026-02-03', planName: 'Home Fiber Standard' },
  { id: 'INV-2026-001', billingMonth: 'January 2026', amount: 1500, dueDate: '2026-01-05', status: 'Paid', paidAt: '2026-01-05', planName: 'Home Fiber Standard' },
  { id: 'INV-2026-004', billingMonth: 'April 2026 (Upcoming)', amount: 1500, dueDate: '2026-04-05', status: 'Unpaid', planName: 'Home Fiber Standard' },
];

export const INITIAL_TICKETS: SupportTicket[] = [
  {
    id: 'TCK-882',
    subject: 'Slight packet loss during peak rain hours',
    category: 'Speed Issue',
    status: 'In Progress',
    date: '2026-03-12 11:20',
    priority: 'Medium',
    messages: [
      { sender: 'client', text: 'Hello, I notice about 2% packet loss during the heavy rains last evening. Can you inspect the fiber terminal box outside?', time: '11:20' },
      { sender: 'admin', text: 'Hi Alex, we have scheduled an engineering checkup for your distribution switch box this afternoon.', time: '13:45' }
    ]
  },
  {
    id: 'TCK-511',
    subject: 'M-Pesa / Credit Card renewal automation confirmation',
    category: 'Payment Failed',
    status: 'Resolved',
    date: '2026-02-03 08:10',
    priority: 'Low',
    messages: [
      { sender: 'client', text: 'Paid via Card, but the portal took 5 minutes to update.', time: '08:10' },
      { sender: 'admin', text: 'Resolved automatically by webhook confirmation. Thank you for your patience!', time: '08:15' }
    ]
  }
];

// Demo rows only. Live rows come from radius_sessions via my_radius_sessions(),
// and a real RADIUS session carries no MAC address.
export const INITIAL_SESSIONS: ActiveSession[] = [
  { id: 's1', username: 'amina', macAddress: 'A4:C3:F0:11:92:AA', ipAddress: '10.150.1.42', voucherCode: 'FAIBA-994X', deviceType: 'Apple iPhone 15 Pro', downloadedMb: 1420, uploadedMb: 245, uptime: '04h 22m', node: 'Node Bravo', isActive: true, canDisconnect: true },
  { id: 's2', username: 'kevinho', macAddress: '3C:D0:F8:74:B3:2E', ipAddress: '10.150.2.109', voucherCode: 'Simulated-MAC-Auth', deviceType: 'Samsung Galaxy S24 Ultra', downloadedMb: 850, uploadedMb: 90, uptime: '02h 11m', node: 'Node Alpha', isActive: true, canDisconnect: true },
  { id: 's3', username: 'grace_m', macAddress: 'E0:33:8E:A1:BC:05', ipAddress: '10.150.1.75', voucherCode: 'FAIBA-Temporary', deviceType: 'Dell XPS Laptop Windows 11', downloadedMb: 4500, uploadedMb: 1120, uptime: '08h 45m', node: 'Node Charlie', isActive: true, canDisconnect: true },
  { id: 's4', username: 'davidk', macAddress: '48:2C:6A:FF:D2:88', ipAddress: '10.150.3.18', voucherCode: 'Direct-Promo', deviceType: 'Xiaomi Redmi Note 13', downloadedMb: 180, uploadedMb: 25, uptime: '00h 35m', node: 'Ultrafaiba Main Hub', isActive: false, canDisconnect: false, endReason: 'acct-stop' }
];

export const INITIAL_NODES: NetworkNode[] = [
  { id: 'n1', name: 'Ultrafaiba Main Hub', activeUsers: 342, loadPercent: 68, status: 'Online', bandwidthCapacity: '10 Gbps' },
  { id: 'n2', name: 'Node Alpha', activeUsers: 119, loadPercent: 45, status: 'Online', bandwidthCapacity: '2 Gbps' },
  { id: 'n3', name: 'Node Bravo', activeUsers: 205, loadPercent: 82, status: 'Online', bandwidthCapacity: '2 Gbps' },
  { id: 'n4', name: 'Node Charlie', activeUsers: 64, loadPercent: 29, status: 'Online', bandwidthCapacity: '1 Gbps' },
  { id: 'n5', name: 'Node Delta', activeUsers: 0, loadPercent: 0, status: 'Maintenance', bandwidthCapacity: '1 Gbps' }
];

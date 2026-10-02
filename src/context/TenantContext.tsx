  import {
  createContext, useCallback, useContext, useEffect, useMemo, useState,
  type ReactNode,
} from 'react'
import * as api from '../lib/data'
import type {
  Client, Invoice, Node, Plan, Session as NetSession, Ticket, TicketMessage, Voucher,
} from '../lib/types'

interface TenantState {
  loading: boolean
  error: string | null
  plans: Plan[]
  vouchers: Voucher[]
  clients: Client[]
  invoices: Invoice[]
  nodes: Node[]
  sessions: NetSession[]
  tickets: Ticket[]
  messagesFor: (ticketId: string) => Promise<TicketMessage[]>
  reload: () => Promise<void>
  generateVouchers: (planId: string, prefix: string, count: number) => Promise<Voucher[]>
  redeemVoucher: (code: string) => Promise<{ success: boolean; message: string }>
  clearExpiredVouchers: () => Promise<void>
  setNodeStatus: (nodeId: string, status: Node['status']) => Promise<void>
  kickSession: (sessionId: string) => Promise<void>
  payInvoice: (input: { invoiceId: string; phone: string; amount: number; clientId?: string }) => Promise<string>
  addTicket: (subject: string, category: string, priority: Ticket['priority'], clientId?: string | null) => Promise<void>
  upgradePlan: (clientId: string, planName: string) => Promise<void>
  addClient: (input: { full_name: string; phone: string; email: string; plan_name: string }) => Promise<void>
  setClientStatus: (clientId: string, status: Client['status']) => Promise<void>
}

const TenantContext = createContext<TenantState | null>(null)

export function TenantProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [plans, setPlans] = useState<Plan[]>([])
  const [vouchers, setVouchers] = useState<Voucher[]>([])
  const [clients, setClients] = useState<Client[]>([])
  const [invoices, setInvoices] = useState<Invoice[]>([])
  const [nodes, setNodes] = useState<Node[]>([])
  const [sessions, setSessions] = useState<NetSession[]>([])
  const [tickets, setTickets] = useState<Ticket[]>([])

  const reload = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      // Independent tables → fetch together.
      const [p, v, c, i, n, s, t] = await Promise.all([
        api.fetchPlans(), api.fetchVouchers(), api.fetchClients(),
        api.fetchInvoices(), api.fetchNodes(), api.fetchSessions(), api.fetchTickets(),
      ])
      setPlans(p); setVouchers(v); setClients(c)
      setInvoices(i); setNodes(n); setSessions(s); setTickets(t)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load tenant data.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void reload() }, [reload])

  const value = useMemo<TenantState>(() => ({
    loading,
    error,
    plans, vouchers, clients, invoices, nodes, sessions, tickets,
    messagesFor: api.fetchTicketMessages,
    reload,

    generateVouchers: async (planId, prefix, count) => {
      const created = await api.generateVouchers(planId, prefix, count)
      await reload()
      return created
    },
    redeemVoucher: api.redeemVoucher,
    clearExpiredVouchers: async () => { await api.clearExpiredVouchers(); await reload() },
    setNodeStatus: async (nodeId, status) => { await api.setNodeStatus(nodeId, status); await reload() },
    kickSession: async (sessionId) => { await api.kickSession(sessionId); await reload() },

    payInvoice: async ({ invoiceId, phone, amount, clientId }) => {
      const res = await api.initiateStkPush({ phone, amount, invoiceId, clientId })
      await reload()
      return res.message
    },
    addTicket: async (subject, category, priority, clientId = null) => {
      await api.addTicket(subject, category, priority, clientId)
      await reload()
    },
    upgradePlan: async (clientId, planName) => { await api.upgradePlan(clientId, planName); await reload() },
    addClient: async (input) => { await api.addClient(input); await reload() },
    setClientStatus: async (clientId, status) => { await api.setClientStatus(clientId, status); await reload() },
  }), [loading, error, plans, vouchers, clients, invoices, nodes, sessions, tickets, reload])

  return <TenantContext.Provider value={value}>{children}</TenantContext.Provider>
}

export function useTenant() {
  const ctx = useContext(TenantContext)
  if (!ctx) throw new Error('useTenant must be used inside <TenantProvider>')
  return ctx
}

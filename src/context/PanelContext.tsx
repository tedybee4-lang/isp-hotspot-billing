/**
 * Panel data: every domain the ISP panel renders.
 *
 * Separate from TenantContext so the core tenant objects stay small. Each
 * fetch goes through the data layer, where RLS scopes it to the signed-in
 * tenant — no isp_id is ever supplied from the client.
 */
import {
  createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode,
} from 'react'
import * as api from '../lib/data'
import type {
  Commission, DashboardStats, Expense, InventoryItem, InventoryMovement,
  LedgerTransaction, Payment, PermissionDefinition, Renewal, Reseller,
  ServiceAccount, SmsMessage, SmsTemplate,
} from '../lib/types'

interface PanelState {
  loading: boolean
  error: string | null
  stats: DashboardStats | null
  payments: Payment[]
  accounts: ServiceAccount[]
  renewals: Renewal[]
  transactions: LedgerTransaction[]
  smsTemplates: SmsTemplate[]
  smsMessages: SmsMessage[]
  resellers: Reseller[]
  commissions: Commission[]
  expenses: Expense[]
  inventory: InventoryItem[]
  movements: InventoryMovement[]
  permissions: PermissionDefinition[]
  reload: () => Promise<void>
}

const PanelContext = createContext<PanelState | null>(null)

export function PanelProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [stats, setStats] = useState<DashboardStats | null>(null)
  const [payments, setPayments] = useState<Payment[]>([])
  const [accounts, setAccounts] = useState<ServiceAccount[]>([])
  const [renewals, setRenewals] = useState<Renewal[]>([])
  const [transactions, setTransactions] = useState<LedgerTransaction[]>([])
  const [smsTemplates, setSmsTemplates] = useState<SmsTemplate[]>([])
  const [smsMessages, setSmsMessages] = useState<SmsMessage[]>([])
  const [resellers, setResellers] = useState<Reseller[]>([])
  const [commissions, setCommissions] = useState<Commission[]>([])
  const [expenses, setExpenses] = useState<Expense[]>([])
  const [inventory, setInventory] = useState<InventoryItem[]>([])
  const [movements, setMovements] = useState<InventoryMovement[]>([])
  const [permissions, setPermissions] = useState<PermissionDefinition[]>([])

  const reload = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [st, pay, acc, ren, trx, smt, smm, rsl, com, exp, inv, mov, perm] =
        await Promise.all([
          api.fetchDashboardStats(), api.fetchPayments(), api.fetchServiceAccounts(),
          api.fetchRenewals(), api.fetchTransactions(), api.fetchSmsTemplates(),
          api.fetchSmsMessages(), api.fetchResellers(), api.fetchCommissions(),
          api.fetchExpenses(), api.fetchInventoryItems(), api.fetchInventoryMovements(),
          api.fetchPermissions(),
        ])
      setStats(st); setPayments(pay); setAccounts(acc); setRenewals(ren)
      setTransactions(trx); setSmsTemplates(smt); setSmsMessages(smm)
      setResellers(rsl); setCommissions(com); setExpenses(exp)
      setInventory(inv); setMovements(mov); setPermissions(perm)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load panel data.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void reload() }, [reload])

  const value = useMemo<PanelState>(() => ({
    loading, error, stats, payments, accounts, renewals, transactions,
    smsTemplates, smsMessages, resellers, commissions, expenses, inventory,
    movements, permissions, reload,
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [loading, error, stats, payments, accounts, renewals, transactions,
    smsTemplates, smsMessages, resellers, commissions, expenses, inventory,
    movements, permissions, reload])

  return <PanelContext.Provider value={value}>{children}</PanelContext.Provider>
}

export function usePanel() {
  const ctx = useContext(PanelContext)
  if (!ctx) throw new Error('usePanel must be used inside <PanelProvider>')
  return ctx
}
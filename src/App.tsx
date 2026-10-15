import type { ReactNode } from 'react'
import { BrowserRouter, Navigate, Outlet, Route, Routes } from 'react-router-dom'
import { AuthProvider, useAuth } from './context/AuthContext'
import { ThemeProvider } from './context/ThemeContext'
import { TenantProvider } from './context/TenantContext'
import { PanelProvider } from './context/PanelContext'

import PlatformLanding from './pages/PlatformLanding'
import Login from './pages/Login'
import Register from './pages/Register'
import CaptivePortal from './pages/CaptivePortal'

import AdminLayout from './pages/admin/AdminLayout'
import AdminOverview from './pages/admin/AdminOverview'
import IspsManager from './pages/admin/IspsManager'
import IspDetail from './pages/admin/IspDetail'
import AuditLogPage from './pages/admin/AuditLog'
import PlatformPayments from './pages/admin/PlatformPayments'
import PlatformHashBack from './pages/admin/PlatformHashBack'
import PlatformPayHero from './pages/admin/PlatformPayHero'

import IspLayout from './pages/isp/IspLayout'
import { CaptivePortalSettingsPage } from './pages/isp/settings/CaptivePortal'
import { PaymentSettingsPage, NetworkSettingsPage, SmsSettingsPage } from './pages/isp/settings/Payment'
import { HashBackPaymentSettings } from './pages/isp/settings/HashBackPayments'
import { ProvisioningPage } from './pages/isp/routers/Provisioning'
import {
  DashboardPage, CustomersPage, PaymentsPage, InvoicesPage,
  SessionsPage, VouchersPage, SmsPage, ResellersPage, CommissionsPage,
  ExpensesPage, InventoryPage, ReportsPage, StaffPage, SettingsPage,
} from './pages/isp/panel'
import { Spinner } from './components/ui'

type Allowed = 'super_admin' | 'isp' | 'any'

function RequireAuth({ allow, children }: { allow: Allowed[]; children: ReactNode }) {
  const { user, loading } = useAuth()
  if (loading) {
    return (
      <div className="min-h-screen grid place-items-center bg-slate-50 dark:bg-slate-950">
        <Spinner label="Checking your session..." />
      </div>
    )
  }
  if (!user) return <Navigate to="/login" replace />
  const role = user.profile.role
  const ok =
    allow.includes('any')
    || (allow.includes('super_admin') && role === 'super_admin')
    || (allow.includes('isp') && role !== 'super_admin' && Boolean(user.isp))
  if (!ok) {
    return <Navigate to={role === 'super_admin' ? '/admin' : user.isp ? '/app' : '/register'} replace />
  }
  return <>{children}</>
}

function Guarded({ allow }: { allow: Allowed[] }) {
  return <RequireAuth allow={allow}><Outlet /></RequireAuth>
}

function NotFound() {
  return (
    <div className="min-h-screen grid place-items-center bg-slate-50 dark:bg-slate-950 p-6 text-center">
      <div>
        <p className="text-5xl font-black text-slate-300 dark:text-slate-700">404</p>
        <h1 className="text-lg font-black text-slate-900 dark:text-white mt-3">Page not found</h1>
        <a href="/" className="inline-block mt-5 text-xs font-bold text-violet-600 dark:text-violet-400 hover:underline">
          Back to the platform
        </a>
      </div>
    </div>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <ThemeProvider>
        <AuthProvider>
          <Routes>
            <Route path="/" element={<PlatformLanding />} />
            <Route path="/login" element={<Login />} />
            <Route path="/register" element={<Register />} />
            <Route path="/portal/:slug" element={<CaptivePortal />} />

            <Route element={<Guarded allow={['super_admin']} />}>
              <Route path="/admin" element={<AdminLayout />}>
                <Route index element={<AdminOverview />} />
                <Route path="isps" element={<IspsManager />} />
                <Route path="isps/:id" element={<IspDetail />} />
                <Route path="payments" element={<PlatformPayments />} />
                {/* The HashBack screen is where the platform's own payment
                    credential is entered. It sits inside the super-admin guard
                    AND re-checks the role server-side, so the route guard is a
                    convenience rather than the actual protection. */}
                <Route path="payment-gateway/hashback" element={<PlatformHashBack />} />
                <Route path="payment-gateway/payhero" element={<PlatformPayHero />} />
                <Route path="audit" element={<AuditLogPage />} />
              </Route>
            </Route>

            <Route element={<Guarded allow={['isp']} />}>
              <Route path="/app" element={
                <TenantProvider>
                  <PanelProvider>
                    <IspLayout />
                  </PanelProvider>
                </TenantProvider>
              }>
                <Route index element={<DashboardPage />} />
                <Route path="customers" element={<CustomersPage />} />
                <Route path="sessions" element={<SessionsPage />} />
                <Route path="tickets" element={<TicketsRoute />} />
                <Route path="packages" element={<PackagesRoute />} />
                <Route path="hotspot" element={<HotspotRoute />} />
                <Route path="pppoe" element={<PppoeRoute />} />
                <Route path="vouchers" element={<VouchersPage />} />
                <Route path="routers" element={<RoutersRoute />} />
                {/* Network Status is its own page rather than part of Routers. It answers "is the network up and why not", which is a different question from "which routers do I own". Keeping them together is what let the old page show a router as online off the strength of a database row alone. */}
                <Route path="status" element={<NetworkStatusRoute />} />
                <Route path="payments" element={<PaymentsPage />} />
                <Route path="invoices" element={<InvoicesPage />} />
                <Route path="renewals" element={<RenewalsRoute />} />
                <Route path="transactions" element={<TransactionsRoute />} />
                <Route path="sms" element={<SmsPage />} />
                <Route path="resellers" element={<ResellersPage />} />
                <Route path="commissions" element={<CommissionsPage />} />
                <Route path="expenses" element={<ExpensesPage />} />
                <Route path="inventory" element={<InventoryPage />} />
                <Route path="reports" element={<ReportsPage />} />
                <Route path="staff" element={<StaffPage />} />
                <Route path="roles" element={<RolesRoute />} />
                <Route path="settings" element={<SettingsPage />} />
                <Route path="audit" element={<SuperAdminAuditRoute />} />
                <Route path="provision" element={<ProvisioningPage />} />
                <Route path="settings/portal" element={<CaptivePortalSettingsPage />} />
                <Route path="settings/payment" element={<PaymentSettingsPage />} />
                {/* HashBack self service. Separate from settings/payment so the
                    legacy Till-only screen keeps working for an ISP that has
                    not migrated, while a HashBack ISP gets the channel flow. */}
                <Route path="settings/payments" element={<HashBackPaymentSettings />} />
                <Route path="settings/network" element={<NetworkSettingsPage />} />
                <Route path="settings/sms" element={<SmsSettingsPage />} />
              </Route>
            </Route>

            <Route path="*" element={<NotFound />} />
          </Routes>
        </AuthProvider>
      </ThemeProvider>
    </BrowserRouter>
  )
}

// Deferred imports keep the route table readable.
import { lazy } from 'react'
const TicketsRoute = lazy(() => import('./pages/isp/panel/legacy').then((m) => ({ default: m.TicketsRoute })))
const PackagesRoute = lazy(() => import('./pages/isp/panel/PackagesPage').then((m) => ({ default: m.PackagesPage })))
const HotspotRoute = lazy(() => import('./pages/isp/panel/legacy').then((m) => ({ default: m.HotspotRoute })))
const PppoeRoute = lazy(() => import('./pages/isp/panel/legacy').then((m) => ({ default: m.PppoeRoute })))
const RoutersRoute = lazy(() => import('./pages/isp/panel/legacy').then((m) => ({ default: m.RoutersRoute })))
const NetworkStatusRoute = lazy(() => import('./pages/isp/routers/NetworkStatus').then((m) => ({ default: m.default })))
const RenewalsRoute = lazy(() => import('./pages/isp/panel/legacy').then((m) => ({ default: m.RenewalsRoute })))
const TransactionsRoute = lazy(() => import('./pages/isp/panel/legacy').then((m) => ({ default: m.TransactionsRoute })))
const RolesRoute = lazy(() => import('./pages/isp/panel/legacy').then((m) => ({ default: m.RolesRoute })))
const SuperAdminAuditRoute = lazy(() => import('./pages/isp/panel/legacy').then((m) => ({ default: m.AuditRoute })))

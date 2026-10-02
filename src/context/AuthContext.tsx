import {
  createContext, useCallback, useContext, useEffect, useMemo, useState,
  type ReactNode,
} from 'react'
import * as api from '../lib/data'
import type { SessionUser } from '../lib/types'

interface AuthState {
  user: SessionUser | null
  loading: boolean
  signIn: (email: string, password: string) => Promise<SessionUser>
  signUp: (email: string, password: string, fullName: string) => Promise<void>
  signOut: () => Promise<void>
  refresh: () => Promise<void>
}

const AuthContext = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    try {
      setUser(await api.getSessionUser())
    } catch {
      setUser(null)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      await refresh()
      if (!cancelled) setLoading(false)
    })()
    const unsubscribe = api.onAuthChange((next) => {
      if (!cancelled) setUser(next)
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [refresh])

  const value = useMemo<AuthState>(() => ({
    user,
    loading,
    refresh,
    signIn: async (email, password) => {
      const next = await api.signIn(email, password)
      setUser(next)
      return next
    },
    signUp: async (email, password, fullName) => {
      await api.signUp(email, password, fullName)
    },
    signOut: async () => {
      await api.signOut()
      setUser(null)
    },
  }), [user, loading, refresh])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>')
  return ctx
}
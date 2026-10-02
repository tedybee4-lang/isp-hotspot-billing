import {
  createContext, useCallback, useContext, useEffect, useMemo, useState,
  type ReactNode,
} from 'react'

interface ThemeState {
  darkMode: boolean
  toggleTheme: () => void
}

const ThemeContext = createContext<ThemeState | null>(null)
const STORAGE_KEY = 'ispflow.theme'

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [darkMode, setDarkMode] = useState<boolean>(() => {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored !== null) return stored === 'dark'
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
  })

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, darkMode ? 'dark' : 'light')
    document.documentElement.classList.toggle('dark', darkMode)
  }, [darkMode])

  const toggleTheme = useCallback(() => setDarkMode((v) => !v), [])
  const value = useMemo(() => ({ darkMode, toggleTheme }), [darkMode, toggleTheme])

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme() {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used inside <ThemeProvider>')
  return ctx
}
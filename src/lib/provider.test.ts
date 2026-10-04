/**
 * Provider-aware frontend logic.
 *
 * These cover the two things a payment screen gets wrong in ways that cost real
 * money: showing "Payment successful" for money that never arrived, and letting the
 * browser decide which provider or collection path a tenant uses.
 */
import { describe, expect, it } from 'vitest'
import {
  canShowSuccess,
  collectionModeFor,
  isAutomatedProvider,
  isTerminalPhase,
  phaseFromStatus,
  phaseMessage,
  providerLabel,
  toPaymentProvider,
  type PaymentPhase,
} from './provider'

const ALL_PHASES: PaymentPhase[] = [
  'idle', 'initiating', 'stk_sent', 'awaiting', 'verifying',
  'success', 'failed', 'pending', 'timeout', 'provider_unavailable',
]

describe('provider identification', () => {
  it('recognises PayHero as the active provider', () => {
    expect(toPaymentProvider('payhero')).toBe('payhero')
    expect(providerLabel('payhero')).toBe('PayHero')
    expect(isAutomatedProvider('payhero')).toBe(true)
  })

  it('still recognises HashBack so historical records label correctly', () => {
    // A payment settled through HashBack must keep saying HashBack. Rewriting it
    // to PayHero would make the historical record a lie.
    expect(providerLabel('hashback')).toBe('HashBack')
    expect(isAutomatedProvider('hashback')).toBe(true)
  })

  it('treats manual as a real mode, not as a failure', () => {
    expect(providerLabel('manual')).toBe('Manual Till / Paybill')
    expect(isAutomatedProvider('manual')).toBe(false)
    // 'manual_till' is the mode name the backend uses for the same thing.
    expect(toPaymentProvider('manual_till')).toBe('manual')
  })

  it('reports an unrecognised provider as unknown rather than manual', () => {
    // Defaulting to manual would show Till instructions to a customer whose ISP
    // actually has STK configured, sending them to pay in the wrong place.
    expect(toPaymentProvider('something-else')).toBe('unknown')
    expect(providerLabel(null)).toBe('Not configured')
    expect(isAutomatedProvider(undefined)).toBe(false)
  })

  it('is case and whitespace insensitive', () => {
    expect(toPaymentProvider('  PayHero ')).toBe('payhero')
    expect(toPaymentProvider('PAYHERO')).toBe('payhero')
  })
})

describe('collection mode comes from the backend, not the browser', () => {
  it('gives an automated provider the STK path', () => {
    expect(collectionModeFor('payhero')).toBe('stk')
    expect(collectionModeFor('hashback')).toBe('stk')
  })

  it('gives a manual tenant the instruction sheet', () => {
    expect(collectionModeFor('manual')).toBe('manual_till')
    expect(collectionModeFor('unknown')).toBe('manual_till')
  })

  it('defers to an explicit mode the backend reported', () => {
    // The backend knows about tenants this helper does not, so a recognised
    // reported mode wins over inference from the provider.
    expect(collectionModeFor('payhero', 'manual_till')).toBe('manual_till')
    expect(collectionModeFor('manual', 'stk')).toBe('stk')
  })

  it('ignores a mode it does not recognise rather than guessing', () => {
    expect(collectionModeFor('payhero', 'nonsense')).toBe('stk')
  })
})
describe('an STK prompt is not a payment', () => {
  it('allows success in exactly one phase', () => {
    const allowed = ALL_PHASES.filter(canShowSuccess)
    expect(allowed).toEqual(['success'])
  })

  it('never reports success for a prompt that was merely sent', () => {
    // These three are the states a naive implementation mistakes for a receipt.
    expect(canShowSuccess('stk_sent')).toBe(false)
    expect(canShowSuccess('awaiting')).toBe(false)
    expect(canShowSuccess('verifying')).toBe(false)
  })

  it('treats pending and timeout as not-success, not as failure', () => {
    // Both are inconclusive. Showing either as an outcome would be a lie, and
    // showing a failure would stop a customer who has actually paid.
    expect(canShowSuccess('pending')).toBe(false)
    expect(canShowSuccess('timeout')).toBe(false)
    expect(canShowSuccess('failed')).toBe(false)
    expect(canShowSuccess('provider_unavailable')).toBe(false)
  })
})

describe('backend status maps to a phase conservatively', () => {
  it('maps only a confirmed success to success', () => {
    expect(phaseFromStatus('success')).toBe('success')
    expect(phaseFromStatus('settled')).toBe('success')
    expect(phaseFromStatus('completed')).toBe('success')
  })

  it('maps a failure to failure', () => {
    expect(phaseFromStatus('failed')).toBe('failed')
    expect(phaseFromStatus('reversed')).toBe('failed')
    expect(phaseFromStatus('cancelled')).toBe('failed')
  })

  it('maps everything unrecognised to pending, never to an outcome', () => {
    // A new provider state must not be mistaken for a failure, and certainly not
    // for a success.
    for (const v of ['pending', '', 'weird-new-state', 'PROCESSING', null, undefined]) {
      expect(phaseFromStatus(v), String(v)).toBe('pending')
    }
  })

  it('reports a timeout when polling gave up, whatever the last status was', () => {
    expect(phaseFromStatus('pending', { timedOut: true })).toBe('timeout')
    // Even a 'success' seen on the final attempt becomes timeout, because the
    // screen stopped trusting that poll before it landed.
    expect(phaseFromStatus('success', { timedOut: true })).toBe('timeout')
  })
})

describe('polling stops when it should', () => {
  it('keeps polling while the payment may still settle', () => {
    // Pending is NOT terminal: a provider can confirm minutes later, and stopping
    // would leave a paying customer staring at a spinner that never resolves.
    expect(isTerminalPhase('pending')).toBe(false)
    expect(isTerminalPhase('awaiting')).toBe(false)
    expect(isTerminalPhase('verifying')).toBe(false)
  })

  it('stops on every outcome', () => {
    expect(isTerminalPhase('success')).toBe(true)
    expect(isTerminalPhase('failed')).toBe(true)
    // Timeout is terminal so a phone that walked out of range is not polled
    // forever, burning the customer's data.
    expect(isTerminalPhase('timeout')).toBe(true)
  })
})

describe('customer-facing copy leaks nothing internal', () => {
  it('has a message for every phase', () => {
    for (const p of ALL_PHASES) {
      expect(phaseMessage(p).length, p).toBeGreaterThan(0)
    }
  })

  it('never names a credential, an endpoint or an HTTP status', () => {
    for (const p of ALL_PHASES) {
      const text = phaseMessage(p).toLowerCase()
      // These strings are read by a customer standing at an offline router.
      expect(text, p).not.toMatch(/token|password|secret|credential|authorization|basic |service role|encryption/)
      expect(text, p).not.toMatch(/http|\b50[0234]\b|unauthorized|forbidden/)
      expect(text, p).not.toMatch(/payhero|hashback/)
    }
  })

  it('tells a timed-out customer not to pay again', () => {
    // The most damaging copy bug here: a customer who already paid sees a
    // timeout and pays a second time.
    const msg = phaseMessage('timeout').toLowerCase()
    expect(msg).toContain('check your payment status')
  })
})
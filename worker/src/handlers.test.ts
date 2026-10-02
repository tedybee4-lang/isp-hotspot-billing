/**
 * The diagnostics security boundary.
 *
 * The panel must never be able to compose a RouterOS command. It picks an action
 * name from a fixed list and the worker runs the command that belongs to it. If
 * that boundary can be crossed, the panel becomes a remote shell with an ISP's
 * customer routers attached, so these tests assert it hard.
 */
import { describe, expect, it } from 'vitest'
import { validateHost, DIAGNOSTIC_COMMANDS } from './handlers.ts'

describe('validateHost', () => {
  it('accepts an IPv4 address', () => {
    expect(validateHost('8.8.8.8')).toBe('8.8.8.8')
  })

  it('accepts a hostname and a hyphenated one', () => {
    expect(validateHost('example.com')).toBe('example.com')
    expect(validateHost('my-host.example.co.ke')).toBe('my-host.example.co.ke')
  })

  it('rejects an empty target rather than sending one', () => {
    expect(() => validateHost('')).toThrow(/needs a target/)
  })

  it('rejects a RouterOS metacharacter injection attempt', () => {
    // Each of these would change the meaning of a command if it got through.
    expect(() => validateHost('8.8.8.8; /system/reboot')).toThrow(/not valid/)
    expect(() => validateHost('8.8.8.8 "')).toThrow(/not valid/)
    expect(() => validateHost('$(reboot)')).toThrow(/not valid/)
    expect(() => validateHost('a`b`')).toThrow(/not valid/)
    expect(() => validateHost('host name')).toThrow(/not valid/)
  })

  it('rejects an over-long value', () => {
    expect(() => validateHost('a'.repeat(300))).toThrow(/too long/)
  })

  it('does not echo the rejected value back in the error', () => {
    // The message must not become a way to reflect attacker input into a log.
    try {
      validateHost('bad;value')
      expect.unreachable('should have thrown')
    } catch (err) {
      expect((err as Error).message).not.toContain('bad;value')
    }
  })
})

describe('DIAGNOSTIC_COMMANDS', () => {
  it('is an allow-list, not a template', () => {
    // Every entry is a fixed literal path. A value would mean a caller could
    // control part of a command.
    for (const [action, command] of Object.entries(DIAGNOSTIC_COMMANDS)) {
      expect(command.startsWith('/'), `${action} must be an absolute path`).toBe(true)
      expect(command).not.toContain('$')
      expect(command).not.toContain('(')
      expect(command).not.toContain(' ')
    }
  })

  it('contains only read-only commands', () => {
    const forbidden = /\/(set|add|remove|remove$|enable|disable|reboot|shutdown|reset)/i
    for (const [action, command] of Object.entries(DIAGNOSTIC_COMMANDS)) {
      expect(forbidden.test(command), `${action} must not modify anything`).toBe(false)
    }
  })

  it('covers the checks an ISP actually needs', () => {
    for (const action of ['identity', 'resource', 'interface', 'route', 'bridge',
      'hotspot_active', 'pppoe_active', 'log', 'connections']) {
      expect(DIAGNOSTIC_COMMANDS[action], `missing ${action}`).toBeTruthy()
    }
  })

  it('offers nothing that restarts or resets the router', () => {
    expect(Object.keys(DIAGNOSTIC_COMMANDS)).not.toContain('reboot')
    expect(Object.keys(DIAGNOSTIC_COMMANDS)).not.toContain('reset')
    expect(Object.keys(DIAGNOSTIC_COMMANDS)).not.toContain('shutdown')
  })
})
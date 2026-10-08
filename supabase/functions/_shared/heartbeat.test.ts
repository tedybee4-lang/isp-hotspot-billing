import { describe, expect, it } from 'vitest'
import { heartbeatSource } from './heartbeat.ts'

describe('router heartbeat command polling', () => {
  it('keeps liveness separate and polls over certificate-verified HTTPS with its token', () => {
    const source = heartbeatSource({
      reportUrl: 'https://project.supabase.co/functions/v1/router-provision/report',
      heartbeatToken: 'a'.repeat(64),
    })
    expect(source).toContain('/ping?token=' + 'a'.repeat(64))
    expect(source).toContain('/commands?token=' + 'a'.repeat(64))
    expect(source).toContain('check-certificate=yes')
    expect(source).toContain('output=file dst-path=ispflow-command.rsc')
    expect(source).toContain('/import file-name=ispflow-command.rsc')
    expect(source).toContain('/file remove ispflow-command.rsc')
    expect(source).not.toContain('http-data=$command')
  })

  it('does not install a poll without a heartbeat credential', () => {
    const source = heartbeatSource({
      reportUrl: 'https://project.supabase.co/functions/v1/router-provision/report',
    })
    expect(source).toContain('/ping?token=')
    expect(source).not.toContain('/commands?token=')
  })
})

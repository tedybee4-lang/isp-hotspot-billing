// =============================================================================
//  Raw TCP / TLS channel for the RouterOS API.
//
//  This is the reason the worker exists as a separate process.
//
//  Supabase Edge Functions run on a serverless runtime with no outbound raw TCP,
//  so from there the API can only be reached over WebSocket. That works, but a
//  new TLS handshake per command is wasteful on a 32 MB RB941-2nD, and it costs
//  a round trip on every poll.
//
//  A persistent worker on a VPS holds a real TCP or TLS socket open and reuses
//  it. On a router with 32 MB of RAM that difference decides whether the
//  platform is a useful management tool or something that visibly degrades the
//  device it is meant to administer.
//
//  Plain `api` on 8728 is unencrypted and is only ever reached when api-ssl and
//  REST have both failed. `secure` records which was used, so every heartbeat
//  and job result carries the truth about how the password travelled.
// =============================================================================

import net from 'node:net'
import tls from 'node:tls'
import type { WireChannel } from './session.ts'

export interface RawChannelOptions {
  host: string
  port: number
  secure: boolean
  timeoutMs: number
}

/**
 * Where decoded bytes go.
 *
 * The channel is created before the session that consumes it, so the sink is
 * attached afterwards. That ordering is deliberate: the session owns the
 * RouterOsApi instance, and the session needs the channel to already exist.
 */
export interface ChannelSink {
  onBytes(chunk: Uint8Array): void
  onClosed(reason: string | null): void
}

export class RawApiChannel implements WireChannel {
  readonly secure: boolean

  private sink: ChannelSink | null = null
  private closedReported = false

  private constructor(
    private readonly socket: net.Socket | tls.TLSSocket,
    secure: boolean,
  ) {
    this.secure = secure
  }

  /** Attaches the consumer. Called once, immediately after opening. */
  attach(sink: ChannelSink): void {
    this.sink = sink
    this.socket.on('data', (chunk: Buffer) => {
      this.sink?.onBytes(new Uint8Array(chunk))
    })
    this.socket.on('error', (err: Error) => this.reportClose(err.message))
    this.socket.on('close', () => this.reportClose(null))
  }

  private reportClose(reason: string | null): void {
    if (this.closedReported) return
    this.closedReported = true
    this.sink?.onClosed(reason)
  }

  /**
   * Opens a channel and waits for the socket to be usable.
   *
   * Errors carry the host and port, because "cannot connect" without an address
   * is useless to whoever has to fix it.
   */
  static async open(opts: RawChannelOptions): Promise<RawApiChannel> {
    return new Promise((resolve, reject) => {
      let settled = false

      const fail = (message: string) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(new Error(message))
      }

      const timer = setTimeout(
        () => fail(`${opts.host}:${opts.port} did not connect within ${opts.timeoutMs}ms`),
        opts.timeoutMs,
      )

      const accept = (socket: net.Socket | tls.TLSSocket, secure: boolean) => {
        if (settled) { socket.destroy(); return }
        settled = true
        clearTimeout(timer)
        // Nagle would add up to 40 ms to every small command on a busy link.
        socket.setNoDelay(true)
        resolve(new RawApiChannel(socket, secure))
      }

      if (opts.secure) {
        const socket = tls.connect(
          {
            host: opts.host,
            port: opts.port,
            // MikroTik's api-ssl uses a self-signed certificate by default and
            // has no name to validate against on a private tunnel. Certificate
            // pinning would be theatre here; the tunnel and the port binding are
            // the real controls. Operators who terminate TLS themselves can set
            // NETISP_TLS_STRICT=true to require a trusted chain.
            rejectUnauthorized: process.env.NETISP_TLS_STRICT === 'true',
            servername: opts.host,
          },
          () => accept(socket, true),
        )
        socket.once('error', (err: Error) => fail(
          `TLS handshake with ${opts.host}:${opts.port} failed: ${err.message}`))
      } else {
        const socket = net.connect({ host: opts.host, port: opts.port }, () =>
          accept(socket, false))
        socket.once('error', (err: Error) => fail(
          `Cannot connect to ${opts.host}:${opts.port}: ${err.message}`))
      }
    })
  }

  send(bytes: Uint8Array): void {
    this.socket.write(bytes)
  }

  close(): void {
    // Do not wait for FIN. A router that has stopped answering must not be able
    // to hold the worker open.
    this.socket.destroy()
  }

  /** True while the socket is usable. */
  get alive(): boolean {
    return !this.socket.destroyed && !this.socket.writableEnded
  }

  /** The local port, for diagnostics. */
  get localPort(): number | undefined {
    return this.socket.localPort
  }
}
// p2p/webrtc.ts — Full WebRTC mesh with URL-based serverless signalling

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
]

export type MsgHandler = (msg: WireMsg, fromPeer: string) => void

export interface WireMsg {
  type: string
  payload: unknown
  from: string
  ts: number
}

// ─── URL signalling helpers ───────────────────────────────────────────────────

/** Compress + base64url-encode an SDP so it fits in a URL fragment */
export function encodeOffer(sdp: string): string {
  // Simple base64 — SDP is ASCII-safe
  return btoa(sdp).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function decodeOffer(encoded: string): string {
  const b64 = encoded.replace(/-/g, '+').replace(/_/g, '/')
  return atob(b64)
}

/** Build a join URL with the offer embedded in the hash */
export function buildInviteUrl(offerSdp: string, groupId: string): string {
  const encoded = encodeOffer(offerSdp)
  const base = window.location.origin + window.location.pathname
  return `${base}#join/${groupId}/${encoded}`
}

/** Parse an invite URL hash — returns null if not an invite */
export function parseInviteHash(hash: string): { groupId: string; offerSdp: string } | null {
  const m = hash.match(/^#?join\/([^/]+)\/(.+)$/)
  if (!m) return null
  return { groupId: m[1], offerSdp: decodeOffer(m[2]) }
}

/** Build answer URL (Person B → Person A) */
export function buildAnswerUrl(answerSdp: string, groupId: string): string {
  const encoded = encodeOffer(answerSdp)
  const base = window.location.origin + window.location.pathname
  return `${base}#answer/${groupId}/${encoded}`
}

export function parseAnswerHash(hash: string): { groupId: string; answerSdp: string } | null {
  const m = hash.match(/^#?answer\/([^/]+)\/(.+)$/)
  if (!m) return null
  return { groupId: m[1], answerSdp: decodeOffer(m[2]) }
}

// ─── Single peer connection ───────────────────────────────────────────────────

export class PeerConn {
  private pc: RTCPeerConnection
  private dc?: RTCDataChannel
  public peerId: string
  public onMessage: MsgHandler
  public onOpen?: () => void
  public onClose?: () => void

  constructor(peerId: string, onMessage: MsgHandler) {
    this.peerId = peerId
    this.onMessage = onMessage
    this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })
    this.pc.onconnectionstatechange = () => {
      const s = this.pc.connectionState
      if (s === 'disconnected' || s === 'failed' || s === 'closed') this.onClose?.()
    }
  }

  async createOffer(): Promise<string> {
    this.dc = this.pc.createDataChannel('sHare', { ordered: true })
    this._wire(this.dc)
    const offer = await this.pc.createOffer()
    await this.pc.setLocalDescription(offer)
    await this._waitIce()
    return JSON.stringify(this.pc.localDescription)
  }

  async receiveOffer(offerJson: string): Promise<string> {
    this.pc.ondatachannel = e => { this.dc = e.channel; this._wire(this.dc) }
    await this.pc.setRemoteDescription(JSON.parse(offerJson))
    const answer = await this.pc.createAnswer()
    await this.pc.setLocalDescription(answer)
    await this._waitIce()
    return JSON.stringify(this.pc.localDescription)
  }

  async receiveAnswer(answerJson: string): Promise<void> {
    await this.pc.setRemoteDescription(JSON.parse(answerJson))
  }

  send(msg: WireMsg) {
    if (this.dc?.readyState === 'open') this.dc.send(JSON.stringify(msg))
  }

  close() { this.dc?.close(); this.pc.close() }

  private _wire(dc: RTCDataChannel) {
    dc.onopen    = () => this.onOpen?.()
    dc.onclose   = () => this.onClose?.()
    dc.onmessage = e => {
      try { this.onMessage(JSON.parse(e.data), this.peerId) } catch {}
    }
  }

  private _waitIce(): Promise<void> {
    return new Promise(resolve => {
      if (this.pc.iceGatheringState === 'complete') { resolve(); return }
      const h = () => { if (this.pc.iceGatheringState === 'complete') { this.pc.removeEventListener('icegatheringstatechange', h); resolve() } }
      this.pc.addEventListener('icegatheringstatechange', h)
      setTimeout(resolve, 6000)
    })
  }
}

// ─── Mesh manager ────────────────────────────────────────────────────────────

export class Mesh {
  private conns = new Map<string, PeerConn>()
  public onMessage: MsgHandler = () => {}
  public onPeerJoin?: (id: string) => void
  public onPeerLeave?: (id: string) => void

  private _make(pid: string): PeerConn {
    const c = new PeerConn(pid, this.onMessage)
    c.onOpen  = () => { this.conns.set(pid, c); this.onPeerJoin?.(pid) }
    c.onClose = () => { this.conns.delete(pid); this.conns.delete(pid + '_p'); this.onPeerLeave?.(pid) }
    return c
  }

  async startOffer(remotePid: string): Promise<string> {
    const c = this._make(remotePid)
    this.conns.set(remotePid + '_p', c)
    return c.createOffer()
  }

  async finishOffer(remotePid: string, answerJson: string) {
    const c = this.conns.get(remotePid + '_p')
    if (!c) throw new Error('No pending conn for ' + remotePid)
    await c.receiveAnswer(answerJson)
  }

  async acceptOffer(remotePid: string, offerJson: string): Promise<string> {
    const c = this._make(remotePid)
    return c.receiveOffer(offerJson)
  }

  broadcast(msg: WireMsg) {
    for (const [k, c] of this.conns) if (!k.endsWith('_p')) c.send(msg)
  }

  sendTo(pid: string, msg: WireMsg) {
    this.conns.get(pid)?.send(msg)
  }

  peers(): string[] {
    return [...this.conns.keys()].filter(k => !k.endsWith('_p'))
  }

  close() { this.conns.forEach(c => c.close()); this.conns.clear() }
}

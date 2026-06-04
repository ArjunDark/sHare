import { useState, useEffect, useCallback, useRef } from 'react'
import { getOrCreateIdentity, getPeerId } from '../../crypto/keyManager'
import { Mesh, buildInviteUrl, buildAnswerUrl, parseInviteHash, parseAnswerHash, encodeOffer, type WireMsg } from '../../p2p/webrtc'
import { loadState, saveState, mergeState } from './lib/store'
import { computeBalances, simplifyDebts, toCSV } from './lib/finance'
import {
  CURRENCIES, CATEGORIES,
  type AppState, type Group, type Expense, type Payment,
  type Member, type CategoryId, type SplitMode, type SplitDetail, type Comment,
} from './lib/types'

// Capacitor — only available at runtime in the native app
// Falls back gracefully in browser
async function getCapacitorApp() {
  try { return (await import('@capacitor/app')).App } catch { return null }
}
async function getCapacitorShare() {
  try { return (await import('@capacitor/share')).Share } catch { return null }
}

const uid  = () => crypto.randomUUID()
const now  = () => Date.now()
const sym  = (code: string) => CURRENCIES.find(c => c.code === code)?.symbol ?? code
const cat  = (id: CategoryId) => CATEGORIES.find(c => c.id === id) ?? CATEGORIES[CATEGORIES.length - 1]

// ─── Split math ───────────────────────────────────────────────────────────────
function resolveShares(e: Expense): { peerId: string; value: number }[] {
  const s = e.splits
  if (!s.length) return []
  switch (e.splitMode) {
    case 'equal':   return s.map(x => ({ peerId: x.peerId, value: Math.round(e.amount / s.length * 100) / 100 }))
    case 'exact':   return s
    case 'percent': return s.map(x => ({ peerId: x.peerId, value: Math.round(e.amount * x.value / 100 * 100) / 100 }))
    case 'shares': {
      const tot = s.reduce((a, b) => a + b.value, 0)
      return s.map(x => ({ peerId: x.peerId, value: Math.round(e.amount * x.value / tot * 100) / 100 }))
    }
  }
}

function myShare(e: Expense, pid: string) {
  return resolveShares(e).find(s => s.peerId === pid)?.value ?? 0
}

function spendByCategory(expenses: Expense[], pid: string) {
  const m: Record<string, number> = {}
  for (const e of expenses) {
    const shares = resolveShares(e)
    for (const s of (pid === '*' ? shares : shares.filter(s => s.peerId === pid))) {
      m[e.category] = (m[e.category] ?? 0) + s.value
    }
  }
  return m
}

// ─── Tiny components ──────────────────────────────────────────────────────────
function Avatar({ name, size = 36 }: { name: string; size?: number }) {
  const colors = ['#5eead4','#a78bfa','#f9a8d4','#fbbf24','#34d399','#60a5fa']
  const color = colors[(name.charCodeAt(0) ?? 0) % colors.length]
  return (
    <div style={{ width: size, height: size, borderRadius: '50%', background: color + '22',
      border: `2px solid ${color}44`, display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: 'Syne, sans-serif', fontWeight: 700, fontSize: size * 0.38, color, flexShrink: 0 }}>
      {(name || '?')[0].toUpperCase()}
    </div>
  )
}

function BarChart({ data, symbol }: { data: Record<string, number>; symbol: string }) {
  const entries = Object.entries(data).sort((a, b) => b[1] - a[1]).slice(0, 6)
  if (!entries.length) return <p className="empty-hint">No data yet.</p>
  const max = entries[0][1]
  return (
    <div className="bar-chart">
      {entries.map(([id, val]) => {
        const c = cat(id as CategoryId)
        return (
          <div key={id} className="bar-row">
            <span className="bar-icon">{c.icon}</span>
            <div className="bar-track"><div className="bar-fill" style={{ width: `${val / max * 100}%` }} /></div>
            <span className="bar-val">{symbol}{val.toFixed(0)}</span>
          </div>
        )
      })}
    </div>
  )
}

function Sheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: React.ReactNode }) {
  if (!open) return null
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={e => e.stopPropagation()}>
        <div className="sheet-handle" />
        <div className="sheet-header">
          <span className="sheet-title">{title}</span>
          <button className="sheet-close" onClick={onClose}>✕</button>
        </div>
        <div className="sheet-body">{children}</div>
      </div>
    </div>
  )
}

// ─── App ──────────────────────────────────────────────────────────────────────
type Tab = 'balances' | 'expenses' | 'members'

export default function App() {
  const [myPeerId, setMyPeerId] = useState('')
  const [myName, setMyName]     = useState(() => localStorage.getItem('sHare-name') ?? '')
  const [state, setState]       = useState<AppState>({ groups: [], expenses: [], payments: [] })
  const [activeGroup, setActiveGroup] = useState<string | null>(null)
  const [peers, setPeers]       = useState<string[]>([])
  const [tab, setTab]           = useState<Tab>('balances')

  // Sheets
  const [showNewGroup, setShowNewGroup]   = useState(false)
  const [showAddExp, setShowAddExp]       = useState(false)
  const [showSettle, setShowSettle]       = useState(false)
  const [showCharts, setShowCharts]       = useState(false)
  const [showInvite, setShowInvite]       = useState(false)
  const [showExpDetail, setShowExpDetail] = useState(false)
  const [showOnboard, setShowOnboard]     = useState(false)
  const [showNameEdit, setShowNameEdit]   = useState(false)

  // Invite state
  const [inviteUrl, setInviteUrl]         = useState('')
  const [answerUrl, setAnswerUrl]         = useState('')
  const [waitingAnswer, setWaitingAnswer] = useState(false)
  const [inboundInvite, setInboundInvite] = useState<{ groupId: string; offerSdp: string } | null>(null)
  const [showJoinSheet, setShowJoinSheet] = useState(false)

  // Forms
  const [newGroupForm, setNewGroupForm] = useState({ name: '', type: 'other' as Group['type'], currency: 'INR' })
  const [expForm, setExpForm] = useState({
    note: '', amount: '', category: 'food' as CategoryId,
    payer: '', splitMode: 'equal' as SplitMode, splits: [] as SplitDetail[], editId: '',
  })
  const [settleForm, setSettleForm] = useState({ from: '', to: '', amount: '', note: '' })
  const [viewExpId, setViewExpId] = useState('')
  const [commentText, setCommentText] = useState('')
  const [editName, setEditName] = useState('')

  const meshRef = useRef<Mesh | null>(null)

  // Derived
  const group       = state.groups.find(g => g.id === activeGroup) ?? null
  const grpExp      = state.expenses.filter(e => e.groupId === activeGroup && !e.deleted)
  const grpPay      = state.payments.filter(p => p.groupId === activeGroup)
  const members     = group?.members ?? []
  const balances    = group ? computeBalances(members, grpExp, grpPay) : {}
  const settlements = group ? simplifyDebts(balances) : []
  const S           = group ? sym(group.currency) : '₹'
  const viewExp     = state.expenses.find(e => e.id === viewExpId)

  function pname(pid: string) {
    if (!pid) return '?'
    if (pid === myPeerId) return myName || 'Me'
    return members.find(m => m.peerId === pid)?.name ?? pid.slice(0, 8) + '…'
  }

  // ── Init ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    getOrCreateIdentity().then(kp => getPeerId(kp).then(id => setMyPeerId(id)))
    loadState().then(s => {
      setState(s)
      if (s.groups.length > 0) setActiveGroup(s.groups[0].id)
    })
    if (!localStorage.getItem('sHare-name')) setShowOnboard(true)

    // Web: check URL hash for invite/answer
    const invite = parseInviteHash(window.location.hash)
    if (invite) {
      setInboundInvite(invite)
      setShowJoinSheet(true)
      window.history.replaceState(null, '', window.location.pathname)
    }
    const answer = parseAnswerHash(window.location.hash)
    if (answer) {
      doFinishConnect(answer.groupId, answer.answerSdp)
      window.history.replaceState(null, '', window.location.pathname)
    }

    // Native Android: listen for deep links (share://join/... or share://answer/...)
    getCapacitorApp().then(App => {
      if (!App) return
      // Handle cold-start deep link
      App.getLaunchUrl().then(({ url }) => {
        if (!url) return
        handleDeepLink(url)
      })
      // Handle warm deep link while app is open
      App.addListener('appUrlOpen', ({ url }) => handleDeepLink(url))
    })
  }, [])

  useEffect(() => { if (myName) localStorage.setItem('sHare-name', myName) }, [myName])
  useEffect(() => { saveState(state) }, [state])

  // ── Mesh ─────────────────────────────────────────────────────────────────
  function mesh() {
    if (!meshRef.current) {
      const m = new Mesh()
      m.onMessage   = handleMsg
      m.onPeerJoin  = p => setPeers(prev => [...new Set([...prev, p])])
      m.onPeerLeave = p => setPeers(prev => prev.filter(x => x !== p))
      meshRef.current = m
    }
    return meshRef.current
  }

  const handleMsg = useCallback((msg: WireMsg) => {
    if (msg.type === 'hello') {
      const { name: n, peerId: pid, groupId } = msg.payload as { name: string; peerId: string; groupId: string }
      setState(prev => {
        const g = prev.groups.find(g => g.id === groupId)
        if (!g || g.members.find(m => m.peerId === pid)) return prev
        const updated = { ...g, members: [...g.members, { peerId: pid, name: n, joinedTs: now() }] }
        return { ...prev, groups: prev.groups.map(x => x.id === groupId ? updated : x) }
      })
      meshRef.current?.sendTo(msg.from, { type: 'state', payload: state, from: myPeerId, ts: now() })
    } else if (msg.type === 'state') {
      setState(prev => mergeState(prev, msg.payload as AppState))
    } else if (msg.type === 'patch') {
      const r = msg.payload as Partial<AppState>
      setState(prev => mergeState(prev, { groups: r.groups ?? [], expenses: r.expenses ?? [], payments: r.payments ?? [] }))
    }
  }, [myPeerId, state])

  function broadcast(patch: Partial<AppState>) {
    meshRef.current?.broadcast({ type: 'patch', payload: patch, from: myPeerId, ts: now() })
  }
  function announceJoin(groupId: string) {
    mesh().broadcast({ type: 'hello', payload: { name: myName, peerId: myPeerId, groupId }, from: myPeerId, ts: now() })
  }

  function handleDeepLink(url: string) {
    const native = url.replace('share://', '#')
    const invite = parseInviteHash(native)
    if (invite) { setInboundInvite(invite); setShowJoinSheet(true); return }
    const answer = parseAnswerHash(native)
    if (answer) doFinishConnect(answer.groupId, answer.answerSdp)
  }

  function buildNativeInviteUrl(offer: string, groupId: string) {
    const isNative = !!(window as any).Capacitor?.isNativePlatform?.()
    return isNative
      ? `share://join/${groupId}/${encodeOffer(offer)}`
      : buildInviteUrl(offer, groupId)
  }

  function buildNativeAnswerUrl(answer: string, groupId: string) {
    const isNative = !!(window as any).Capacitor?.isNativePlatform?.()
    return isNative
      ? `share://answer/${groupId}/${encodeOffer(answer)}`
      : buildAnswerUrl(answer, groupId)
  }

  async function nativeShare(title: string, url: string) {
    const SharePlugin = await getCapacitorShare()
    if (SharePlugin) {
      await SharePlugin.share({ title, url, dialogTitle: title })
    } else if (navigator.share) {
      await navigator.share({ title, url })
    } else {
      await navigator.clipboard.writeText(url)
    }
  }

  // ── Connect ───────────────────────────────────────────────────────────────
  async function doStartInvite(groupId: string) {
    setInviteUrl('')
    setWaitingAnswer(false)
    setShowInvite(true)
    const offer = await mesh().startOffer('invited')
    const url   = buildNativeInviteUrl(offer, groupId)
    setInviteUrl(url)
    setWaitingAnswer(true)
  }

  async function doAcceptInvite(groupId: string, offerSdp: string) {
    if (!myName.trim()) return
    const answer = await mesh().acceptOffer('inviter', offerSdp)
    const url    = buildNativeAnswerUrl(answer, groupId)
    setAnswerUrl(url)
    setState(prev => {
      const g = prev.groups.find(g => g.id === groupId)
      if (!g || g.members.find(m => m.peerId === myPeerId)) return prev
      const updated = { ...g, members: [...g.members, { peerId: myPeerId, name: myName, joinedTs: now() }] }
      return { ...prev, groups: prev.groups.map(x => x.id === groupId ? updated : x) }
    })
    setActiveGroup(groupId)
    announceJoin(groupId)
  }

  async function doFinishConnect(groupId: string, answerSdp: string) {
    try {
      await mesh().finishOffer('invited', answerSdp)
      setWaitingAnswer(false)
      setShowInvite(false)
      setActiveGroup(groupId)
      announceJoin(groupId)
    } catch (e) { console.error(e) }
  }

  // ── Groups ────────────────────────────────────────────────────────────────
  function createGroup() {
    if (!newGroupForm.name.trim()) return
    const g: Group = {
      id: uid(), name: newGroupForm.name, type: newGroupForm.type,
      currency: newGroupForm.currency, simplifyDebts: true,
      members: [{ peerId: myPeerId, name: myName, joinedTs: now() }],
      createdTs: now(),
    }
    const next = { ...state, groups: [...state.groups, g] }
    setState(next)
    setActiveGroup(g.id)
    setNewGroupForm({ name: '', type: 'other', currency: 'INR' })
    setShowNewGroup(false)
    setTab('balances')
  }

  // ── Expenses ──────────────────────────────────────────────────────────────
  function openAdd(editId = '') {
    if (editId) {
      const e = state.expenses.find(x => x.id === editId)!
      setExpForm({ note: e.note, amount: String(e.amount), category: e.category, payer: e.payer, splitMode: e.splitMode, splits: e.splits, editId })
    } else {
      setExpForm({ note: '', amount: '', category: 'food', payer: myPeerId, splitMode: 'equal',
        splits: members.map(m => ({ peerId: m.peerId, value: 0 })), editId: '' })
    }
    setShowAddExp(true)
  }

  function saveExp() {
    if (!expForm.amount || !group) return
    const splits = expForm.splits.length ? expForm.splits : members.map(m => ({ peerId: m.peerId, value: 0 }))
    const e: Expense = {
      id: expForm.editId || uid(), groupId: group.id, payer: expForm.payer,
      amount: Number(expForm.amount), currency: group.currency, note: expForm.note || 'Expense',
      category: expForm.category, splitMode: expForm.splitMode, splits,
      ts: expForm.editId ? (state.expenses.find(x => x.id === expForm.editId)?.ts ?? now()) : now(),
      editedTs: expForm.editId ? now() : undefined,
      comments: expForm.editId ? (state.expenses.find(x => x.id === expForm.editId)?.comments ?? []) : [],
    }
    const expenses = expForm.editId
      ? state.expenses.map(x => x.id === expForm.editId ? e : x)
      : [e, ...state.expenses]
    setState({ ...state, expenses })
    broadcast({ expenses: [e] })
    setShowAddExp(false)
  }

  function deleteExp(id: string) {
    const e = state.expenses.find(x => x.id === id)
    if (!e) return
    const del = { ...e, deleted: true, editedTs: now() }
    const expenses = state.expenses.map(x => x.id === id ? del : x)
    setState({ ...state, expenses })
    broadcast({ expenses: [del] })
    setShowExpDetail(false)
  }

  function addComment(expId: string) {
    if (!commentText.trim()) return
    const c: Comment = { id: uid(), author: myPeerId, text: commentText, ts: now() }
    const expenses = state.expenses.map(e =>
      e.id === expId ? { ...e, comments: [...(e.comments ?? []), c], editedTs: now() } : e
    )
    setState({ ...state, expenses })
    broadcast({ expenses: [expenses.find(e => e.id === expId)!] })
    setCommentText('')
  }

  // ── Payments ──────────────────────────────────────────────────────────────
  function recordPayment() {
    if (!settleForm.amount || !group) return
    const p: Payment = {
      id: uid(), groupId: group.id, from: settleForm.from, to: settleForm.to,
      amount: Number(settleForm.amount), currency: group.currency,
      note: settleForm.note || 'Settlement', ts: now(),
    }
    const payments = [...state.payments, p]
    setState({ ...state, payments })
    broadcast({ payments: [p] })
    setShowSettle(false)
  }

  function exportCSV() {
    if (!group) return
    const csv = toCSV(grpExp, members, pname)
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
    a.download = `${group.name}.csv`
    a.click()
  }

  // ── My balance ────────────────────────────────────────────────────────────
  const myBal = balances[myPeerId] ?? 0
  const myOwes  = settlements.filter(s => s.from === myPeerId)
  const myOwed  = settlements.filter(s => s.to   === myPeerId)

  // ─────────────────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div className="app">

      {/* ── ONBOARDING ── */}
      <Sheet open={showOnboard} onClose={() => {}} title="Welcome to sHare">
        <div className="onboard">
          <div className="onboard-logo">s<span>H</span>are</div>
          <p className="onboard-sub">Split expenses with friends.<br />No server. No account. Fully private.</p>
          <label>What should we call you?</label>
          <input className="input" autoFocus placeholder="Your name" value={myName}
            onChange={e => setMyName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && myName.trim() && setShowOnboard(false)} />
          <button className="btn-primary" disabled={!myName.trim()} onClick={() => setShowOnboard(false)}>
            Let's go →
          </button>
        </div>
      </Sheet>

      {/* ── NO GROUP YET ── */}
      {!activeGroup && !showOnboard && (
        <div className="empty-home">
          <div className="eh-logo">s<span>H</span>are</div>
          <div className="eh-greeting">Hey {myName || 'there'} 👋</div>
          <p className="eh-sub">Create a group to start splitting expenses, or open an invite link from a friend.</p>
          <button className="btn-primary" onClick={() => setShowNewGroup(true)}>＋ Create group</button>
          <div className="eh-peer">Your Peer ID
            <span className="peer-id-chip">{myPeerId ? myPeerId.slice(0, 20) + '…' : '…'}</span>
            <button className="copy-link" onClick={() => navigator.clipboard.writeText(myPeerId)}>Copy</button>
          </div>
        </div>
      )}

      {/* ── MAIN GROUP VIEW ── */}
      {activeGroup && group && (
        <div className="main-view">
          {/* Header */}
          <header className="header">
            <div className="header-left">
              {state.groups.length > 1 && (
                <select className="group-picker" value={activeGroup}
                  onChange={e => { setActiveGroup(e.target.value); setTab('balances') }}>
                  {state.groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
                </select>
              )}
              {state.groups.length === 1 && <span className="header-title">{group.name}</span>}
            </div>
            <div className="header-right">
              <span className={`live-dot ${peers.length > 0 ? 'on' : ''}`} title={peers.length > 0 ? `${peers.length} online` : 'offline'} />
              <button className="hbtn" onClick={() => doStartInvite(group.id)} title="Invite">👥</button>
              <button className="hbtn" onClick={() => setShowCharts(true)} title="Charts">📊</button>
              <button className="hbtn" onClick={() => setShowNewGroup(true)} title="New group">＋</button>
            </div>
          </header>

          {/* Balance hero */}
          <div className={`balance-hero ${myBal >= 0 ? 'pos' : 'neg'}`}>
            <div className="bh-label">You {myBal >= 0 ? 'are owed' : 'owe'}</div>
            <div className="bh-amount">{S}{Math.abs(myBal).toFixed(2)}</div>
            {myBal !== 0 && (
              <div className="bh-detail">
                {myOwes.map((s, i) => <span key={i} className="bh-chip neg">→ {pname(s.to)} {S}{s.amount.toFixed(2)}</span>)}
                {myOwed.map((s, i) => <span key={i} className="bh-chip pos">← {pname(s.from)} {S}{s.amount.toFixed(2)}</span>)}
              </div>
            )}
            {myBal !== 0 && (
              <button className="bh-settle-btn" onClick={() => {
                const s = myOwes[0] ?? myOwed[0]
                if (s) setSettleForm({ from: s.from, to: s.to, amount: s.amount.toFixed(2), note: '' })
                setShowSettle(true)
              }}>
                Settle up
              </button>
            )}
          </div>

          {/* Tab bar */}
          <div className="tab-bar">
            {(['balances','expenses','members'] as Tab[]).map(t => (
              <button key={t} className={`tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>
                {t === 'balances' ? '⚖️ Balances' : t === 'expenses' ? '🧾 Expenses' : '👥 Members'}
              </button>
            ))}
          </div>

          {/* Tab: BALANCES */}
          {tab === 'balances' && (
            <div className="tab-content">
              {settlements.length === 0 && (
                <div className="settled-all">
                  <div style={{ fontSize: 40 }}>✅</div>
                  <p>All settled up!</p>
                </div>
              )}
              {settlements.map((s, i) => (
                <div key={i} className="settle-card" onClick={() => {
                  setSettleForm({ from: s.from, to: s.to, amount: s.amount.toFixed(2), note: '' })
                  setShowSettle(true)
                }}>
                  <Avatar name={pname(s.from)} size={40} />
                  <div className="sc-body">
                    <span className="sc-from">{pname(s.from)}</span>
                    <span className="sc-arrow"> owes </span>
                    <span className="sc-to">{pname(s.to)}</span>
                  </div>
                  <div className="sc-right">
                    <span className="sc-amt">{S}{s.amount.toFixed(2)}</span>
                    <span className="sc-cta">Settle ›</span>
                  </div>
                </div>
              ))}

              {grpPay.length > 0 && (
                <div className="payments-list">
                  <div className="list-label">Past payments</div>
                  {grpPay.slice().reverse().map(p => (
                    <div key={p.id} className="payment-row">
                      <span className="pr-from">{pname(p.from)}</span>
                      <span className="pr-arrow">→</span>
                      <span className="pr-to">{pname(p.to)}</span>
                      <span className="pr-amt">{S}{p.amount.toFixed(2)}</span>
                      <span className="pr-note">{p.note}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Tab: EXPENSES */}
          {tab === 'expenses' && (
            <div className="tab-content">
              {grpExp.length === 0 && (
                <div className="empty-tab">
                  <div style={{ fontSize: 40 }}>🧾</div>
                  <p>No expenses yet.</p>
                  <button className="btn-primary small" onClick={() => openAdd()}>Add first expense</button>
                </div>
              )}
              {grpExp.map(e => {
                const share = myShare(e, myPeerId)
                const c = cat(e.category)
                return (
                  <div key={e.id} className="exp-card" onClick={() => { setViewExpId(e.id); setShowExpDetail(true) }}>
                    <div className="ec-icon">{c.icon}</div>
                    <div className="ec-body">
                      <div className="ec-note">{e.note}</div>
                      <div className="ec-sub">{pname(e.payer)} · {new Date(e.ts).toLocaleDateString('en-IN', { day:'numeric', month:'short' })}</div>
                    </div>
                    <div className="ec-right">
                      <div className="ec-total">{S}{e.amount.toFixed(2)}</div>
                      <div className={`ec-share ${e.payer === myPeerId ? 'lent' : 'owe'}`}>
                        {e.payer === myPeerId
                          ? `you lent ${S}${(e.amount - share).toFixed(2)}`
                          : `you owe ${S}${share.toFixed(2)}`}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {/* Tab: MEMBERS */}
          {tab === 'members' && (
            <div className="tab-content">
              {members.map(m => {
                const bal = balances[m.peerId] ?? 0
                return (
                  <div key={m.peerId} className="member-card">
                    <Avatar name={m.name} size={44} />
                    <div className="mc-body">
                      <div className="mc-name">{m.peerId === myPeerId ? `${m.name} (you)` : m.name}</div>
                      <div className="mc-status">{peers.includes(m.peerId) ? '● online' : '○ offline'}</div>
                    </div>
                    <div className={`mc-bal ${bal >= 0 ? 'pos' : 'neg'}`}>
                      {bal >= 0 ? '+' : ''}{S}{bal.toFixed(2)}
                    </div>
                  </div>
                )
              })}
              <button className="btn-secondary" onClick={() => doStartInvite(group.id)}>
                👥 Invite someone
              </button>
              <button className="btn-ghost" onClick={exportCSV}>⬇️ Export CSV</button>
              <button className="btn-ghost" onClick={() => { setEditName(myName); setShowNameEdit(true) }}>
                ✏️ Edit my name
              </button>
            </div>
          )}

          {/* FAB */}
          {tab === 'expenses' && (
            <button className="fab" onClick={() => openAdd()}>＋</button>
          )}
        </div>
      )}

      {/* ══ SHEETS ══ */}

      {/* New group */}
      <Sheet open={showNewGroup} onClose={() => setShowNewGroup(false)} title="New group">
        <label>Name</label>
        <input className="input" autoFocus placeholder="e.g. Goa Trip" value={newGroupForm.name}
          onChange={e => setNewGroupForm(f => ({ ...f, name: e.target.value }))} />
        <label>Type</label>
        <div className="chip-row">
          {(['trip','home','couple','other'] as Group['type'][]).map(t => (
            <button key={t} className={`chip ${newGroupForm.type === t ? 'active' : ''}`}
              onClick={() => setNewGroupForm(f => ({ ...f, type: t }))}>{t}</button>
          ))}
        </div>
        <label>Currency</label>
        <select className="input" value={newGroupForm.currency}
          onChange={e => setNewGroupForm(f => ({ ...f, currency: e.target.value }))}>
          {CURRENCIES.map(c => <option key={c.code} value={c.code}>{c.code} {c.symbol} — {c.name}</option>)}
        </select>
        <button className="btn-primary" disabled={!newGroupForm.name.trim()} onClick={createGroup}>
          Create group
        </button>
      </Sheet>

      {/* Add / edit expense */}
      <Sheet open={showAddExp} onClose={() => setShowAddExp(false)} title={expForm.editId ? 'Edit expense' : 'Add expense'}>
        <label>Description</label>
        <input className="input" autoFocus placeholder="What's this for?" value={expForm.note}
          onChange={e => setExpForm(f => ({ ...f, note: e.target.value }))} />
        <label>Amount</label>
        <div className="amount-row">
          <span className="currency-badge">{group ? sym(group.currency) : '₹'}</span>
          <input className="input amount-input" type="number" min="0" step="0.01" placeholder="0.00"
            value={expForm.amount} onChange={e => setExpForm(f => ({ ...f, amount: e.target.value }))} />
        </div>
        <label>Category</label>
        <div className="chip-row wrap">
          {CATEGORIES.map(c => (
            <button key={c.id} className={`chip ${expForm.category === c.id ? 'active' : ''}`}
              onClick={() => setExpForm(f => ({ ...f, category: c.id }))}>
              {c.icon} {c.label}
            </button>
          ))}
        </div>
        <label>Paid by</label>
        <div className="chip-row">
          {members.map(m => (
            <button key={m.peerId} className={`chip ${expForm.payer === m.peerId ? 'active' : ''}`}
              onClick={() => setExpForm(f => ({ ...f, payer: m.peerId }))}>
              {pname(m.peerId)}
            </button>
          ))}
        </div>
        <label>Split</label>
        <div className="chip-row">
          {(['equal','exact','percent','shares'] as SplitMode[]).map(m => (
            <button key={m} className={`chip ${expForm.splitMode === m ? 'active' : ''}`}
              onClick={() => setExpForm(f => ({
                ...f, splitMode: m,
                splits: members.map(mb => ({ peerId: mb.peerId, value: m === 'percent' ? Math.round(100/members.length) : 1 }))
              }))}>
              {m}
            </button>
          ))}
        </div>
        {expForm.splitMode === 'equal' && (
          <>
            <label>Split among</label>
            <div className="chip-row">
              {members.map(m => {
                const inSplit = expForm.splits.length === 0 || expForm.splits.some(s => s.peerId === m.peerId)
                return (
                  <button key={m.peerId} className={`chip ${inSplit ? 'active' : ''}`}
                    onClick={() => setExpForm(f => {
                      const all = members.map(mb => ({ peerId: mb.peerId, value: 0 }))
                      if (f.splits.length === 0) return { ...f, splits: all.filter(s => s.peerId !== m.peerId) }
                      const has = f.splits.some(s => s.peerId === m.peerId)
                      const next = has ? f.splits.filter(s => s.peerId !== m.peerId) : [...f.splits, { peerId: m.peerId, value: 0 }]
                      return { ...f, splits: next.length === members.length ? [] : next }
                    })}>
                    {pname(m.peerId)}
                  </button>
                )
              })}
            </div>
          </>
        )}
        {expForm.splitMode !== 'equal' && (
          <div className="split-inputs">
            {expForm.splits.map((s, i) => (
              <div key={s.peerId} className="split-row">
                <span className="split-name">{pname(s.peerId)}</span>
                <input className="input split-val" type="number" min="0"
                  placeholder={expForm.splitMode === 'percent' ? '%' : expForm.splitMode === 'shares' ? 'shares' : sym(group?.currency ?? 'INR')}
                  value={s.value || ''}
                  onChange={e => {
                    const v = Number(e.target.value)
                    setExpForm(f => ({ ...f, splits: f.splits.map((x, j) => j === i ? { ...x, value: v } : x) }))
                  }} />
              </div>
            ))}
          </div>
        )}
        <button className="btn-primary" disabled={!expForm.amount} onClick={saveExp}>
          {expForm.editId ? 'Save changes' : 'Add expense'}
        </button>
      </Sheet>

      {/* Expense detail */}
      <Sheet open={showExpDetail} onClose={() => setShowExpDetail(false)} title="Expense">
        {viewExp && (
          <>
            <div className="exp-detail-hero">
              <span style={{ fontSize: 48 }}>{cat(viewExp.category).icon}</span>
              <div className="edh-note">{viewExp.note}</div>
              <div className="edh-amt">{S}{viewExp.amount.toFixed(2)}</div>
            </div>
            <div className="detail-meta">
              <div className="dm-row"><span>Paid by</span><strong>{pname(viewExp.payer)}</strong></div>
              <div className="dm-row"><span>Date</span><strong>{new Date(viewExp.ts).toLocaleDateString('en-IN',{dateStyle:'medium'})}</strong></div>
              <div className="dm-row"><span>Split</span><strong>{viewExp.splitMode}</strong></div>
            </div>
            <div className="shares-list">
              {resolveShares(viewExp).map(({ peerId, value }) => (
                <div key={peerId} className="share-row">
                  <Avatar name={pname(peerId)} size={28} />
                  <span className="shr-name">{pname(peerId)}</span>
                  <span className="shr-val">{S}{value.toFixed(2)}</span>
                </div>
              ))}
            </div>
            <div className="detail-actions">
              <button className="btn-secondary half" onClick={() => { setShowExpDetail(false); openAdd(viewExp.id) }}>✏️ Edit</button>
              <button className="btn-danger half" onClick={() => deleteExp(viewExp.id)}>🗑️ Delete</button>
            </div>
            <div className="comments">
              <div className="list-label">Comments</div>
              {(viewExp.comments ?? []).length === 0 && <p className="empty-hint">No comments yet.</p>}
              {(viewExp.comments ?? []).map(c => (
                <div key={c.id} className="comment-bubble">
                  <span className="cb-author">{pname(c.author)}</span>
                  <span className="cb-text">{c.text}</span>
                </div>
              ))}
              <div className="comment-input-row">
                <input className="input" placeholder="Add comment…" value={commentText}
                  onChange={e => setCommentText(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && addComment(viewExp.id)} />
                <button className="send-btn" onClick={() => addComment(viewExp.id)}>↑</button>
              </div>
            </div>
          </>
        )}
      </Sheet>

      {/* Settle up */}
      <Sheet open={showSettle} onClose={() => setShowSettle(false)} title="Record payment">
        <label>From</label>
        <select className="input" value={settleForm.from} onChange={e => setSettleForm(f => ({ ...f, from: e.target.value }))}>
          <option value="">Select…</option>
          {members.map(m => <option key={m.peerId} value={m.peerId}>{pname(m.peerId)}</option>)}
        </select>
        <label>To</label>
        <select className="input" value={settleForm.to} onChange={e => setSettleForm(f => ({ ...f, to: e.target.value }))}>
          <option value="">Select…</option>
          {members.map(m => <option key={m.peerId} value={m.peerId}>{pname(m.peerId)}</option>)}
        </select>
        <label>Amount</label>
        <input className="input" type="number" min="0" step="0.01" value={settleForm.amount}
          onChange={e => setSettleForm(f => ({ ...f, amount: e.target.value }))} />
        <label>Via (optional)</label>
        <input className="input" placeholder="UPI, cash, etc." value={settleForm.note}
          onChange={e => setSettleForm(f => ({ ...f, note: e.target.value }))} />
        <button className="btn-primary"
          disabled={!settleForm.from || !settleForm.to || !settleForm.amount || settleForm.from === settleForm.to}
          onClick={recordPayment}>
          Record payment ✓
        </button>
      </Sheet>

      {/* Charts */}
      <Sheet open={showCharts} onClose={() => setShowCharts(false)} title="Spending">
        {group && (
          <>
            <div className="chart-block">
              <div className="chart-label">My spending by category</div>
              <BarChart data={spendByCategory(grpExp, myPeerId)} symbol={S} />
            </div>
            <div className="chart-block">
              <div className="chart-label">Group total by category</div>
              <BarChart data={spendByCategory(grpExp, '*')} symbol={S} />
            </div>
            <div className="chart-block">
              <div className="chart-label">Member balances</div>
              {members.map(m => {
                const bal = balances[m.peerId] ?? 0
                const max = Math.max(...Object.values(balances).map(Math.abs), 1)
                return (
                  <div key={m.peerId} className="bal-bar-row">
                    <span className="bbn">{pname(m.peerId)}</span>
                    <div className="bbd"><div className={`bbar ${bal >= 0 ? 'pos' : 'neg'}`} style={{ width: `${Math.abs(bal)/max*100}%` }} /></div>
                    <span className={`bbv ${bal >= 0 ? 'pos' : 'neg'}`}>{bal >= 0 ? '+' : ''}{S}{bal.toFixed(2)}</span>
                  </div>
                )
              })}
            </div>
          </>
        )}
      </Sheet>

      {/* Invite sheet (person A) */}
      <Sheet open={showInvite} onClose={() => setShowInvite(false)} title="Invite to group">
        {!inviteUrl ? (
          <div className="loading-block"><div className="spinner" /><p>Generating link…</p></div>
        ) : (
          <>
            <p className="invite-hint">Share this link. When they open it, they'll send you back an answer link.</p>
            <div className="url-box">
              <span className="url-text">{inviteUrl.slice(0, 60)}…</span>
            </div>
            <div className="share-btns">
              <button className="btn-primary" onClick={() => nativeShare(`Join ${group?.name} on sHare`, inviteUrl)}>
                📤 Share invite link
              </button>
            </div>
            <div className="divider-text">After they reply, paste their answer link here</div>
            <input className="input" placeholder="Paste answer link…"
              onChange={e => {
                const val = e.target.value.trim()
                const hash = val.includes('#') ? val.slice(val.indexOf('#')) : val
                const parsed = parseAnswerHash(hash)
                if (parsed) doFinishConnect(parsed.groupId, parsed.answerSdp)
              }} />
          </>
        )}
      </Sheet>

      {/* Join sheet (person B, opened invite link) */}
      <Sheet open={showJoinSheet} onClose={() => setShowJoinSheet(false)} title="Join group">
        {inboundInvite && (
          <>
            {!answerUrl ? (
              <>
                <p className="invite-hint">You've been invited! Enter your name to join.</p>
                <label>Your name</label>
                <input className="input" autoFocus placeholder="Name" value={myName} onChange={e => setMyName(e.target.value)} />
                <button className="btn-primary" disabled={!myName.trim()}
                  onClick={() => doAcceptInvite(inboundInvite.groupId, inboundInvite.offerSdp)}>
                  Generate answer
                </button>
              </>
            ) : (
              <>
                <p className="invite-hint">Send this answer link back to the person who invited you.</p>
                <div className="url-box"><span className="url-text">{answerUrl.slice(0, 60)}…</span></div>
                <button className="btn-primary" onClick={() => nativeShare('sHare answer link', answerUrl)}>
                  📤 Share answer link
                </button>
                <button className="btn-ghost" onClick={() => setShowJoinSheet(false)}>Done</button>
              </>
            )}
          </>
        )}
      </Sheet>

      {/* Edit name */}
      <Sheet open={showNameEdit} onClose={() => setShowNameEdit(false)} title="Edit name">
        <input className="input" autoFocus value={editName} onChange={e => setEditName(e.target.value)} />
        <button className="btn-primary" disabled={!editName.trim()} onClick={() => {
          setMyName(editName)
          if (group) {
            setState(prev => ({
              ...prev,
              groups: prev.groups.map(g => ({
                ...g,
                members: g.members.map(m => m.peerId === myPeerId ? { ...m, name: editName } : m),
              }))
            }))
          }
          setShowNameEdit(false)
        }}>Save</button>
      </Sheet>

      <style>{css}</style>
    </div>
  )
}

// ─── CSS ──────────────────────────────────────────────────────────────────────
const css = `
@import url('https://fonts.googleapis.com/css2?family=Syne:wght@600;700;800&family=DM+Sans:wght@400;500;600&display=swap');

*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }

:root {
  --bg:      #0b0c10;
  --s1:      #13141a;
  --s2:      #1a1c24;
  --s3:      #22242f;
  --accent:  #5eead4;
  --a2:      #a78bfa;
  --pos:     #34d399;
  --neg:     #f87171;
  --text:    #e2e4ee;
  --muted:   #5c6070;
  --border:  rgba(255,255,255,0.07);
  --r:       16px;
  --rs:      10px;
}

body { background: var(--bg); color: var(--text); font-family: 'DM Sans', sans-serif; overscroll-behavior: none; -webkit-font-smoothing: antialiased; }
.app { min-height: 100dvh; max-width: 480px; margin: 0 auto; position: relative; }

/* ── Onboarding / empty ── */
.onboard { display: flex; flex-direction: column; gap: 16px; padding: 8px 0; }
.onboard-logo { font-family: 'Syne', sans-serif; font-weight: 800; font-size: 48px; text-align: center; }
.onboard-logo span { color: var(--accent); }
.onboard-sub { text-align: center; color: var(--muted); line-height: 1.6; font-size: 15px; }

.empty-home { display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100dvh; padding: 32px 24px; gap: 16px; text-align: center; }
.eh-logo { font-family: 'Syne', sans-serif; font-weight: 800; font-size: 52px; margin-bottom: 8px; }
.eh-logo span { color: var(--accent); }
.eh-greeting { font-family: 'Syne', sans-serif; font-weight: 700; font-size: 24px; }
.eh-sub { color: var(--muted); font-size: 15px; line-height: 1.6; max-width: 280px; }
.eh-peer { font-size: 12px; color: var(--muted); display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: center; margin-top: 8px; }
.peer-id-chip { color: var(--accent); font-size: 11px; }
.copy-link { background: none; border: none; color: var(--a2); cursor: pointer; font-size: 12px; padding: 0; text-decoration: underline; }

/* ── Main view ── */
.main-view { display: flex; flex-direction: column; min-height: 100dvh; }

.header { display: flex; align-items: center; padding: 12px 16px; background: var(--s1); border-bottom: 1px solid var(--border); position: sticky; top: 0; z-index: 5; }
.header-left { flex: 1; }
.header-title { font-family: 'Syne', sans-serif; font-weight: 700; font-size: 20px; }
.group-picker { background: none; border: none; color: var(--text); font-family: 'Syne', sans-serif; font-weight: 700; font-size: 18px; cursor: pointer; outline: none; max-width: 200px; }
.group-picker option { background: var(--s2); }
.header-right { display: flex; align-items: center; gap: 4px; }
.live-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); margin-right: 4px; transition: background 0.3s; }
.live-dot.on { background: var(--pos); box-shadow: 0 0 6px var(--pos); }
.hbtn { background: var(--s2); border: 1px solid var(--border); border-radius: 8px; color: var(--text); cursor: pointer; font-size: 16px; padding: 7px 10px; transition: border-color 0.15s; }
.hbtn:hover, .hbtn:active { border-color: var(--accent); }

/* ── Balance hero ── */
.balance-hero { margin: 16px; border-radius: var(--r); padding: 24px 20px 20px; display: flex; flex-direction: column; align-items: center; gap: 6px; }
.balance-hero.pos { background: linear-gradient(135deg, rgba(52,211,153,0.12), rgba(94,234,212,0.08)); border: 1px solid rgba(52,211,153,0.2); }
.balance-hero.neg { background: linear-gradient(135deg, rgba(248,113,113,0.12), rgba(167,139,250,0.06)); border: 1px solid rgba(248,113,113,0.2); }
.bh-label { font-size: 13px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; }
.bh-amount { font-family: 'Syne', sans-serif; font-weight: 800; font-size: 42px; letter-spacing: -1px; }
.balance-hero.pos .bh-amount { color: var(--pos); }
.balance-hero.neg .bh-amount { color: var(--neg); }
.bh-detail { display: flex; flex-wrap: wrap; gap: 6px; justify-content: center; margin-top: 4px; }
.bh-chip { font-size: 12px; padding: 4px 10px; border-radius: 20px; background: rgba(255,255,255,0.05); }
.bh-chip.pos { color: var(--pos); }
.bh-chip.neg { color: var(--neg); }
.bh-settle-btn { margin-top: 8px; background: var(--accent); color: #061a17; border: none; border-radius: 20px; cursor: pointer; font-family: 'Syne', sans-serif; font-weight: 700; font-size: 14px; padding: 10px 24px; }

/* ── Tab bar ── */
.tab-bar { display: flex; background: var(--s1); border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); }
.tab { flex: 1; background: none; border: none; color: var(--muted); cursor: pointer; font-family: 'DM Sans', sans-serif; font-size: 13px; padding: 12px 4px; transition: color 0.15s; }
.tab.active { color: var(--accent); border-bottom: 2px solid var(--accent); margin-bottom: -1px; }

/* ── Tab content ── */
.tab-content { flex: 1; padding: 12px 16px 100px; display: flex; flex-direction: column; gap: 10px; overflow-y: auto; }

.settled-all { text-align: center; padding: 60px 20px; color: var(--muted); }
.settled-all p { margin-top: 12px; font-size: 15px; }

.settle-card { display: flex; align-items: center; gap: 12px; background: var(--s1); border: 1px solid var(--border); border-radius: var(--r); padding: 14px; cursor: pointer; transition: border-color 0.15s; }
.settle-card:active { border-color: var(--accent); }
.sc-body { flex: 1; font-size: 14px; }
.sc-from { color: var(--neg); font-weight: 600; }
.sc-to   { color: var(--pos); font-weight: 600; }
.sc-arrow { color: var(--muted); }
.sc-right { text-align: right; }
.sc-amt { font-family: 'Syne', sans-serif; font-weight: 700; font-size: 17px; display: block; }
.sc-cta { font-size: 11px; color: var(--accent); }

.payments-list { background: var(--s1); border-radius: var(--r); overflow: hidden; }
.payment-row { display: flex; align-items: center; gap: 8px; padding: 12px 14px; border-top: 1px solid var(--border); font-size: 13px; }
.payment-row:first-of-type { border-top: none; }
.pr-from { color: var(--neg); }
.pr-arrow { color: var(--muted); }
.pr-to { color: var(--pos); flex: 1; }
.pr-amt { font-weight: 600; }
.pr-note { font-size: 11px; color: var(--muted); }

.exp-card { display: flex; align-items: center; gap: 12px; background: var(--s1); border: 1px solid var(--border); border-radius: var(--r); padding: 14px; cursor: pointer; transition: border-color 0.15s; }
.exp-card:active { border-color: var(--a2); }
.ec-icon { font-size: 26px; flex-shrink: 0; }
.ec-body { flex: 1; min-width: 0; }
.ec-note { font-weight: 600; font-size: 15px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ec-sub { font-size: 12px; color: var(--muted); margin-top: 3px; }
.ec-right { text-align: right; flex-shrink: 0; }
.ec-total { font-family: 'Syne', sans-serif; font-weight: 700; font-size: 16px; }
.ec-share { font-size: 11px; margin-top: 3px; }
.ec-share.lent { color: var(--pos); }
.ec-share.owe  { color: var(--neg); }

.member-card { display: flex; align-items: center; gap: 12px; background: var(--s1); border: 1px solid var(--border); border-radius: var(--r); padding: 14px; }
.mc-body { flex: 1; }
.mc-name { font-weight: 600; font-size: 15px; }
.mc-status { font-size: 12px; color: var(--muted); margin-top: 3px; }
.mc-bal { font-family: 'Syne', sans-serif; font-weight: 700; font-size: 16px; }
.mc-bal.pos { color: var(--pos); }
.mc-bal.neg { color: var(--neg); }

.list-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.09em; color: var(--muted); padding: 4px 0; }
.empty-tab { text-align: center; padding: 60px 20px; color: var(--muted); display: flex; flex-direction: column; align-items: center; gap: 12px; }

/* ── FAB ── */
.fab { position: fixed; bottom: 28px; right: 24px; width: 58px; height: 58px; border-radius: 50%; background: var(--accent); border: none; color: #061a17; font-size: 28px; font-weight: 300; cursor: pointer; box-shadow: 0 4px 24px rgba(94,234,212,0.35); display: flex; align-items: center; justify-content: center; z-index: 10; transition: transform 0.15s, box-shadow 0.15s; }
.fab:active { transform: scale(0.93); box-shadow: 0 2px 12px rgba(94,234,212,0.2); }

/* ── Sheet ── */
.sheet-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.6); z-index: 100; display: flex; align-items: flex-end; backdrop-filter: blur(4px); }
.sheet { background: var(--s1); border-radius: 24px 24px 0 0; width: 100%; max-height: 92dvh; display: flex; flex-direction: column; animation: slideUp 0.22s ease-out; }
@keyframes slideUp { from { transform: translateY(100%); opacity: 0 } to { transform: none; opacity: 1 } }
.sheet-handle { width: 40px; height: 4px; border-radius: 2px; background: var(--s3); margin: 12px auto 0; flex-shrink: 0; }
.sheet-header { display: flex; align-items: center; padding: 12px 20px 10px; flex-shrink: 0; }
.sheet-title { font-family: 'Syne', sans-serif; font-weight: 700; font-size: 18px; flex: 1; }
.sheet-close { background: var(--s2); border: none; border-radius: 50%; color: var(--muted); cursor: pointer; font-size: 14px; width: 30px; height: 30px; display: flex; align-items: center; justify-content: center; }
.sheet-body { overflow-y: auto; padding: 8px 20px 40px; display: flex; flex-direction: column; gap: 14px; -webkit-overflow-scrolling: touch; }

/* ── Forms inside sheets ── */
.sheet-body label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); margin-bottom: -6px; }
.input { background: var(--s2); border: 1px solid var(--border); border-radius: var(--rs); color: var(--text); font-family: 'DM Sans', sans-serif; font-size: 15px; padding: 13px 14px; outline: none; width: 100%; transition: border-color 0.15s; -webkit-appearance: none; }
.input:focus { border-color: var(--accent); }
select.input { cursor: pointer; }
.amount-row { display: flex; align-items: center; gap: 8px; }
.currency-badge { background: var(--s3); border-radius: var(--rs); color: var(--accent); font-family: 'Syne', sans-serif; font-weight: 700; font-size: 16px; padding: 12px 14px; flex-shrink: 0; }
.amount-input { flex: 1; }
.chip-row { display: flex; flex-wrap: wrap; gap: 7px; }
.chip { background: var(--s2); border: 1px solid var(--border); border-radius: 20px; color: var(--muted); cursor: pointer; font-size: 13px; padding: 7px 14px; transition: all 0.12s; white-space: nowrap; }
.chip.active { background: rgba(94,234,212,0.12); border-color: var(--accent); color: var(--accent); }
.split-inputs { background: var(--s2); border-radius: var(--rs); padding: 12px; display: flex; flex-direction: column; gap: 10px; }
.split-row { display: flex; align-items: center; gap: 10px; }
.split-name { flex: 1; font-size: 14px; }
.split-val { width: 90px; flex-shrink: 0; }

.btn-primary { background: var(--accent); color: #061a17; border: none; border-radius: var(--rs); cursor: pointer; font-family: 'Syne', sans-serif; font-weight: 700; font-size: 16px; padding: 15px; width: 100%; transition: opacity 0.15s; }
.btn-primary:hover { opacity: 0.9; }
.btn-primary:disabled { opacity: 0.35; cursor: not-allowed; }
.btn-primary.small { width: auto; padding: 10px 18px; font-size: 14px; }
.btn-secondary { background: var(--s2); border: 1px solid var(--border); border-radius: var(--rs); color: var(--text); cursor: pointer; font-family: 'Syne', sans-serif; font-weight: 600; font-size: 15px; padding: 14px; width: 100%; transition: border-color 0.15s; }
.btn-secondary:hover { border-color: var(--accent); }
.btn-secondary.half { width: calc(50% - 4px); }
.btn-danger { background: rgba(248,113,113,0.1); border: 1px solid rgba(248,113,113,0.3); border-radius: var(--rs); color: var(--neg); cursor: pointer; font-family: 'Syne', sans-serif; font-weight: 600; font-size: 15px; padding: 14px; width: 100%; }
.btn-danger.half { width: calc(50% - 4px); }
.btn-ghost { background: none; border: none; color: var(--muted); cursor: pointer; font-size: 14px; padding: 10px 0; text-align: center; width: 100%; }
.btn-ghost:hover { color: var(--text); }
.detail-actions { display: flex; gap: 8px; }

/* ── Expense detail ── */
.exp-detail-hero { text-align: center; padding: 8px 0 16px; }
.edh-note { font-family: 'Syne', sans-serif; font-weight: 700; font-size: 22px; margin-top: 10px; }
.edh-amt { font-family: 'Syne', sans-serif; font-weight: 800; font-size: 38px; color: var(--accent); margin-top: 6px; }
.detail-meta { background: var(--s2); border-radius: var(--rs); padding: 4px 0; }
.dm-row { display: flex; justify-content: space-between; padding: 10px 14px; border-bottom: 1px solid var(--border); font-size: 14px; }
.dm-row:last-child { border-bottom: none; }
.dm-row span { color: var(--muted); }
.shares-list { background: var(--s2); border-radius: var(--rs); padding: 8px 14px; display: flex; flex-direction: column; gap: 10px; }
.share-row { display: flex; align-items: center; gap: 10px; font-size: 14px; }
.shr-name { flex: 1; }
.shr-val { font-weight: 600; }

/* ── Comments ── */
.comments { display: flex; flex-direction: column; gap: 10px; }
.comment-bubble { background: var(--s2); border-radius: var(--rs); padding: 10px 12px; }
.cb-author { font-size: 11px; color: var(--accent); display: block; margin-bottom: 4px; font-weight: 600; }
.cb-text { font-size: 14px; }
.comment-input-row { display: flex; gap: 8px; }
.comment-input-row .input { flex: 1; }
.send-btn { background: var(--accent); border: none; border-radius: var(--rs); color: #061a17; cursor: pointer; font-size: 18px; font-weight: 700; padding: 0 16px; }
.empty-hint { color: var(--muted); font-size: 13px; }

/* ── Invite ── */
.invite-hint { color: var(--muted); font-size: 14px; line-height: 1.6; }
.url-box { background: var(--s2); border-radius: var(--rs); padding: 14px; word-break: break-all; }
.url-text { font-size: 11px; color: var(--accent); }
.share-btns { display: flex; gap: 8px; }
.divider-text { text-align: center; font-size: 12px; color: var(--muted); }
.loading-block { display: flex; flex-direction: column; align-items: center; gap: 16px; padding: 32px; }
.spinner { width: 32px; height: 32px; border: 3px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.7s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

/* ── Charts ── */
.chart-block { display: flex; flex-direction: column; gap: 12px; }
.chart-label { font-family: 'Syne', sans-serif; font-weight: 600; font-size: 15px; }
.bar-chart { display: flex; flex-direction: column; gap: 10px; }
.bar-row { display: flex; align-items: center; gap: 10px; }
.bar-icon { font-size: 20px; width: 28px; flex-shrink: 0; }
.bar-track { flex: 1; background: var(--s2); border-radius: 4px; height: 10px; overflow: hidden; }
.bar-fill { height: 100%; background: var(--accent); border-radius: 4px; transition: width 0.5s; }
.bar-val { font-size: 13px; font-weight: 600; width: 60px; text-align: right; }
.bal-bar-row { display: flex; align-items: center; gap: 10px; }
.bbn { width: 64px; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex-shrink: 0; }
.bbd { flex: 1; background: var(--s2); border-radius: 4px; height: 10px; overflow: hidden; }
.bbar { height: 100%; border-radius: 4px; transition: width 0.4s; }
.bbar.pos { background: var(--pos); }
.bbar.neg { background: var(--neg); }
.bbv { font-size: 12px; width: 60px; text-align: right; font-weight: 600; }
.bbv.pos { color: var(--pos); }
.bbv.neg { color: var(--neg); }
.pos { color: var(--pos); }
.neg { color: var(--neg); }
`

import React, { useState, useEffect, useRef, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { db } from '../firebase.js'
import {
  ref, onValue, get, set, update, remove,
  serverTimestamp, runTransaction, onDisconnect
} from 'firebase/database'
import { FEE, PAY, MIN_PLAYERS, MAX_CARDS, sanitizeKey } from '../utils.js'

const MOBILE_TIMER_SEC = 20;

let svrOff = 0
onValue(ref(db, '.info/serverTimeOffset'), s => { svrOff = s.val() || 0 })
const now = () => Date.now() + svrOff

function getUser() {
  try { return JSON.parse(localStorage.getItem('bingoUser') || 'null') } catch { return null }
}

/**
 * Super Ultra-Compact Mini Card Viewport
 * Drastically drops DOM element counts and node depth for performance.
 */
function MiniMobileCard({ data, id, onRemove }) {
  if (!data) return <div style={{ color: '#aaa', padding: '4px', textAlign: 'center', fontSize: '10px' }}>...</div>
  const cols = ['b', 'i', 'n', 'g', 'o']
  return (
    <div style={{ 
      background: 'rgba(20, 20, 25, 0.85)', 
      backdropFilter: 'blur(6px)',
      borderRadius: '8px', 
      padding: '6px', 
      border: '1px solid rgba(255, 255, 255, 0.06)',
      position: 'relative'
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
        <span style={{ color: '#4ade80', fontWeight: '800', fontSize: '10px' }}>#{id}</span>
        <button 
          onClick={(e) => { e.stopPropagation(); onRemove(id); }}
          style={{ background: 'rgba(239, 68, 68, 0.2)', color: '#ef4444', border: 'none', borderRadius: '4px', padding: '1px 4px', fontSize: '8px', fontWeight: 'bold', cursor: 'pointer' }}
        >
          ✕
        </button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '1px', background: 'rgba(255,255,255,0.02)', padding: '2px', borderRadius: '4px' }}>
        {cols.map((col, c) => {
          const colData = data[col] || data[col.toUpperCase()] || [];
          return Array.from({ length: 5 }, (_, r) => {
            if (c === 2 && r === 2) {
              return <div key={`${c}-${r}`} style={{ background: '#ec4899', color: '#fff', fontSize: '8px', textAlign: 'center', borderRadius: '1px' }}>★</div>
            }
            const targetIdx = (c === 2 && r > 2) ? r - 1 : r;
            const val = colData[targetIdx] ?? '';
            return (
              <div key={`${c}-${r}`} style={{ color: '#e2e8f0', fontSize: '8px', textAlign: 'center', background: 'rgba(255,255,255,0.03)', padding: '1px 0', borderRadius: '1px' }}>
                {val}
              </div>
            );
          });
        })}
      </div>
    </div>
  )
}

/**
 * Standard Compact Matrix Viewport (Fallback when only 1 selection exists)
 */
function FullMobileCard({ data, id }) {
  if (!data) return <div style={{ color: '#aaa', padding: '6px', textAlign: 'center', fontSize: '11px' }}>Loading Matrix...</div>
  const cols = ['b', 'i', 'n', 'g', 'o']
  return (
    <div style={{ width: '100%', background: 'rgba(25, 25, 25, 0.65)', backdropFilter: 'blur(8px)', borderRadius: '12px', padding: '8px', border: '1px solid rgba(255, 255, 255, 0.08)' }}>
      <div style={{ color: '#4ade80', fontWeight: '800', fontSize: '11px', marginBottom: '6px', textAlign: 'center' }}>CARD #{id}</div>
      <table style={{ width: '100%', borderCollapse: 'separate', borderSpacing: '2px', fontSize: '11px', color: '#fff', textAlign: 'center', fontWeight: '700' }}>
        <thead>
          <tr>
            {cols.map(l => (
              <th key={l} style={{ padding: '2px 0', color: l === 'n' ? '#facc15' : '#4ade80', fontSize: '11px', background: 'rgba(255,255,255,0.03)', borderRadius: '4px' }}>{l}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: 5 }, (_, r) => (
            <tr key={r}>
              {cols.map((col, c) => {
                if (c === 2 && r === 2) return <td key={c} style={{ background: '#ec4899', borderRadius: '4px', padding: '4px 0' }}>★</td>
                const colData = data[col] || data[col.toUpperCase()] || []
                const v = c === 2 ? colData[r < 2 ? r : r - 1] ?? '' : colData[r] ?? ''
                return <td key={c} style={{ padding: '4px 0', background: 'rgba(255, 255, 255, 0.05)', borderRadius: '4px', color: '#e2e8f0' }}>{v}</td>
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default function CartelaPage() {
  const navigate = useNavigate()
  const user = getUser()

  useEffect(() => {
    if (!user) navigate('/', { replace: true })
  }, [user, navigate])

  const rawKey = (user?.telegram_id || user?.phone || '').toString()
  const playerKey = useMemo(() => sanitizeKey(rawKey), [rawKey])

  // Component State
  const [allCards, setAllCards]           = useState({})
  const [taken, setTaken]                 = useState({})
  const [selectedCards, setSelectedCards] = useState([])
  const [bal, setBal]                     = useState(0)
  const [profileName, setProfileName]     = useState(user?.name || 'Player')
  const [profileLbl, setProfileLbl]       = useState('@player')
  const [pCount, setPCount]               = useState(0)
  const [joined, setJoined]               = useState(false)
  const [gameActive, setGameActive]       = useState(false)
  const [cdSec, setCdSec]                 = useState(null)
  const [prize, setPrize]                 = useState(0)
  const [gameNum, setGameNum]             = useState('--')
  const [loading, setLoading]             = useState(true)
  const [wasDisconnected, setWasDisconnected] = useState(false)
  const [waitingForPlayers, setWaitingForPlayers] = useState(false)

  // Atomic Context Tracking for Thread Safety
  const stateRef = useRef({})
  stateRef.current = { selectedCards, joined, gameActive, pCount, bal, taken, prize }

  const cdTimer = useRef(null)
  const pendingOp = useRef(false)
  const gameIdRef = useRef(null)
  const gameNumRef = useRef(1)

  // Pull static matrix entries once
  useEffect(() => {
    if (!user) return
    get(ref(db, 'cartelas')).then(snap => {
      if (snap.exists()) {
        const data = snap.val()
        const mapped = {}
        Object.keys(data).forEach(k => { mapped[Number(k)] = data[k] })
        setAllCards(mapped)
      }
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [user])

  // Realtime Database Frame Subscriptions
  useEffect(() => {
    if (!user || !playerKey) return

    const unsubscribes = [
      onValue(ref(db, `users/${playerKey}`), snap => {
        if (snap.exists()) {
          const u = snap.val()
          setBal(u.balance ?? 0)
          setProfileName(u.first_name || u.name || 'Player')
          if (u.username) setProfileLbl('@' + u.username)
        }
      }),

      onValue(ref(db, 'lobby/takenCards'), snap => {
        setTaken(snap.val() || {})
      }),

      onValue(ref(db, 'lobby/players'), snap => {
        const data = snap.val() || {}
        const activePlayerCount = Object.keys(data).length
        setPCount(activePlayerCount)
        const updatedPrize = Math.floor(activePlayerCount * FEE * PAY)
        setPrize(updatedPrize)

        if (!stateRef.current.gameActive) {
          if (activePlayerCount >= MIN_PLAYERS) {
            setWaitingForPlayers(false)
            checkAndStartTimer(updatedPrize)
          } else {
            setWaitingForPlayers(stateRef.current.joined)
            stopCountdown()
            remove(ref(db, 'lobby/gameStartAt')).catch(() => {})
          }
        }
      }),

      onValue(ref(db, 'lobby/currentGameNum'), snap => {
        if (snap.val()) setGameNum(snap.val())
      }),

      onValue(ref(db, 'lobby/gameStartAt'), snap => {
        const t = snap.val()
        if (!t) { stopCountdown(); return }
        if (stateRef.current.gameActive) return
        const rem = Math.ceil((t - now()) / 1000)
        if (rem > 0 && rem <= MOBILE_TIMER_SEC + 5) startCountdown(rem)
        else if (rem <= 0) triggerGameStart()
      }),

      onValue(ref(db, 'activeGame/ended'), snap => {
        if (snap.val() === true) resetLobby()
      }),

      onValue(ref(db, 'game/status'), snap => {
        if (snap.val() === 'started' && !stateRef.current.gameActive) {
          setGameActive(true)
          navigate(stateRef.current.joined ? '/game' : '/game?spectator=true')
        }
      })
    ]

    return () => unsubscribes.forEach(unsub => unsub())
  }, [playerKey, navigate, user])

  // Sync state & handle session re-entries
  useEffect(() => {
    if (!user || Object.keys(allCards).length === 0) return
    async function restoreSession() {
      const snap = await get(ref(db, `lobby/players/${playerKey}`))
      if (!snap.exists()) return
      const pData = snap.val()
      gameIdRef.current = pData.gameId
      const numSnap = await get(ref(db, 'lobby/currentGameNum'))
      gameNumRef.current = numSnap.val() || 1
      setGameNum(gameNumRef.current)
      
      const nums = pData.cartelas || []
      const restored = nums.map(id => ({ id: parseInt(id), data: allCards[id] }))
      setSelectedCards(restored)
      setJoined(true)
      setWasDisconnected(true)
      saveLocal(nums, restored.map(c => c.data), stateRef.current.prize)

      const presRef = ref(db, `lobby/presence/${playerKey}`)
      set(presRef, true)
      onDisconnect(presRef).remove()
    }
    restoreSession()
  }, [allCards, playerKey, user])

  async function getOrCreateGameId() {
    if (gameIdRef.current) return gameIdRef.current
    const snap = await get(ref(db, 'lobby/currentGameId'))
    let gid = snap.val()
    if (!gid) {
      gid = `BNG-${Math.random().toString(36).substring(2, 10).toUpperCase()}`
      const txn = await runTransaction(ref(db, 'meta/gameCounter'), c => (c || 0) + 1)
      gameNumRef.current = txn.snapshot.val()
      await Promise.all([
        set(ref(db, 'lobby/currentGameId'), gid),
        set(ref(db, 'lobby/currentGameNum'), gameNumRef.current)
      ])
    } else {
      const numSnap = await get(ref(db, 'lobby/currentGameNum'))
      gameNumRef.current = numSnap.val() || 1
    }
    gameIdRef.current = gid
    setGameNum(gameNumRef.current)
    return gid
  }

  function saveLocal(nums, cardsData, prizeAmt) {
    localStorage.setItem('selectedCartelas',  JSON.stringify(cardsData))
    localStorage.setItem('cartelaNumbers',    JSON.stringify(nums))
    localStorage.setItem('selectedCartela',   JSON.stringify(cardsData[0]))
    localStorage.setItem('cartelaNumber',     nums[0])
    localStorage.setItem('userName',          user.name || 'Player')
    localStorage.setItem('userId',            playerKey)
    localStorage.setItem('entryFee',          FEE)
    localStorage.setItem('currentGameId',     gameIdRef.current)
    localStorage.setItem('currentGameNum',    gameNumRef.current)
    localStorage.setItem('prizePool',         prizeAmt.toString())
    localStorage.setItem('numPlayers',        stateRef.current.pCount.toString())
  }

  async function joinWithCards(cards) {
    if (pendingOp.current || !cards.length || stateRef.current.bal < FEE) return
    pendingOp.current = true
    await getOrCreateGameId()
    try {
      const txn = await runTransaction(ref(db, `users/${playerKey}/balance`), b =>
        (b || 0) >= FEE ? b - FEE : undefined
      )
      if (!txn.committed) throw new Error('Insufficient balance')
      const cardNumbers = cards.map(c => c.id)
      const cardsData   = cards.map(c => c.data)
      const updates = {}
      cards.forEach(c => { updates[`lobby/takenCards/${c.id}`] = playerKey })
      updates[`lobby/players/${playerKey}`] = {
        name: user.name || 'Player',
        cartelas: cardNumbers,
        phone: user.phone || '',
        joinedAt: serverTimestamp(),
        gameId: gameIdRef.current,
        cardCount: cards.length,
        active: true
      }
      updates[`lobby/playerCards/${playerKey}`] = { cardNumbers, cardsData, gameId: gameIdRef.current }
      await update(ref(db), updates)

      const simCount = stateRef.current.pCount === 0 ? 1 : stateRef.current.pCount
      const projectedPrize = Math.floor(simCount * FEE * PAY)

      saveLocal(cardNumbers, cardsData, projectedPrize)
      setJoined(true)
      const presRef = ref(db, `lobby/presence/${playerKey}`)
      set(presRef, true)
      onDisconnect(presRef).remove()

      if (simCount >= MIN_PLAYERS) {
        await checkAndStartTimer(projectedPrize)
        setWaitingForPlayers(false)
      } else {
        setWaitingForPlayers(true)
      }
    } catch (e) {
      console.error(e)
    } finally {
      pendingOp.current = false
    }
  }

  async function removeCard(id, currentSelected) {
    if (stateRef.current.gameActive || pendingOp.current) return
    pendingOp.current = true
    // Optimistic state change to keep UI fully responsive
    const newSelected = currentSelected.filter(c => c.id !== id);
    setSelectedCards(newSelected);

    try {
      await runTransaction(ref(db, `users/${playerKey}/balance`), b => (b || 0) + FEE)
      const updates = {}
      updates[`lobby/takenCards/${id}`] = null
      if (!newSelected.length) {
        updates[`lobby/players/${playerKey}`]    = null
        updates[`lobby/playerCards/${playerKey}`] = null
        updates[`lobby/presence/${playerKey}`]   = null
        setJoined(false)
        setWaitingForPlayers(false)
        stopCountdown()
        await remove(ref(db, 'lobby/gameStartAt'))
      } else {
        const cardNumbers = newSelected.map(c => c.id)
        const cardsData   = newSelected.map(c => c.data)
        updates[`lobby/players/${playerKey}/cartelas`]  = cardNumbers
        updates[`lobby/players/${playerKey}/cardCount`] = newSelected.length
        updates[`lobby/playerCards/${playerKey}`] = { cardNumbers, cardsData, gameId: gameIdRef.current }
      }
      await update(ref(db), updates)
    } catch (e) {
      console.error(e)
    } finally {
      pendingOp.current = false
    }
  }

  async function onCardTap(id) {
    const { gameActive: ga, taken: tk, selectedCards: sc } = stateRef.current
    if (ga || pendingOp.current) return
    if (tk[id] && tk[id] !== playerKey) return
    
    const alreadyIdx = sc.findIndex(c => c.id === id)
    if (alreadyIdx !== -1) {
      if (stateRef.current.joined) await removeCard(id, sc)
      else setSelectedCards(prev => prev.filter(c => c.id !== id))
      return
    }
    if (sc.length >= MAX_CARDS) return

    const newCard = { id, data: allCards[id] || { b:[], i:[], n:[], g:[], o:[] } }
    const nextSelected = [...sc, newCard]
    
    // Smooth, dynamic visual feedback
    setSelectedCards(nextSelected)
    await joinWithCards(nextSelected)
  }

  async function checkAndStartTimer(currentPrize) {
    if (stateRef.current.gameActive || stateRef.current.pCount < MIN_PLAYERS) return
    const startAtSnap = await get(ref(db, 'lobby/gameStartAt'))
    if (startAtSnap.val()) {
      const rem = Math.ceil((startAtSnap.val() - now()) / 1000)
      if (rem > 0 && rem <= MOBILE_TIMER_SEC + 5) { startCountdown(rem); return }
    }
    const startAt = now() + MOBILE_TIMER_SEC * 1000
    await update(ref(db), {
      'lobby/gameStartAt': startAt,
      'game/meta': { gameId: gameIdRef.current, gameNum: gameNumRef.current, startTime: startAt, status: 'waiting', prizePool: currentPrize }
    })
    startCountdown(MOBILE_TIMER_SEC)
  }

  function startCountdown(sec) {
    if (cdTimer.current) clearInterval(cdTimer.current)
    setCdSec(Math.max(sec, 0))
    let t = Math.max(sec, 0)
    cdTimer.current = setInterval(() => {
      t--
      setCdSec(t)
      if (t <= 0) { clearInterval(cdTimer.current); cdTimer.current = null; triggerGameStart() }
    }, 1000)
  }

  function stopCountdown() {
    if (cdTimer.current) { clearInterval(cdTimer.current); cdTimer.current = null }
    setCdSec(null)
  }

  async function triggerGameStart() {
    if (stateRef.current.gameActive) return
    if (stateRef.current.pCount < MIN_PLAYERS) { stopCountdown(); return }
    setGameActive(true)
    localStorage.setItem('prizePool',  stateRef.current.prize.toString())
    localStorage.setItem('numPlayers', stateRef.current.pCount.toString())
    if (stateRef.current.joined) {
      await update(ref(db), { 'game/status': 'started', 'game/meta/started': true })
      navigate('/game')
    } else {
      navigate('/game?spectator=true')
    }
  }

  function resetLobby() {
    setSelectedCards([])
    setJoined(false)
    setGameActive(false)
    setWasDisconnected(false)
    setWaitingForPlayers(false)
    stopCountdown()
  }

  if (!user) return null

  const numbersArray = Array.from({ length: 450 }, (_, i) => i + 1)
  const timerUrgent = cdSec !== null && cdSec <= 10
  const playersNeeded = Math.max(0, MIN_PLAYERS - pCount)

  return (
    <div style={{ background: '#09090b', minHeight: '100vh', display: 'flex', flexDirection: 'column', color: '#fafafa', fontFamily: 'system-ui, sans-serif', overflow: 'hidden' }}>
      
      {/* Structural Stylesheet Injection to avoid heavy inline calculation loops */}
      <style>{`
        .num-btn {
          padding: 6px 0;
          font-size: 11px;
          font-weight: 800;
          border-radius: 5px;
          cursor: pointer;
          text-align: center;
          transition: all 0.1s ease;
          background: rgba(255,255,255,0.03);
          color: #cbd5e1;
          border: 1px solid rgba(255,255,255,0.05);
        }
        .num-btn[data-state="mine"] {
          background: #ffffff !important;
          color: #0a0a0a !important;
          border-color: #4ade80 !important;
          box-shadow: 0 0 8px rgba(74, 222, 128, 0.4);
        }
        .num-btn[data-state="taken"] {
          background: #1e1111 !important;
          color: #ef4444 !important;
          opacity: 0.2;
          cursor: not-allowed;
        }
        .num-btn[data-state="locked"] {
          background: #141414 !important;
          color: #444 !important;
          cursor: not-allowed;
        }
        .num-btn:active:not([data-state="taken"]) {
          transform: scale(0.92);
        }
      `}</style>

      {loading && (
        <div style={{ background: 'rgba(9,9,11,0.95)', position: 'fixed', inset: 0, zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ textAlign: 'center' }}>
            <div style={{ width: '32px', height: '32px', border: '3px solid rgba(255,255,255,0.1)', borderTopColor: '#4ade80', borderRadius: '50%', animation: 'spin 1s linear infinite', margin: '0 auto 12px' }} />
            <div style={{ fontSize: '10px', letterSpacing: '1px', color: '#a1a1aa' }}>LOADING PLATFORM CORE DATA...</div>
          </div>
        </div>
      )}

      {/* Top Navigation Control Bar */}
      <nav style={{ flexShrink: 0, background: 'rgba(18, 18, 24, 0.8)', backdropFilter: 'blur(12px)', borderBottom: '1px solid rgba(255,255,255,0.06)', padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#4ade80', boxShadow: '0 0 8px #4ade80' }} />
            <span style={{ fontSize: '13px', fontWeight: '800' }}>{profileName}</span>
            <span style={{ fontSize: '11px', color: '#71717a' }}>{profileLbl}</span>
          </div>
          <div style={{ background: 'rgba(74, 222, 128, 0.1)', border: '1px solid rgba(74, 222, 128, 0.2)', borderRadius: '20px', padding: '3px 10px', fontSize: '12px', fontWeight: '800', color: '#4ade80' }}>
            {Number(bal).toFixed(2)} <span style={{ fontSize: '9px', fontWeight: '500' }}>ETB</span>
          </div>
        </div>

        <div style={{ display: 'flex', gap: '6px' }}>
          <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.05)', borderRadius: '6px', padding: '3px 8px', display: 'flex', flexDirection: 'column', minWidth: '55px' }}>
            <span style={{ fontSize: '8px', color: '#71717a' }}>STAKE</span>
            <span style={{ fontSize: '11px', fontWeight: '700' }}>{FEE}</span>
          </div>
          <div style={{ background: 'rgba(234, 179, 8, 0.05)', border: '1px solid rgba(234, 179, 8, 0.15)', borderRadius: '6px', padding: '3px 8px', display: 'flex', flexDirection: 'column', minWidth: '70px' }}>
            <span style={{ fontSize: '8px', color: '#eab308' }}>DERASH</span>
            <span style={{ fontSize: '11px', fontWeight: '800', color: '#eab308' }}>{prize}</span>
          </div>
          <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.05)', borderRadius: '6px', padding: '3px 8px', display: 'flex', flexDirection: 'column', minWidth: '55px' }}>
            <span style={{ fontSize: '8px', color: '#71717a' }}>GAME</span>
            <span style={{ fontSize: '11px', fontWeight: '700', color: '#38bdf8' }}>#{gameNum}</span>
          </div>
          
          <div style={{ marginLeft: 'auto', background: timerUrgent ? 'rgba(239, 68, 68, 0.15)' : 'rgba(255,255,255,0.03)', border: timerUrgent ? '1px solid #ef4444' : '1px solid rgba(255,255,255,0.05)', borderRadius: '6px', padding: '3px 12px', display: 'flex', alignItems: 'center', justifyContent: 'center', minWidth: '45px' }}>
            <span style={{ fontSize: '13px', fontWeight: '900', color: timerUrgent ? '#ef4444' : '#fafafa' }}>
              {cdSec !== null ? `${cdSec}s` : '--'}
            </span>
          </div>
        </div>
      </nav>

      {/* Main Micro-Sized Grid Viewport */}
      <div style={{ flex: '1 1 auto', overflowY: 'auto', padding: '8px' }}>
        <div style={{ display: 'flex', gap: '6px', alignItems: 'center', marginBottom: '8px' }}>
          <div style={{ background: 'rgba(56, 189, 248, 0.1)', border: '1px solid rgba(56, 189, 248, 0.2)', color: '#38bdf8', fontSize: '10px', fontWeight: '700', padding: '2px 6px', borderRadius: '4px' }}>
            👥 {pCount} Active
          </div>
          {wasDisconnected && joined && (
            <div style={{ background: '#ca8a04', color: '#fff', fontSize: '10px', fontWeight: '700', padding: '2px 6px', borderRadius: '4px' }}>✓ Reconnected</div>
          )}
          {waitingForPlayers && cdSec === null && (
            <div style={{ color: '#a1a1aa', fontSize: '10px', fontWeight: '500', marginLeft: 'auto' }}>
              ⏳ Need {playersNeeded} more to start
            </div>
          )}
        </div>

        {/* Compact 12-Column Responsive Board Layout */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(12, 1fr)',
          gap: '3px',
          background: 'rgba(255,255,255,0.01)',
          padding: '4px',
          borderRadius: '8px',
          border: '1px solid rgba(255,255,255,0.03)'
        }}>
          {numbersArray.map(id => {
            let stateAttr = "open";
            if (selectedCards.some(c => c.id === id) || (taken[id] && taken[id] === playerKey)) stateAttr = "mine";
            else if (taken[id]) stateAttr = "taken";
            else if (gameActive) stateAttr = "locked";

            return (
              <button
                key={id}
                className="num-btn"
                data-state={stateAttr}
                disabled={stateAttr === "taken" || stateAttr === "locked"}
                onClick={() => onCardTap(id)}
              >
                {id}
              </button>
            )
          })}
        </div>
      </div>

      {/* Dynamic Drawer Context Layout Switcher */}
      <div style={{ flexShrink: 0, borderTop: '1px solid rgba(255,255,255,0.08)', background: 'linear-gradient(to top, #040406, #0c0c0e)', padding: '10px 12px 16px', maxHeight: '280px', overflowY: 'auto' }}>
        {selectedCards.length === 0 ? (
          <span style={{ display: 'block', padding: '20px', textAlign: 'center', color: '#52525b', fontSize: '11px' }}>
            Tap an available card number above to purchase and preview matrix
          </span>
        ) : selectedCards.length === 1 ? (
          /* Single Selection: Display Detailed Layout */
          <div style={{ position: 'relative' }}>
            <button
              onClick={(e) => { e.stopPropagation(); onCardTap(selectedCards[0].id); }}
              style={{ position: 'absolute', top: '8px', right: '8px', background: '#ef4444', color: 'white', border: 'none', borderRadius: '4px', padding: '2px 6px', cursor: 'pointer', fontSize: '9px', fontWeight: '800', zIndex: '10' }}
            >
              REMOVE
            </button>
            <FullMobileCard id={selectedCards[0].id} data={allCards[selectedCards[0].id]} />
          </div>
        ) : (
          /* Two or More Selections: Switch to Mini Grid Viewport Layout */
          <div>
            <div style={{ fontSize: '10px', color: '#a1a1aa', fontWeight: '700', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              Selected Matrices ({selectedCards.length})
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '8px' }}>
              {selectedCards.map(c => (
                <MiniMobileCard 
                  key={c.id} 
                  id={c.id} 
                  data={allCards[c.id]} 
                  onRemove={(targetId) => onCardTap(targetId)} 
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
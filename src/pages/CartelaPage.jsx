import React, { useState, useEffect, useRef, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { db } from '../firebase.js'
import {
  ref, onValue, get, set, update, remove,
  serverTimestamp, runTransaction
} from 'firebase/database'
import { PAY, MIN_PLAYERS, MAX_CARDS, sanitizeKey } from '../utils.js'

const FIXED_FEE = 10 

let svrOff = 0
onValue(ref(db, '.info/serverTimeOffset'), s => { svrOff = s.val() || 0 })
const now = () => Date.now() + svrOff

function getUser() {
  try { return JSON.parse(localStorage.getItem('bingoUser') || 'null') } catch { return null }
}

// Memoized MiniCard to completely prevent laggy grid-list re-renders
const MiniCard = React.memo(({ data, id, onRemove }) => {
  if (!data) return <div style={{ color: '#52525b', padding: '10px', fontSize: '11px' }}>Loading...</div>
  const cols = ['b', 'i', 'n', 'g', 'o']
  return (
    <div style={{ 
      flex: '1 1 0',
      minWidth: '160px',
      background: '#0a0516', 
      border: '1px solid #2e1065',
      borderRadius: '12px', 
      padding: '10px',
      position: 'relative',
      boxShadow: '0 4px 15px rgba(0,0,0,0.6)'
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
        <span style={{ color: '#00d8ff', fontWeight: '800', fontSize: '12px', letterSpacing: '0.5px' }}>Card {id}</span>
        <button 
          onClick={(e) => { e.stopPropagation(); onRemove(id); }}
          style={{ background: 'rgba(239, 68, 68, 0.15)', color: '#ef4444', border: 'none', borderRadius: '4px', padding: '2px 6px', fontSize: '10px', fontWeight: 'bold', cursor: 'pointer' }}
        >
          RELEASE
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '4px', textAlign: 'center' }}>
        {cols.map(l => (
          <div key={l} style={{ fontSize: '10px', fontWeight: '900', color: l === 'n' ? '#facc15' : l === 'g' ? '#ec4899' : '#00d8ff', textTransform: 'uppercase' }}>
            {l}
          </div>
        ))}

        {Array.from({ length: 5 }, (_, r) => (
          <React.Fragment key={r}>
            {cols.map((col, c) => {
              if (c === 2 && r === 2) {
                return (
                  <div key={`${c}-${r}`} style={{ background: 'rgba(234,179,8,0.1)', border: '1px solid #eab308', color: '#eab308', fontSize: '10px', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '4px', height: '22px' }}>
                    ★
                  </div>
                )
              }
              const colData = data[col] || data[col.toUpperCase()] || []
              const val = c === 2 ? colData[r < 2 ? r : r - 1] ?? '' : colData[r] ?? ''
              return (
                <div key={`${c}-${r}`} style={{ background: '#131124', color: '#cbd5e1', fontSize: '10px', fontWeight: '700', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '4px', height: '22px', border: '1px solid rgba(255,255,255,0.02)' }}>
                  {val}
                </div>
              )
            })}
          </React.Fragment>
        ))}
      </div>
    </div>
  )
})

// Memoized Matrix Button to isolate styles and stop re-rendering all 450 items at once
const MatrixButton = React.memo(({ id, status, onClick }) => {
  return (
    <button
      className="matrix-btn"
      data-status={status}
      disabled={status === "taken"}
      onClick={onClick}
    >
      {id}
    </button>
  )
})

export default function CartelaPage() {
  const navigate = useNavigate()
  const user = getUser()

  useEffect(() => {
    if (!user) navigate('/', { replace: true })
  }, [user, navigate])

  const rawKey = (user?.telegram_id || user?.phone || '').toString()
  const playerKey = useMemo(() => sanitizeKey(rawKey), [rawKey])

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

  const stateRef = useRef({})
  stateRef.current = { selectedCards, joined, gameActive, pCount, bal, taken, prize }

  const cdTimer = useRef(null)
  const gameIdRef = useRef(null)
  const gameNumRef = useRef(1)

  // Fetch matrix pool setup instantly without manual blocking-loaders
  useEffect(() => {
    if (!user) return
    get(ref(db, 'cartelas')).then(snap => {
      if (snap.exists()) {
        const data = snap.val()
        const mapped = {}
        Object.keys(data).forEach(k => { mapped[Number(k)] = data[k] })
        setAllCards(mapped)
      }
    })
  }, [user])

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
        
        const updatedPrize = Math.floor(activePlayerCount * FIXED_FEE * (PAY || 0.8))
        setPrize(updatedPrize)

        if (!stateRef.current.gameActive) {
          if (activePlayerCount >= 2) { 
            checkAndStartTimer(updatedPrize)
          } else {
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
        if (rem > 0 && rem <= 25) startCountdown(rem)
        else if (rem <= 0) triggerGameStart()
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
      setSelectedCards(nums.map(id => ({ id: parseInt(id), data: allCards[id] })))
      setJoined(true)
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

  async function syncSelectionWithDatabase(nextCards, isAdding) {
    await getOrCreateGameId()
    const cardNumbers = nextCards.map(c => c.id)
    const cardsData   = nextCards.map(c => c.data)
    
    // Process exact balance deductions atomically
    await runTransaction(ref(db, `users/${playerKey}/balance`), (currentBal) => {
      const balVal = currentBal ?? 0
      if (isAdding && nextCards.length === 1) {
        if (balVal < FIXED_FEE) return 
        return balVal - FIXED_FEE
      }
      if (!isAdding && nextCards.length === 0) {
        return balVal + FIXED_FEE
      }
      return currentBal
    })

    const updates = {}
    Object.keys(stateRef.current.taken).forEach(k => {
      if (stateRef.current.taken[k] === playerKey) updates[`lobby/takenCards/${k}`] = null
    })

    if (cardNumbers.length === 0) {
      updates[`lobby/players/${playerKey}`] = null
      updates[`lobby/playerCards/${playerKey}`] = null
      updates[`lobby/presence/${playerKey}`] = null
      setJoined(false)
      await update(ref(db), updates)
      return
    }

    cardNumbers.forEach(id => { updates[`lobby/takenCards/${id}`] = playerKey })
    updates[`lobby/players/${playerKey}`] = {
      name: user.name || 'Player',
      cartelas: cardNumbers,
      phone: user.phone || '',
      joinedAt: serverTimestamp(),
      gameId: gameIdRef.current,
      cardCount: cardNumbers.length,
      active: true
    }
    updates[`lobby/playerCards/${playerKey}`] = { cardNumbers, cardsData, gameId: gameIdRef.current }
    
    await update(ref(db), updates)
    setJoined(true)
  }

  async function onCardTap(id) {
    if (stateRef.current.gameActive) return
    const { taken: tk, selectedCards: sc } = stateRef.current
    if (tk[id] && tk[id] !== playerKey) return
    
    const existIdx = sc.findIndex(c => c.id === id)
    let nextCards = [...sc]
    let isAdding = false

    if (existIdx !== -1) {
      nextCards.splice(existIdx, 1)
    } else {
      if (sc.length >= MAX_CARDS) return
      if (stateRef.current.bal < FIXED_FEE && sc.length === 0) return
      isAdding = true
      nextCards.push({ id, data: allCards[id] || { b:[], i:[], n:[], g:[], o:[] } })
    }

    // Optimistic state change: update state BEFORE sending network request to make the button tap smooth
    setSelectedCards(nextCards)
    
    try {
      await syncSelectionWithDatabase(nextCards, isAdding)
    } catch (err) {
      console.error("Sync failed, reverting choice", err)
      setSelectedCards(sc) // Rollback seamlessly on failure
    }
  }

  async function checkAndStartTimer(currentPrize) {
    if (stateRef.current.gameActive || stateRef.current.pCount < 2) return
    const startAtSnap = await get(ref(db, 'lobby/gameStartAt'))
    if (startAtSnap.val()) return

    const startAt = now() + 20000 
    await update(ref(db), {
      'lobby/gameStartAt': startAt,
      'game/meta': { gameId: gameIdRef.current, gameNum: gameNumRef.current, startTime: startAt, status: 'waiting', prizePool: currentPrize }
    })
  }

  function startCountdown(sec) {
    if (cdTimer.current) clearInterval(cdTimer.current)
    setCdSec(Math.max(sec, 0))
    let t = Math.max(sec, 0)
    cdTimer.current = setInterval(() => {
      t--
      setCdSec(t)
      if (t <= 0) { 
        clearInterval(cdTimer.current)
        cdTimer.current = null
        triggerGameStart() 
      }
    }, 1000)
  }

  function stopCountdown() {
    if (cdTimer.current) { clearInterval(cdTimer.current); cdTimer.current = null }
    setCdSec(null)
  }

  async function triggerGameStart() {
    if (stateRef.current.gameActive) return
    setGameActive(true)
    if (stateRef.current.joined) {
      await update(ref(db), { 'game/status': 'started', 'game/meta/started': true })
      navigate('/game')
    } else {
      navigate('/game?spectator=true')
    }
  }

  if (!user) return null
  
  const numbersArray = Array.from({ length: 450 }, (_, i) => i + 1)

  return (
    <div style={{ background: '#02000a', minHeight: '100vh', display: 'flex', flexDirection: 'column', color: '#fafafa', fontFamily: 'system-ui, sans-serif', overflow: 'hidden' }}>
      
      <style>{`
        .grid-panel {
          display: grid;
          grid-template-columns: repeat(10, 1fr);
          gap: 6px;
          background: #030111;
          padding: 8px;
          content-visibility: auto; /* Browser native rendering optimization for long lists */
        }
        .matrix-btn {
          padding: 10px 0;
          font-size: 13px;
          font-weight: 800;
          border-radius: 8px;
          cursor: pointer;
          text-align: center;
          background: #192231;
          color: #a1b0cb;
          border: 1px solid rgba(255,255,255,0.03);
          transform: translateZ(0); /* Hardware accelerated layer generation */
        }
        .matrix-btn[data-status="selected"] {
          background: #ffffff !important;
          color: #000000 !important;
          box-shadow: 0 0 14px rgba(255,255,255,0.9);
        }
        .matrix-btn[data-status="taken"] {
          background: #0d0614 !important;
          color: #ef4444 !important;
          opacity: 0.2;
          cursor: not-allowed;
        }
      `}</style>

      {/* Navigation Header */}
      <nav style={{ background: '#090518', borderBottom: '1px solid #1e113b', padding: '10px 14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <span style={{ fontSize: '13px', fontWeight: '800' }}>{profileName}</span>
          <span style={{ fontSize: '10px', color: '#6d28d9' }}>#{gameNum}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <div style={{ fontSize: '12px', fontWeight: '800', color: '#10b981' }}>{Number(bal).toFixed(2)} ETB</div>
        </div>
      </nav>

      {/* Real-time Game Info Strip */}
      <div style={{ background: '#0d0b21', padding: '8px 14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid #1a1533' }}>
        <div style={{ display: 'flex', gap: '12px', fontSize: '11px', fontWeight: 'bold' }}>
          <span style={{ color: '#94a3b8' }}>PLAYERS: <span style={{ color: '#38bdf8' }}>{pCount}</span></span>
          <span style={{ color: '#94a3b8' }}>TOTAL PRIZE: <span style={{ color: '#eab308' }}>{prize} ETB</span></span>
        </div>
        {cdSec !== null ? (
          <div style={{ background: '#ef4444', color: '#fff', fontSize: '11px', padding: '3px 8px', borderRadius: '4px', fontWeight: '900', letterSpacing: '0.5px' }}>
            STARTING IN {cdSec}s
          </div>
        ) : (
          <span style={{ fontSize: '10px', color: '#64748b' }}>
            {pCount < 2 ? 'Waiting for 2 players to start...' : 'Ready'}
          </span>
        )}
      </div>

      {/* Number Matrix Scroll Section */}
      <div style={{ flex: '1 1 auto', overflowY: 'auto', padding: '4px' }}>
        <div className="grid-panel">
          {numbersArray.map(id => {
            let status = "open"
            if (selectedCards.some(c => c.id === id) || (taken[id] && taken[id] === playerKey)) status = "selected"
            else if (taken[id]) status = "taken"

            return (
              <MatrixButton
                key={id}
                id={id}
                status={status}
                onClick={() => onCardTap(id)}
              />
            )
          })}
        </div>
      </div>

      {/* Dynamic Drawer Preview Grid Footer Layout */}
      <footer style={{ flexShrink: 0, background: '#04020c', borderTop: '2px solid #120b29', padding: '12px', minHeight: '140px' }}>
        {selectedCards.length === 0 ? (
          <div style={{ textAlign: 'center', color: '#475569', fontSize: '11px', paddingTop: '20px' }}>
            Tap a number (10 ETB per round) to view your matrix card
          </div>
        ) : (
          <div style={{ display: 'flex', gap: '12px', overflowX: 'auto', paddingBottom: '4px' }}>
            {selectedCards.map(c => (
              <MiniCard 
                key={c.id}
                id={c.id}
                data={allCards[c.id]}
                onRemove={(targetId) => onCardTap(targetId)}
              />
            ))}
          </div>
        )}
      </footer>
    </div>
  )
}
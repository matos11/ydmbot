import React, { useState, useEffect, useRef, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { db } from '../firebase.js'
import {
  ref, onValue, get, set, update, remove,
  serverTimestamp, runTransaction, onDisconnect
} from 'firebase/database'
import { FEE, PAY, MIN_PLAYERS, MAX_CARDS, sanitizeKey } from '../utils.js'

let svrOff = 0
onValue(ref(db, '.info/serverTimeOffset'), s => { svrOff = s.val() || 0 })
const now = () => Date.now() + svrOff

function getUser() {
  try { return JSON.parse(localStorage.getItem('bingoUser') || 'null') } catch { return null }
}

export default function CartelaPage() {
  const navigate = useNavigate()
  const user = getUser()

  useEffect(() => {
    if (!user) navigate('/', { replace: true })
  }, [user, navigate])

  const rawKey = (user?.telegram_id || user?.phone || '').toString()
  const playerKey = useMemo(() => sanitizeKey(rawKey), [rawKey])

  // Component Core States
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
  const [waitingForPlayers, setWaitingForPlayers] = useState(false)

  // Thread-safe state tracking for callbacks
  const stateRef = useRef({})
  stateRef.current = { selectedCards, joined, gameActive, pCount, bal, taken, prize }

  const cdTimer = useRef(null)
  const gameIdRef = useRef(null)
  const gameNumRef = useRef(1)

  // Fetch Matrix Schemas Once
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

  // Instantaneous Real-time Stream Listeners
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

  // Session recovery layer
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

  // Pure Ultra-Fast Real-Time State Syncer
  async function syncSelectionWithDatabase(nextCards) {
    await getOrCreateGameId()
    const cardNumbers = nextCards.map(c => c.id)
    const cardsData   = nextCards.map(c => c.data)
    
    const updates = {}
    // Clear out previously occupied positions owned by this key cleanly
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

    const projectedPrize = Math.floor((stateRef.current.pCount || 1) * FEE * PAY)
    saveLocal(cardNumbers, cardsData, projectedPrize)

    const presRef = ref(db, `lobby/presence/${playerKey}`)
    set(presRef, true)
    onDisconnect(presRef).remove()
    
    if (stateRef.current.pCount >= MIN_PLAYERS) {
      checkAndStartTimer(projectedPrize)
    }
  }

  async function onCardTap(id) {
    if (stateRef.current.gameActive) return
    const { taken: tk, selectedCards: sc } = stateRef.current
    
    // Check if taken by another player
    if (tk[id] && tk[id] !== playerKey) return
    
    const existIdx = sc.findIndex(c => c.id === id)
    let nextCards = [...sc]

    if (existIdx !== -1) {
      nextCards.splice(existIdx, 1)
    } else {
      if (sc.length >= MAX_CARDS) return
      if (stateRef.current.bal < FEE && sc.length === 0) return
      const targetMatrix = allCards[id] || { b:[], i:[], n:[], g:[], o:[] }
      nextCards.push({ id, data: targetMatrix })
    }

    // High-Speed Optimistic Rendering: Render instantly, sync over network simultaneously
    setSelectedCards(nextCards)
    syncSelectionWithDatabase(nextCards).catch(err => console.error("Sync Failure: ", err))
  }

  async function checkAndStartTimer(currentPrize) {
    if (stateRef.current.gameActive || stateRef.current.pCount < MIN_PLAYERS) return
    const startAtSnap = await get(ref(db, 'lobby/gameStartAt'))
    if (startAtSnap.val()) return

    const startAt = now() + 3000 // Ultra-fast quick-start timer delay loop (3 Seconds)
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
    <div style={{ background: '#070709', minHeight: '100vh', display: 'flex', flexDirection: 'column', color: '#fafafa', fontFamily: 'system-ui, sans-serif', overflow: 'hidden' }}>
      
      {/* Global Optimization Stylesheet Rule Definitions */}
      <style>{`
        .board-matrix {
          display: grid;
          grid-template-columns: repeat(15, 1fr);
          gap: 2px;
          background: rgba(255,255,255,0.01);
          padding: 3px;
          border-radius: 6px;
          border: 1px solid rgba(255,255,255,0.02);
        }
        .cell-node {
          padding: 5px 0;
          font-size: 10px;
          font-weight: 900;
          border-radius: 4px;
          cursor: pointer;
          text-align: center;
          background: rgba(255,255,255,0.02);
          color: #94a3b8;
          border: 1px solid rgba(255,255,255,0.04);
          transition: transform 0.05s ease;
        }
        .cell-node[data-status="selected"] {
          background: #ffffff !important;
          color: #000000 !important;
          border-color: #22c55e !important;
          box-shadow: 0 0 6px #22c55e;
        }
        .cell-node[data-status="taken"] {
          background: #1a0b0b !important;
          color: #f87171 !important;
          border-color: rgba(248,113,113,0.1) !important;
          opacity: 0.15;
          cursor: not-allowed;
        }
        .cell-node:active:not([data-status="taken"]) {
          transform: scale(0.88);
        }
      `}</style>

      {loading && (
        <div style={{ background: '#070709', position: 'fixed', inset: 0, zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ width: '24px', height: '24px', border: '2px solid rgba(255,255,255,0.1)', borderTopColor: '#22c55e', borderRadius: '50%', animation: 'spin 0.6s linear infinite' }} />
        </div>
      )}

      {/* Top Navigation Control Dashboard */}
      <nav style={{ flexShrink: 0, background: '#0e0e12', borderBottom: '1px solid rgba(255,255,255,0.05)', padding: '8px 12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <span style={{ fontSize: '12px', fontWeight: '800' }}>{profileName}</span>
          <span style={{ fontSize: '10px', color: '#52525b' }}>{profileLbl}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <div style={{ fontSize: '10px', color: '#eab308', background: 'rgba(234,179,8,0.06)', padding: '2px 6px', borderRadius: '4px', border: '1px solid rgba(234,179,8,0.1)' }}>
            D: <span style={{ fontWeight: '800' }}>{prize}</span>
          </div>
          <div style={{ fontSize: '11px', fontWeight: '800', color: '#22c55e' }}>
            {Number(bal).toFixed(1)} <span style={{ fontSize: '8px' }}>ETB</span>
          </div>
          {cdSec !== null && (
            <div style={{ background: '#ef4444', color: '#fff', fontSize: '10px', fontWeight: '900', padding: '2px 6px', borderRadius: '4px', animation: 'pulse 1s infinite' }}>
              {cdSec}s
            </div>
          )}
        </div>
      </nav>

      {/* Main Board Container Section */}
      <div style={{ flex: '1 1 auto', overflowY: 'auto', padding: '6px' }}>
        <div className="board-matrix">
          {numbersArray.map(id => {
            let status = "open"
            if (selectedCards.some(c => c.id === id) || (taken[id] && taken[id] === playerKey)) status = "selected"
            else if (taken[id]) status = "taken"

            return (
              <button
                key={id}
                className="cell-node"
                data-status={status}
                disabled={status === "taken"}
                onClick={() => onCardTap(id)}
              >
                {id}
              </button>
            )
          })}
        </div>
      </div>

      {/* Ultra-Small Minimalist Sticky Dynamic Footer Panel */}
      <footer style={{ flexShrink: 0, background: '#09090b', borderTop: '1px solid rgba(255,255,255,0.06)', padding: '6px 10px display:flex, alignItems:center, justifyContent:space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', alignItems: 'center' }}>
            <span style={{ fontSize: '9px', fontWeight: '700', color: '#71717a', marginRight: '2px' }}>MY SLOTS:</span>
            {selectedCards.length === 0 ? (
              <span style={{ fontSize: '9px', color: '#4b5563' }}>None selected</span>
            ) : (
              selectedCards.map(c => (
                <div 
                  key={c.id} 
                  onClick={() => onCardTap(c.id)}
                  style={{ background: '#22c55e', color: '#000', fontSize: '10px', fontWeight: '900', padding: '1px 5px', borderRadius: '3px', display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer' }}
                >
                  #{c.id} <span style={{ opacity: 0.6, fontSize: '8px' }}>✕</span>
                </div>
              ))
            )}
          </div>

          <div style={{ fontSize: '9px', color: '#38bdf8', fontWeight: '700', background: 'rgba(56,189,248,0.06)', padding: '2px 6px', borderRadius: '4px', border: '1px solid rgba(56,189,248,0.1)' }}>
            👥 {pCount} IN LOBBY
          </div>
        </div>
      </footer>
    </div>
  )
}
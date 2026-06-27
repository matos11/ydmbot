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

/**
 * High-Contrast Mini-Matrix Grid Component matches image_7f0f04.png exactly
 */
function MiniCard({ data, id, onRemove }) {
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

      {/* Grid structure matching image_7f0f04.png columns */}
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
}

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
  const [loading, setLoading]             = useState(true)

  const stateRef = useRef({})
  stateRef.current = { selectedCards, joined, gameActive, pCount, bal, taken, prize }

  const cdTimer = useRef(null)
  const gameIdRef = useRef(null)
  const gameNumRef = useRef(1)

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

  async function syncSelectionWithDatabase(nextCards) {
    await getOrCreateGameId()
    const cardNumbers = nextCards.map(c => c.id)
    const cardsData   = nextCards.map(c => c.data)
    
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

    if (existIdx !== -1) {
      nextCards.splice(existIdx, 1)
    } else {
      if (sc.length >= MAX_CARDS) return
      if (stateRef.current.bal < FEE && sc.length === 0) return
      nextCards.push({ id, data: allCards[id] || { b:[], i:[], n:[], g:[], o:[] } })
    }

    setSelectedCards(nextCards)
    syncSelectionWithDatabase(nextCards).catch(err => console.error(err))
  }

  async function checkAndStartTimer(currentPrize) {
    if (stateRef.current.gameActive || stateRef.current.pCount < MIN_PLAYERS) return
    const startAtSnap = await get(ref(db, 'lobby/gameStartAt'))
    if (startAtSnap.val()) return

    const startAt = now() + 3000
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
    setGameActive(true)
    if (stateRef.current.joined) {
      await update(ref(db), { 'game/status': 'started', 'game/meta/started': true })
      navigate('/game')
    } else {
      navigate('/game?spectator=true')
    }
  }

  if (!user) return null
  const numbersArray = Array.from({ length: 110 }, (_, i) => i + 1) // Scoped viewport matching visual template limits

  return (
    <div style={{ background: '#02000a', minHeight: '100vh', display: 'flex', flexDirection: 'column', color: '#fafafa', fontFamily: 'system-ui, sans-serif', overflow: 'hidden' }}>
      
      <style>{`
        .grid-panel {
          display: grid;
          grid-template-columns: repeat(10, 1fr);
          gap: 6px;
          background: #030111;
          padding: 8px;
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
          transition: transform 0.05s ease;
        }
        .matrix-btn[data-status="selected"] {
          background: #ffffff !important;
          color: #000000 !important;
          box-shadow: 0 0 14px rgba(255,255,255,0.9);
          transform: scale(0.96);
        }
        .matrix-btn[data-status="taken"] {
          background: #0d0614 !important;
          color: #ef4444 !important;
          opacity: 0.2;
          cursor: not-allowed;
        }
      `}</style>

      {/* Navigation Layer */}
      <nav style={{ background: '#090518', borderBottom: '1px solid #1e113b', padding: '10px 14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <span style={{ fontSize: '13px', fontWeight: '800' }}>{profileName}</span>
          <span style={{ fontSize: '10px', color: '#6d28d9' }}>#{gameNum}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <div style={{ fontSize: '12px', fontWeight: '800', color: '#10b981' }}>{Number(bal).toFixed(2)} ETB</div>
          {cdSec !== null && <div style={{ background: '#ef4444', fontSize: '11px', padding: '2px 6px', borderRadius: '4px', fontWeight: '900' }}>{cdSec}s</div>}
        </div>
      </nav>

      {/* Grid Container */}
      <div style={{ flex: '1 1 auto', overflowY: 'auto', padding: '4px' }}>
        <div className="grid-panel">
          {numbersArray.map(id => {
            let status = "open"
            if (selectedCards.some(c => c.id === id) || (taken[id] && taken[id] === playerKey)) status = "selected"
            else if (taken[id]) status = "taken"

            return (
              <button
                key={id}
                className="matrix-btn"
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

      {/* Multi-Grid Side-by-Side Live Drawer Preview Footer */}
      <footer style={{ flexShrink: 0, background: '#04020c', borderTop: '2px solid #120b29', padding: '12px', minHeight: '140px' }}>
        {selectedCards.length === 0 ? (
          <div style={{ textAlign: 'center', color: '#475569', fontSize: '11px', paddingTop: '20px' }}>
            Tap a number from the grid above to lock and preview your cartela matrices
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
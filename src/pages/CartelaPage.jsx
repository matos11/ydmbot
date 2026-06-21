import React, { useState, useEffect, useRef } from 'react'
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

// ── Added 100 Birr Starting Balance for Guests ───────────
function getUser() {
  try { return JSON.parse(localStorage.getItem('bingoUser') || 'null') } catch { return null }
}
function ensureUser() {
  let u = getUser()
  if (!u) {
    u = { name: 'Guest', phone: `guest_${Date.now()}`, telegram_id: null }
    localStorage.setItem('bingoUser', JSON.stringify(u))
  }
  return u
}

function FullMobileCard({ data, id }) {
  if (!data) return <div style={{ color: '#fff', padding: '15px', textAlign: 'center' }}>Loading Matrix...</div>
  const cols = ['b', 'i', 'n', 'g', 'o']
  return (
    <div style={{ width: '100%', background: '#161616', borderRadius: '8px', padding: '12px', boxShadow: '0 4px 12px rgba(0,0,0,0.5)' }}>
      <div style={{ color: '#4caf50', fontWeight: 'bold', fontSize: '16px', marginBottom: '8px', textAlign: 'center', letterSpacing: '1px' }}>
        CARD NUMBER: {id}
      </div>
      <table style={{ 
        width: '100%', 
        borderCollapse: 'collapse', 
        fontSize: '15px', 
        color: '#fff', 
        textAlign: 'center',
        fontWeight: 'bold'
      }}>
        <thead>
          <tr style={{ background: '#222' }}>
            {cols.map(l => (
              <th key={l} style={{ 
                padding: '8px 0', 
                border: '1px solid #333', 
                textTransform: 'uppercase', 
                color: l === 'n' ? '#ffeb3b' : '#4caf50',
                fontSize: '16px'
              }}>{l}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: 5 }, (_, r) => (
            <tr key={r}>
              {cols.map((col, c) => {
                if (c === 2 && r === 2) {
                  return (
                    <td key={c} style={{ 
                      border: '1px solid #333', 
                      background: '#e91e63', 
                      color: '#fff', 
                      fontSize: '18px',
                      padding: '10px 0' 
                    }}>★</td>
                  )
                }
                const colData = data[col] || data[col.toUpperCase()] || []
                let v = ''
                if (c === 2) {
                  const targetIdx = r < 2 ? r : r - 1
                  v = colData[targetIdx] ?? ''
                } else {
                  v = colData[r] ?? ''
                }
                return (
                  <td key={c} style={{ 
                    border: '1px solid #333', 
                    padding: '10px 0', 
                    background: '#242424',
                    textShadow: '0 1px 2px rgba(0,0,0,0.8)'
                  }}>
                    {v}
                  </td>
                )
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
  const user = ensureUser()
  const rawKey = (user.telegram_id || user.phone || '').toString()
  const playerKey = sanitizeKey(rawKey)

  // State
  const [allCards, setAllCards]           = useState({})
  const [taken, setTaken]                 = useState({})
  const [selectedCards, setSelectedCards] = useState([])
  const [bal, setBal]                     = useState(0)
  const [profileName, setProfileName]     = useState(user.name || 'Player')
  const [profileLbl, setProfileLbl]       = useState('@player')
  const [pCount, setPCount]               = useState(0)
  const [joined, setJoined]               = useState(false)
  const [gameActive, setGameActive]       = useState(false)
  const [cdSec, setCdSec]                 = useState(null)
  const [prize, setPrize]                 = useState(0)
  const [gameNum, setGameNum]             = useState('--')
  const [loading, setLoading]             = useState(true)
  const [wasDisconnected, setWasDisconnected] = useState(false)

  const stateRef = useRef({})
  stateRef.current = { selectedCards, joined, gameActive, pCount, bal, taken, prize }

  const cdTimer = useRef(null)
  const pendingOp = useRef(false)
  const gameIdRef = useRef(null)
  const gameNumRef = useRef(1)

  useEffect(() => {
    get(ref(db, 'cartelas'))
      .then(snap => {
        if (snap.exists()) {
          const data = snap.val()
          const mapped = {}
          Object.keys(data).forEach(k => { mapped[Number(k)] = data[k] })
          setAllCards(mapped)
        }
        setLoading(false)
      })
      .catch((err) => {
        console.error("DB down:", err)
        setLoading(false)
      })
  }, [])

  useEffect(() => {
    // ── Pre-fill Guest Accounts with 100 Birr if balance doesn't exist ──
    const userRef = ref(db, `users/${playerKey}`)
    get(userRef).then(snap => {
      if (!snap.exists() && playerKey.startsWith('guest_')) {
        set(userRef, {
          name: user.name,
          phone: user.phone,
          balance: 100, // 100 Birr Test Funding
          createdAt: serverTimestamp()
        })
      }
    })

    const unsub1 = onValue(userRef, snap => {
      if (snap.exists()) {
        const u = snap.val()
        setBal(u.balance !== undefined ? u.balance : 0)
        setProfileName(u.first_name || u.name || 'Player')
        if (u.username) setProfileLbl('@' + u.username)
      }
    })

    const takenRef = ref(db, 'lobby/takenCards')
    const unsub2 = onValue(takenRef, snap => {
      setTaken(snap.val() || {})
    })

    // ── Derash calculation updated to multiply by number of players ──
    const playersRef = ref(db, 'lobby/players')
    const unsub3 = onValue(playersRef, snap => {
      const data = snap.val() || {}
      const activePlayerCount = Object.keys(data).length
      setPCount(activePlayerCount)
      setPrize(Math.floor(activePlayerCount * FEE * PAY))
    })

    const gnRef = ref(db, 'lobby/currentGameNum')
    const unsub4 = onValue(gnRef, snap => {
      if (snap.val()) setGameNum(snap.val())
    })

    const timerRef = ref(db, 'lobby/gameStartAt')
    const unsub5 = onValue(timerRef, snap => {
      const t = snap.val()
      if (!t) { stopCountdown(); return }
      if (stateRef.current.gameActive) return

      const rem = Math.ceil((t - now()) / 1000)
      if (rem > 0 && rem <= MOBILE_TIMER_SEC + 5) startCountdown(rem)
      else if (rem <= 0) triggerGameStart()
    })

    const endedRef = ref(db, 'activeGame/ended')
    const unsub6 = onValue(endedRef, snap => {
      if (snap.val() === true) resetLobby()
    })

    const statusRef = ref(db, 'game/status')
    const unsub7 = onValue(statusRef, snap => {
      if (snap.val() === 'started' && !stateRef.current.gameActive) {
        setGameActive(true)
        navigate(stateRef.current.joined ? '/game' : '/game?spectator=true')
      }
    })

    return () => {
      ;[unsub1, unsub2, unsub3, unsub4, unsub5, unsub6, unsub7].forEach(u => u())
    }
  }, [playerKey, navigate])

  useEffect(() => {
    if (Object.keys(allCards).length === 0) return
    
    async function restoreSession() {
      const snap = await get(ref(db, `lobby/players/${playerKey}`))
      if (!snap.exists()) return
      const pData = snap.val()
      const gid = pData.gameId
      gameIdRef.current = gid
      const numSnap = await get(ref(db, 'lobby/currentGameNum'))
      gameNumRef.current = numSnap.val() || 1
      setGameNum(gameNumRef.current)
      const nums = pData.cartelas || []
      const restored = nums.map(id => ({ id: parseInt(id), data: allCards[id] }))
      setSelectedCards(restored)
      setJoined(true)
      setWasDisconnected(true)
      localStorage.setItem('currentGameId', gid)
      localStorage.setItem('currentGameNum', gameNumRef.current)
      saveLocal(nums, restored.map(c => c.data), stateRef.current.prize)
      
      const presRef = ref(db, `lobby/presence/${playerKey}`)
      set(presRef, true)
      onDisconnect(presRef).remove()
    }
    restoreSession()
  }, [allCards, playerKey])

  async function getOrCreateGameId() {
    if (gameIdRef.current) return gameIdRef.current
    const snap = await get(ref(db, 'lobby/currentGameId'))
    let gid = snap.val()
    if (!gid) {
      const rand = Math.random().toString(36).substring(2, 10).toUpperCase()
      gid = `BNG-${rand}`
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
    if (pendingOp.current) return
    if (!cards.length) return
    if (stateRef.current.bal < FEE) return
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
      
      // Calculate real-time prize based on immediate state additions
      const simulatedCount = stateRef.current.pCount === 0 ? 1 : stateRef.current.pCount
      const projectedPrize = Math.floor(simulatedCount * FEE * PAY)

      saveLocal(cardNumbers, cardsData, projectedPrize)
      setJoined(true)
      const presRef = ref(db, `lobby/presence/${playerKey}`)
      set(presRef, true)
      onDisconnect(presRef).remove()
      
      // Starts timer instantly for the 1st player
      await checkAndStartTimer(projectedPrize)
    } catch (e) {
      console.error(e)
      setSelectedCards([])
    } finally {
      pendingOp.current = false
    }
  }

  async function removeCard(id, currentSelected) {
    if (stateRef.current.gameActive || pendingOp.current) return
    pendingOp.current = true
    try {
      await runTransaction(ref(db, `users/${playerKey}/balance`), b => (b || 0) + FEE)
      const updates = {}
      updates[`lobby/takenCards/${id}`] = null
      const newSelected = currentSelected.filter(c => c.id !== id)
      if (!newSelected.length) {
        updates[`lobby/players/${playerKey}`]    = null
        updates[`lobby/playerCards/${playerKey}`] = null
        updates[`lobby/presence/${playerKey}`]   = null
        setJoined(false)
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
      setSelectedCards(newSelected)
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
    const newSelected = [...sc, newCard]
    setSelectedCards(newSelected)
    await joinWithCards(newSelected)
  }

  // ── Modified checkAndStartTimer to accept current runtime prize pools ──
  async function checkAndStartTimer(currentPrize) {
    if (stateRef.current.gameActive) return
    
    const startAtSnap = await get(ref(db, 'lobby/gameStartAt'))
    if (startAtSnap.val()) {
      const rem = Math.ceil((startAtSnap.val() - now()) / 1000)
      if (rem > 0 && rem <= MOBILE_TIMER_SEC + 5) { startCountdown(rem); return }
    }
    const startAt = now() + MOBILE_TIMER_SEC * 1000
    await update(ref(db), {
      'lobby/gameStartAt': startAt,
      'game/meta': {
        gameId: gameIdRef.current,
        gameNum: gameNumRef.current,
        startTime: startAt,
        status: 'waiting',
        prizePool: currentPrize
      }
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
    stopCountdown()
  }

  function getNumberStyles(id) {
    const { selectedCards: sc, taken: tk } = stateRef.current
    const isMine = sc.some(c => c.id === id)

    const base = {
      padding: '12px 0',
      fontSize: '15px',
      fontWeight: 'bold',
      borderRadius: '4px',
      cursor: 'pointer',
      border: 'none',
      textAlign: 'center',
      transition: 'all 0.1s linear'
    }

    if (isMine || (tk[id] && tk[id] === playerKey)) {
      return { ...base, background: '#ffffff', color: '#111111', boxShadow: '0 0 8px rgba(255,255,255,0.6)' }
    }
    if (tk[id]) {
      return { ...base, background: '#221414', color: '#ff4444', opacity: '0.3', cursor: 'not-allowed' }
    }
    if (gameActive) {
      return { ...base, background: '#1a1a1a', color: '#444', cursor: 'not-allowed' }
    }
    return { ...base, background: '#333333', color: '#ffffff' }
  }

  const numbersArray = Array.from({ length: 450 }, (_, i) => i + 1)
  const timerUrgent = cdSec !== null && cdSec <= 10

  return (
    <div style={{ background: '#000', minHeight: '100vh', display: 'flex', flexDirection: 'column', color: '#fff', overflow: 'hidden' }}>
      {loading && (
        <div className="loading-overlay">
          <div className="loader-box">
            <div className="spinner" />
            <div className="loading-text">LOADING PLATFORM CORE DATA...</div>
          </div>
        </div>
      )}

      <nav className="lobby-nav" style={{ flexShrink: '0' }}>
        <div className="nav-group">
          <div className="profile-pill">
            <span className="lbl">{profileLbl}</span>
            <span className="val">{profileName}</span>
          </div>
          <div className="chip g">
            <span className="lbl">Balance</span>
            <span className="val">{Number(bal).toFixed(2)}</span>
          </div>
        </div>
        <div className="nav-group">
          <div className="chip">
            <span className="lbl">Stake</span>
            <span className="val">{FEE}</span>
          </div>
          <div className="chip au">
            <span className="lbl">Derash</span>
            <span className="val">{prize}</span>
          </div>
          <div className="chip bl">
            <span className="lbl">Game</span>
            <span className="val">{gameNum}</span>
          </div>
          <div className="timer-pill">
            <span className={timerUrgent ? 'urgent' : ''}>
              {cdSec !== null ? `${cdSec}s` : '--'}
            </span>
          </div>
        </div>
      </nav>

      <div className="lobby-scroll" style={{ flex: '1 1 auto', overflowY: 'auto', paddingBottom: '10px' }}>
        <div className="status-row" style={{ padding: '6px 12px' }}>
          <div className={`badge${joined ? ' active' : ''}`}>
            👥 {pCount} Player{pCount !== 1 ? 's' : ''}
          </div>
          {wasDisconnected && joined && (
            <div className="badge disconnected">% Reconnected — spot saved</div>
          )}
        </div>

        <div className="pure-number-grid" style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(10, 1fr)',
          gap: '4px',
          padding: '4px 8px'
        }}>
          {numbersArray.map(id => (
            <button
              key={id}
              disabled={taken[id] && taken[id] !== playerKey}
              style={getNumberStyles(id)}
              onClick={() => onCardTap(id)}
            >
              {id}
            </button>
          ))}
        </div>
      </div>

      <div className="lobby-panel" style={{ 
        flexShrink: '0',
        borderTop: '2px solid #222', 
        background: '#0a0a0a',
        padding: '12px',
        maxHeight: '320px',
        overflowY: 'auto'
      }}>
        {selectedCards.length === 0 ? (
          <span style={{ display: 'block', padding: '15px', textAlign: 'center', color: '#555', fontSize: '14px' }}>
            Select a card number above to view matrix grid and play
          </span>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            {selectedCards.map(c => (
              <div key={c.id} style={{ position: 'relative', width: '100%' }}>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onCardTap(c.id);
                  }}
                  style={{
                    position: 'absolute',
                    top: '6px',
                    right: '12px',
                    background: '#f44336',
                    color: 'white',
                    border: 'none',
                    borderRadius: '4px',
                    padding: '4px 10px',
                    cursor: 'pointer',
                    fontSize: '13px',
                    fontWeight: 'bold',
                    zIndex: '10',
                    boxShadow: '0 2px 4px rgba(0,0,0,0.5)'
                  }}
                >
                  REMOVE ×
                </button>
                <FullMobileCard id={c.id} data={allCards[c.id]} />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
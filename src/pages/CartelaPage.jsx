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

function getUser() {
  try { return JSON.parse(localStorage.getItem('bingoUser') || 'null') } catch { return null }
}

/**
 * Modernized, Compact Card Preview component
 */
function FullMobileCard({ data, id }) {
  if (!data) return <div style={{ color: '#aaa', padding: '10px', textAlign: 'center', fontSize: '12px' }}>Loading Matrix...</div>
  const cols = ['b', 'i', 'n', 'g', 'o']
  return (
    <div style={{ 
      width: '100%', 
      background: 'rgba(25, 25, 25, 0.65)', 
      backdropFilter: 'blur(8px)',
      borderRadius: '12px', 
      padding: '8px', 
      border: '1px solid rgba(255, 255, 255, 0.08)',
      boxShadow: '0 4px 20px rgba(0,0,0,0.4)' 
    }}>
      <div style={{ 
        color: '#4ade80', 
        fontWeight: '800', 
        fontSize: '11px', 
        marginBottom: '6px', 
        textAlign: 'center', 
        letterSpacing: '0.5px' 
      }}>
        CARD #{id}
      </div>
      <table style={{ 
        width: '100%', 
        borderCollapse: 'separate',
        borderSpacing: '2px',
        fontSize: '11px', 
        color: '#fff', 
        textAlign: 'center',
        fontWeight: '700'
      }}>
        <thead>
          <tr>
            {cols.map(l => (
              <th key={l} style={{ 
                padding: '3px 0', 
                textTransform: 'uppercase', 
                color: l === 'n' ? '#facc15' : '#4ade80',
                fontSize: '12px',
                background: 'rgba(255,255,255,0.03)',
                borderRadius: '4px'
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
                      background: '#ec4899', 
                      color: '#fff', 
                      fontSize: '12px',
                      borderRadius: '4px',
                      padding: '5px 0' 
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
                    padding: '5px 0', 
                    background: 'rgba(255, 255, 255, 0.05)',
                    borderRadius: '4px',
                    color: '#e2e8f0'
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
  const user = getUser()

  useEffect(() => {
    if (!user) navigate('/', { replace: true })
  }, [user, navigate])

  const rawKey = (user?.telegram_id || user?.phone || '').toString()
  const playerKey = sanitizeKey(rawKey)

  // State
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

  const stateRef = useRef({})
  stateRef.current = { selectedCards, joined, gameActive, pCount, bal, taken, prize }

  const cdTimer = useRef(null)
  const pendingOp = useRef(false)
  const gameIdRef = useRef(null)
  const gameNumRef = useRef(1)

  useEffect(() => {
    if (!user) return
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
  }, [user])

  useEffect(() => {
    if (!user || !playerKey) return

    const userRef = ref(db, `users/${playerKey}`)
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

    const playersRef = ref(db, 'lobby/players')
    const unsub3 = onValue(playersRef, snap => {
      const data = snap.val() || {}
      const activePlayerCount = Object.keys(data).length
      setPCount(activePlayerCount)
      setPrize(Math.floor(activePlayerCount * FEE * PAY))

      if (!stateRef.current.gameActive) {
        if (activePlayerCount >= MIN_PLAYERS) {
          setWaitingForPlayers(false)
          checkAndStartTimer(Math.floor(activePlayerCount * FEE * PAY))
        } else {
          setWaitingForPlayers(stateRef.current.joined)
          stopCountdown()
          remove(ref(db, 'lobby/gameStartAt')).catch(() => {})
        }
      }
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
  }, [playerKey, navigate, user])

  useEffect(() => {
    if (!user || Object.keys(allCards).length === 0) return

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
  }, [allCards, playerKey, user])

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

      const simulatedCount = stateRef.current.pCount === 0 ? 1 : stateRef.current.pCount
      const projectedPrize = Math.floor(simulatedCount * FEE * PAY)

      saveLocal(cardNumbers, cardsData, projectedPrize)
      setJoined(true)
      const presRef = ref(db, `lobby/presence/${playerKey}`)
      set(presRef, true)
      onDisconnect(presRef).remove()

      if (simulatedCount >= MIN_PLAYERS) {
        await checkAndStartTimer(projectedPrize)
        setWaitingForPlayers(false)
      } else {
        setWaitingForPlayers(true)
      }
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

  async function checkAndStartTimer(currentPrize) {
    if (stateRef.current.gameActive) return
    if (stateRef.current.pCount < MIN_PLAYERS) return

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

  function getNumberStyles(id) {
    const { selectedCards: sc, taken: tk } = stateRef.current
    const isMine = sc.some(c => c.id === id)

    const base = {
      padding: '10px 0',
      fontSize: '13px',
      fontWeight: '800',
      borderRadius: '8px',
      cursor: 'pointer',
      border: '1px solid transparent',
      textAlign: 'center',
      transition: 'all 0.15s ease'
    }

    if (isMine || (tk[id] && tk[id] === playerKey)) {
      return { 
        ...base, 
        background: '#ffffff', 
        color: '#0a0a0a', 
        borderColor: '#4ade80',
        boxShadow: '0 0 12px rgba(74, 222, 128, 0.5)' 
      }
    }
    if (tk[id]) {
      return { ...base, background: '#1e1111', color: '#ef4444', opacity: '0.25', cursor: 'not-allowed' }
    }
    if (gameActive) {
      return { ...base, background: '#141414', color: '#444', cursor: 'not-allowed' }
    }
    return { 
      ...base, 
      background: 'rgba(255,255,255,0.04)', 
      color: '#cbd5e1', 
      borderColor: 'rgba(255,255,255,0.05)',
      ':hover': { background: 'rgba(255,255,255,0.1)' }
    }
  }

  if (!user) return null

  const numbersArray = Array.from({ length: 450 }, (_, i) => i + 1)
  const timerUrgent = cdSec !== null && cdSec <= 10
  const playersNeeded = Math.max(0, MIN_PLAYERS - pCount)

  return (
    <div style={{ background: '#09090b', minHeight: '100vh', display: 'flex', flexDirection: 'column', color: '#fafafa', fontFamily: 'system-ui, sans-serif', overflow: 'hidden' }}>
      
      {loading && (
        <div className="loading-overlay" style={{ background: 'rgba(9,9,11,0.95)', position: 'fixed', inset: 0, zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div className="loader-box" style={{ textAlign: 'center' }}>
            <div className="spinner" style={{ width: '40px', height: '40px', border: '3px solid rgba(255,255,255,0.1)', borderTopColor: '#4ade80', borderRadius: '50%', animation: 'spin 1s linear infinite', margin: '0 auto 12px' }} />
            <div style={{ fontSize: '11px', letterSpacing: '1px', color: '#a1a1aa' }}>LOADING PLATFORM CORE DATA...</div>
          </div>
        </div>
      )}

      {/* Modern High-Contrast Dynamic Top Bar */}
      <nav style={{ 
        flexShrink: 0, 
        background: 'rgba(18, 18, 24, 0.8)', 
        backdropFilter: 'blur(12px)',
        borderBottom: '1px solid rgba(255,255,255,0.06)', 
        padding: '10px 14px', 
        display: 'flex', 
        flexDirection: 'column', 
        gap: '8px' 
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#4ade80', boxShadow: '0 0 8px #4ade80' }} />
            <span style={{ fontSize: '14px', fontWeight: '800', letterSpacing: '0.5px' }}>{profileName}</span>
            <span style={{ fontSize: '11px', color: '#71717a' }}>{profileLbl}</span>
          </div>
          
          <div style={{ background: 'rgba(74, 222, 128, 0.1)', border: '1px solid rgba(74, 222, 128, 0.2)', borderRadius: '20px', padding: '4px 12px', fontSize: '13px', fontWeight: '800', color: '#4ade80' }}>
            {Number(bal).toFixed(2)} <span style={{ fontSize: '10px', fontWeight: '500' }}>ETB</span>
          </div>
        </div>

        <div style={{ display: 'flex', gap: '6px', overflowX: 'auto', paddingBottom: '2px' }}>
          <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.05)', borderRadius: '8px', padding: '4px 10px', display: 'flex', flexDirection: 'column', minWidth: '60px' }}>
            <span style={{ fontSize: '9px', color: '#71717a', textTransform: 'uppercase' }}>Stake</span>
            <span style={{ fontSize: '12px', fontWeight: '700' }}>{FEE}</span>
          </div>
          <div style={{ background: 'rgba(234, 179, 8, 0.05)', border: '1px solid rgba(234, 179, 8, 0.15)', borderRadius: '8px', padding: '4px 10px', display: 'flex', flexDirection: 'column', minWidth: '75px' }}>
            <span style={{ fontSize: '9px', color: '#eab308', textTransform: 'uppercase' }}>Derash</span>
            <span style={{ fontSize: '12px', fontWeight: '800', color: '#eab308' }}>{prize}</span>
          </div>
          <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.05)', borderRadius: '8px', padding: '4px 10px', display: 'flex', flexDirection: 'column', minWidth: '60px' }}>
            <span style={{ fontSize: '9px', color: '#71717a', textTransform: 'uppercase' }}>Game</span>
            <span style={{ fontSize: '12px', fontWeight: '700', color: '#38bdf8' }}>#{gameNum}</span>
          </div>
          
          {/* Neon Countdown Pill */}
          <div style={{ 
            marginLeft: 'auto',
            background: timerUrgent ? 'rgba(239, 68, 68, 0.15)' : 'rgba(255,255,255,0.03)', 
            border: timerUrgent ? '1px solid #ef4444' : '1px solid rgba(255,255,255,0.05)', 
            borderRadius: '8px', 
            padding: '4px 14px', 
            display: 'flex', 
            alignItems: 'center', 
            justifyContent: 'center',
            minWidth: '50px',
            boxShadow: timerUrgent ? '0 0 10px rgba(239, 68, 68, 0.3)' : 'none'
          }}>
            <span style={{ fontSize: '14px', fontWeight: '900', color: timerUrgent ? '#ef4444' : '#fafafa' }}>
              {cdSec !== null ? `${cdSec}s` : '--'}
            </span>
          </div>
        </div>
      </nav>

      {/* Main Grid Viewport Container */}
      <div className="lobby-scroll" style={{ flex: '1 1 auto', overflowY: 'auto', padding: '12px 8px' }}>
        <div style={{ display: 'flex', gap: '6px', alignItems: 'center', marginBottom: '10px', padding: '0 4px' }}>
          <div style={{ background: 'rgba(56, 189, 248, 0.1)', border: '1px solid rgba(56, 189, 248, 0.2)', color: '#38bdf8', fontSize: '11px', fontWeight: '700', padding: '3px 8px', borderRadius: '6px' }}>
            👥 {pCount} Active
          </div>
          {wasDisconnected && joined && (
            <div style={{ background: '#ca8a04', color: '#fff', fontSize: '11px', fontWeight: '700', padding: '3px 8px', borderRadius: '6px' }}>✓ Reconnected</div>
          )}
          {waitingForPlayers && cdSec === null && (
            <div style={{ color: '#a1a1aa', fontSize: '11px', fontWeight: '500', marginLeft: 'auto' }}>
              ⏳ Need {playersNeeded} more to start
            </div>
          )}
        </div>

        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(10, 1fr)',
          gap: '5px',
          background: 'rgba(255,255,255,0.01)',
          padding: '8px',
          borderRadius: '12px',
          border: '1px solid rgba(255,255,255,0.03)'
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

      {/* Bottom Panel - Sleek side-by-side card drawer */}
      <div style={{ 
        flexShrink: 0,
        borderTop: '1px solid rgba(255,255,255,0.08)', 
        background: 'linear-gradient(to top, #040406, #0c0c0e)',
        padding: '12px 14px 20px',
        maxHeight: '260px'
      }}>
        {selectedCards.length === 0 ? (
          <span style={{ display: 'block', padding: '30px 15px', textAlign: 'center', color: '#52525b', fontSize: '12px', fontWeight: '500', letterSpacing: '0.2px' }}>
            Tap an available card number above to purchase and preview matrix
          </span>
        ) : (
          /* Multi-card slider viewport layout */
          <div style={{ 
            display: 'flex', 
            gap: '12px', 
            overflowX: 'auto', 
            paddingBottom: '4px',
            scrollSnapType: 'x mandatory'
          }}>
            {selectedCards.map(c => (
              <div key={c.id} style={{ 
                position: 'relative', 
                flex: selectedCards.length > 1 ? '0 0 75%' : '1 1 100%', 
                maxWidth: selectedCards.length > 1 ? '240px' : '100%',
                scrollSnapAlign: 'start'
              }}>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onCardTap(c.id);
                  }}
                  style={{
                    position: 'absolute',
                    top: '12px',
                    right: '12px',
                    background: 'rgba(239, 68, 68, 0.9)',
                    backdropFilter: 'blur(4px)',
                    color: 'white',
                    border: 'none',
                    borderRadius: '6px',
                    padding: '2px 8px',
                    cursor: 'pointer',
                    fontSize: '9px',
                    fontWeight: '800',
                    zIndex: '10',
                    boxShadow: '0 2px 8px rgba(0,0,0,0.4)'
                  }}
                >
                  REMOVE
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
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { db } from '../firebase.js'
import { ref, onValue, set, get, update, serverTimestamp, push, remove } from 'firebase/database'
import { sanitizeKey } from '../utils.js'

// ── Game End Message Component ──────────────────────────────
const GameEndMessage = React.memo(({ reason, onDismiss }) => {
  useEffect(() => {
    const timer = setTimeout(onDismiss, 5000)
    return () => clearTimeout(timer)
  }, [onDismiss])

  const messages = {
    'all_numbers_drawn': {
      icon: '📊',
      title: 'ሙሉ ሙከራ ምንም አሸናፊ ሊታይ ነበረበት',
      subtitle: 'No winner this round!',
      description: 'All 75 numbers were drawn but nobody claimed BINGO. Better luck in the next game!',
      color: '#FF6B6B',
      bgColor: '#FFE5E5'
    },
    'no_winner': {
      icon: '🏁',
      title: 'ሽልማቱ አልተወሰደም',
      subtitle: 'Prize unclaimed',
      description: 'The game has ended. Ready to play another round?',
      color: '#FFA500',
      bgColor: '#FFE8CC'
    },
    'game_ended': {
      icon: '🎮',
      title: 'ጨዋታ ወደ መጨረሻ ደረሰ',
      subtitle: 'Game finished',
      description: 'Ready for another thrilling round of BINGO?',
      color: '#4ECDC4',
      bgColor: '#E0F7F6'
    }
  }

  const msg = messages[reason]
  if (!msg) return null

  return (
    <div style={{
      position: 'fixed',
      top: '20px',
      left: '50%',
      transform: 'translateX(-50%)',
      width: '90%',
      maxWidth: '500px',
      padding: '16px',
      background: msg.bgColor,
      border: `2px solid ${msg.color}`,
      borderRadius: '12px',
      textAlign: 'center',
      zIndex: 999,
      animation: 'slideDown 0.3s ease-out',
      boxShadow: '0 4px 12px rgba(0,0,0,0.15)'
    }}>
      <style>{`
        @keyframes slideDown {
          from {
            opacity: 0;
            transform: translateX(-50%) translateY(-20px);
          }
          to {
            opacity: 1;
            transform: translateX(-50%) translateY(0);
          }
        }
      `}</style>
      <div style={{ fontSize: '36px', marginBottom: '12px' }}>{msg.icon}</div>
      <h3 style={{
        margin: '0 0 4px 0',
        color: msg.color,
        fontSize: '18px',
        fontWeight: 700
      }}>
        {msg.title}
      </h3>
      <p style={{
        margin: '0 0 8px 0',
        color: '#666',
        fontSize: '13px',
        fontWeight: 600
      }}>
        {msg.subtitle}
      </p>
      <p style={{
        margin: '0',
        color: '#555',
        fontSize: '12px',
        lineHeight: '1.4'
      }}>
        {msg.description}
      </p>
    </div>
  )
})

// ── Loading Skeleton ────────────────────────────────────────
const SkeletonLoader = () => (
  <div style={{
    width: '100%',
    height: '120px',
    background: 'linear-gradient(90deg, #f0f0f0 25%, #e0e0e0 50%, #f0f0f0 75%)',
    backgroundSize: '200% 100%',
    animation: 'loading 1.5s infinite',
    borderRadius: '8px',
    marginBottom: '12px'
  }}>
    <style>{`
      @keyframes loading {
        0% { background-position: 200% 0; }
        100% { background-position: -200% 0; }
      }
    `}</style>
  </div>
)

// ── Player Info Card ────────────────────────────────────────
const PlayerCard = React.memo(({ user, balance }) => {
  if (!user) return <SkeletonLoader />

  return (
    <div style={{
      padding: '16px',
      background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
      borderRadius: '12px',
      color: '#fff',
      marginBottom: '20px',
      boxShadow: '0 4px 12px rgba(102, 126, 234, 0.4)'
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h2 style={{ margin: '0 0 4px 0', fontSize: '18px', fontWeight: 700 }}>
            👋 {user.name || 'Anonymous'}
          </h2>
          <p style={{ margin: '0', fontSize: '12px', opacity: 0.9 }}>
            {user.phone && `📱 ${user.phone}`}
          </p>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: '24px', fontWeight: 700 }}>{balance}</div>
          <div style={{ fontSize: '11px', opacity: 0.9 }}>ETB</div>
        </div>
      </div>
    </div>
  )
})

// ── Cartela Card Item ──────────────────────────────────────
const CartelaCard = React.memo(({ cardNumber, isSelected, onSelect, disabled }) => {
  return (
    <button
      onClick={() => !disabled && onSelect(cardNumber)}
      disabled={disabled}
      style={{
        padding: '12px',
        background: isSelected ? '#4ade80' : '#f5f5f5',
        border: `2px solid ${isSelected ? '#22c55e' : '#ddd'}`,
        borderRadius: '8px',
        cursor: disabled ? 'not-allowed' : 'pointer',
        fontWeight: 700,
        fontSize: '14px',
        color: isSelected ? '#fff' : '#333',
        transition: 'all 0.2s',
        opacity: disabled ? 0.5 : 1,
        transform: isSelected ? 'scale(1.05)' : 'scale(1)',
        boxShadow: isSelected ? '0 4px 12px rgba(74, 222, 128, 0.3)' : 'none'
      }}
      onMouseEnter={(e) => {
        if (!disabled && !isSelected) {
          e.target.style.background = '#e8f5e9'
          e.target.style.borderColor = '#81c784'
        }
      }}
      onMouseLeave={(e) => {
        if (!disabled && !isSelected) {
          e.target.style.background = '#f5f5f5'
          e.target.style.borderColor = '#ddd'
        }
      }}
    >
      Card #{cardNumber}
    </button>
  )
})

// ── Current Game Status ────────────────────────────────────
const GameStatusBanner = React.memo(({ gameInfo, playerCount, prizePool }) => {
  if (!gameInfo) return null

  const isLive = gameInfo.started && !gameInfo.ended

  return (
    <div style={{
      padding: '12px',
      background: isLive ? '#1a1a2e' : '#f5f5f5',
      color: isLive ? '#fff' : '#333',
      borderRadius: '8px',
      marginBottom: '20px',
      border: `1px solid ${isLive ? '#667eea' : '#ddd'}`
    }}>
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: '12px'
      }}>
        <div>
          <div style={{
            fontSize: '12px',
            fontWeight: 600,
            opacity: 0.8,
            marginBottom: '4px'
          }}>
            {isLive ? '🔴 LIVE GAME' : '⏳ Waiting for game...'}
          </div>
          <div style={{ fontSize: '13px', fontWeight: 600 }}>
            {playerCount} players • {prizePool || '0'} ETB Derash
          </div>
        </div>
        <div style={{
          background: isLive ? '#667eea' : '#ddd',
          padding: '6px 12px',
          borderRadius: '6px',
          fontSize: '12px',
          fontWeight: 700
        }}>
          {isLive ? 'PLAYING' : 'READY'}
        </div>
      </div>
    </div>
  )
})

// ════════════════════════════════════════════════════════════
// MAIN CARTELA PAGE
// ════════════════════════════════════════════════════════════
export default function CartelaPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const gameEndReason = searchParams.get('reason')

  // ── Session Data ────────────────────────────────────────────
  const user = (() => {
    try {
      return JSON.parse(localStorage.getItem('bingoUser') || '{}')
    } catch {
      return {}
    }
  })()

  const userKey = (user.telegram_id || user.phone || '').toString()
  const playerKey = sanitizeKey(userKey)

  // ── UI State ────────────────────────────────────────────────
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState(null)
  const [gameStartAt, setGameStartAt] = useState(null)
  const [playerCount, setPlayerCount] = useState(0)
  const [prizePool, setPrizePool] = useState(0)
  const [gameInfo, setGameInfo] = useState(null)
  const [balance, setBalance] = useState(0)
  const [message, setMessage] = useState('')
  const [dismissEndMessage, setDismissEndMessage] = useState(false)

  // ── Card Selection State ────────────────────────────────────
  const [selectedCards, setSelectedCards] = useState([])
  const [entryFee, setEntryFee] = useState('10')
  const [totalCost, setTotalCost] = useState(0)
  const [isSubmitting, setIsSubmitting] = useState(false)

  // ── Game State Refs ────────────────────────────────────────
  const unsubscribersRef = useRef([])
  const countdownIntervalRef = useRef(null)

  // Calculate total cost
  useEffect(() => {
    const cost = selectedCards.length * parseInt(entryFee || '0')
    setTotalCost(cost)
  }, [selectedCards.length, entryFee])

  // Clear params on mount
  useEffect(() => {
    if (gameEndReason && !dismissEndMessage) {
      const timer = setTimeout(() => {
        setDismissEndMessage(true)
        window.history.replaceState({}, document.title, window.location.pathname)
      }, 5000)
      return () => clearTimeout(timer)
    }
  }, [gameEndReason, dismissEndMessage])

  // Initialize listeners
  useEffect(() => {
    let unmounted = false

    async function init() {
      try {
        // Get current user balance
        if (playerKey) {
          const userSnap = await get(ref(db, `users/${playerKey}`))
          if (userSnap.exists()) {
            setBalance(userSnap.val().balance || 0)
          } else {
            setBalance(0)
          }
        }

        // Listen to game status
        const unsubGame = onValue(ref(db, 'activeGame'), snap => {
          if (unmounted) return
          const data = snap.val()
          if (data) {
            setGameInfo({
              started: data.started || false,
              ended: data.ended || false
            })
          } else {
            setGameInfo(null)
          }
        })
        unsubscribersRef.current.push(unsubGame)

        // Listen to player count
        const unsubPlayers = onValue(ref(db, 'lobby/players'), snap => {
          if (unmounted) return
          const count = snap.numChildren()
          setPlayerCount(count)
        })
        unsubscribersRef.current.push(unsubPlayers)

        // Listen to prize pool
        const unsubPrize = onValue(ref(db, 'lobby/takenCards'), snap => {
          if (unmounted) return
          const count = Object.keys(snap.val() || {}).length
          const prize = Math.floor(count * parseInt(entryFee || '0') * 0.8)
          setPrizePool(prize)
        })
        unsubscribersRef.current.push(unsubPrize)

        // Listen to game countdown
        const unsubCountdown = onValue(ref(db, 'lobby/gameStartAt'), snap => {
          if (unmounted) return
          const timestamp = snap.val()
          if (timestamp) {
            setGameStartAt(timestamp)
          }
        })
        unsubscribersRef.current.push(unsubCountdown)

        setIsLoading(false)
      } catch (err) {
        console.error('❌ Init error:', err)
        if (!unmounted) {
          setError(err.message || 'Failed to load game data')
          setIsLoading(false)
        }
      }
    }

    init()

    return () => {
      unmounted = true
      unsubscribersRef.current.forEach(unsub => unsub && unsub())
      if (countdownIntervalRef.current) {
        clearInterval(countdownIntervalRef.current)
      }
    }
  }, [playerKey, entryFee])

  // Handle countdown timer
  useEffect(() => {
    if (!gameStartAt) return

    if (countdownIntervalRef.current) {
      clearInterval(countdownIntervalRef.current)
    }

    const updateCountdown = () => {
      const now = Date.now()
      const remaining = Math.max(0, gameStartAt - now)

      if (remaining <= 0) {
        setMessage('Game starting...')
        clearInterval(countdownIntervalRef.current)
        return
      }

      const seconds = Math.ceil(remaining / 1000)
      setMessage(`⏱️ Game starts in ${seconds}s`)
    }

    updateCountdown()
    countdownIntervalRef.current = setInterval(updateCountdown, 1000)

    return () => {
      if (countdownIntervalRef.current) {
        clearInterval(countdownIntervalRef.current)
      }
    }
  }, [gameStartAt])

  // Handle card selection
  const handleSelectCard = useCallback((cardNum) => {
    setSelectedCards(prev => {
      if (prev.includes(cardNum)) {
        return prev.filter(c => c !== cardNum)
      } else {
        // Max 10 cards per player
        if (prev.length >= 10) {
          setMessage('❌ Maximum 10 cards per game')
          return prev
        }
        return [...prev, cardNum]
      }
    })
  }, [])

  // Submit cards
  const handleSubmitCards = useCallback(async () => {
    if (!playerKey) {
      setMessage('❌ Please authenticate first')
      return
    }

    if (selectedCards.length === 0) {
      setMessage('❌ Please select at least 1 card')
      return
    }

    if (totalCost > balance) {
      setMessage(`❌ Insufficient balance (need ${totalCost} ETB, have ${balance} ETB)`)
      return
    }

    setIsSubmitting(true)
    setMessage('Processing...')

    try {
      // Get current game ID
      const gameSnap = await get(ref(db, 'lobby/gameStartAt'))
      const gameId = `game_${Date.now()}`

      // Deduct from balance
      await update(ref(db, `users/${playerKey}`), {
        balance: balance - totalCost
      })

      // Record taken cards
      const cardsKey = push(ref(db, 'lobby/takenCards')).key
      await set(ref(db, `lobby/takenCards/${playerKey}`), {
        cards: selectedCards,
        amount: totalCost,
        timestamp: serverTimestamp()
      })

      // Store selected cards in localStorage
      localStorage.setItem('selectedCartelas', JSON.stringify(selectedCards))
      localStorage.setItem('cartelaNumbers', JSON.stringify(selectedCards))
      localStorage.setItem('entryFee', entryFee)
      localStorage.setItem('prizePool', prizePool.toString())
      localStorage.setItem('currentGameId', gameId)
      localStorage.setItem('currentGameNum', `#${Date.now().toString().slice(-4)}`)
      localStorage.setItem('numPlayers', playerCount.toString())

      setMessage('✅ Cards selected! Entering game...')

      // Navigate after short delay
      setTimeout(() => {
        navigate('/game')
      }, 1000)
    } catch (err) {
      console.error('❌ Submit error:', err)
      setMessage(`❌ ${err.message || 'Failed to submit cards'}`)
    } finally {
      setIsSubmitting(false)
    }
  }, [playerKey, selectedCards, totalCost, balance, entryFee, prizePool, playerCount, navigate])

  // Handle spectator mode
  const handleSpectate = useCallback(() => {
    localStorage.setItem('selectedCartelas', JSON.stringify([]))
    localStorage.setItem('cartelaNumbers', JSON.stringify([]))
    localStorage.setItem('entryFee', '0')
    localStorage.setItem('currentGameId', `game_${Date.now()}`)
    localStorage.setItem('numPlayers', playerCount.toString())
    navigate('/game?spectator=true')
  }, [playerCount, navigate])

  // ── Error Screen ────────────────────────────────────────────
  if (error) {
    return (
      <div style={{
        padding: '20px',
        textAlign: 'center',
        background: '#fff5f5',
        borderRadius: '12px',
        border: '1px solid #feb2b2'
      }}>
        <h2 style={{ color: '#c53030', marginTop: 0 }}>⚠️ Error</h2>
        <p style={{ color: '#742a2a' }}>{error}</p>
        <button
          onClick={() => window.location.reload()}
          style={{
            padding: '10px 20px',
            background: '#c53030',
            color: '#fff',
            border: 'none',
            borderRadius: '6px',
            fontWeight: 700,
            cursor: 'pointer'
          }}
        >
          🔄 Retry
        </button>
      </div>
    )
  }

  // ── Loading Screen ────────────────────────────────────────
  if (isLoading) {
    return (
      <div style={{ padding: '20px' }}>
        <SkeletonLoader />
        <SkeletonLoader />
        <SkeletonLoader />
      </div>
    )
  }

  // ── Available cards (1-30) ──────────────────────────────────
  const availableCards = Array.from({ length: 30 }, (_, i) => i + 1)

  // ── Main Render ─────────────────────────────────────────────
  return (
    <div style={{ padding: '16px', paddingBottom: '100px', maxWidth: '500px', margin: '0 auto' }}>
      {/* Header */}
      <div style={{
        textAlign: 'center',
        marginBottom: '24px',
        paddingTop: '12px'
      }}>
        <h1 style={{
          margin: '0 0 8px 0',
          fontSize: '28px',
          fontWeight: 700,
          background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
          backgroundClip: 'text',
          color: 'transparent'
        }}>
          🎰 YDM BINGO
        </h1>
        <p style={{
          margin: '0',
          fontSize: '12px',
          color: '#666',
          fontWeight: 600
        }}>
          ቢንጎ ጨዋታ • Cartela Selection
        </p>
      </div>

      {/* Game End Message */}
      {gameEndReason && !dismissEndMessage && (
        <GameEndMessage
          reason={gameEndReason}
          onDismiss={() => setDismissEndMessage(true)}
        />
      )}

      {/* Player Info */}
      <PlayerCard user={user} balance={`${balance}`} />

      {/* Game Status */}
      <GameStatusBanner
        gameInfo={gameInfo}
        playerCount={playerCount}
        prizePool={prizePool}
      />

      {/* Stake Amount Selection */}
      <div style={{
        marginBottom: '20px',
        padding: '12px',
        background: '#f5f5f5',
        borderRadius: '8px'
      }}>
        <label style={{
          display: 'block',
          fontSize: '12px',
          fontWeight: 700,
          marginBottom: '8px',
          color: '#333'
        }}>
          💰 Entry Fee per Card (ETB)
        </label>
        <select
          value={entryFee}
          onChange={(e) => setEntryFee(e.target.value)}
          disabled={gameInfo?.started}
          style={{
            width: '100%',
            padding: '10px',
            border: '1px solid #ddd',
            borderRadius: '6px',
            fontSize: '14px',
            fontWeight: 600,
            cursor: gameInfo?.started ? 'not-allowed' : 'pointer',
            opacity: gameInfo?.started ? 0.5 : 1
          }}
        >
          <option value="10">10 ETB</option>
          <option value="20">20 ETB</option>
          <option value="50">50 ETB</option>
          <option value="100">100 ETB</option>
        </select>
      </div>

      {/* Card Selection */}
      <div style={{ marginBottom: '20px' }}>
        <label style={{
          display: 'block',
          fontSize: '12px',
          fontWeight: 700,
          marginBottom: '12px',
          color: '#333'
        }}>
          🎫 Select Cartelas ({selectedCards.length}/10)
        </label>
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: '8px'
        }}>
          {availableCards.map(cardNum => (
            <CartelaCard
              key={cardNum}
              cardNumber={cardNum}
              isSelected={selectedCards.includes(cardNum)}
              onSelect={handleSelectCard}
              disabled={gameInfo?.started}
            />
          ))}
        </div>
      </div>

      {/* Cost Summary */}
      {selectedCards.length > 0 && (
        <div style={{
          padding: '12px',
          background: 'linear-gradient(135deg, #ffd700 0%, #ffed4e 100%)',
          borderRadius: '8px',
          marginBottom: '20px',
          textAlign: 'center'
        }}>
          <div style={{
            fontSize: '12px',
            fontWeight: 600,
            color: '#333',
            marginBottom: '4px'
          }}>
            💵 Total Cost
          </div>
          <div style={{
            fontSize: '28px',
            fontWeight: 700,
            color: '#333'
          }}>
            {totalCost} ETB
          </div>
          <div style={{
            fontSize: '11px',
            color: '#555',
            marginTop: '4px'
          }}>
            {selectedCards.length} card{selectedCards.length !== 1 ? 's' : ''} × {entryFee} ETB
          </div>
        </div>
      )}

      {/* Message */}
      {message && (
        <div style={{
          padding: '12px',
          background: message.includes('✅') ? '#dcfce7' : message.includes('❌') ? '#fee2e2' : '#dbeafe',
          color: message.includes('✅') ? '#166534' : message.includes('❌') ? '#991b1b' : '#0c4a6e',
          borderRadius: '8px',
          marginBottom: '16px',
          fontSize: '13px',
          fontWeight: 600,
          textAlign: 'center'
        }}>
          {message}
        </div>
      )}

      {/* Action Buttons */}
      <div style={{
        position: 'fixed',
        bottom: '16px',
        left: '16px',
        right: '16px',
        display: 'flex',
        gap: '12px',
        maxWidth: 'calc(500px - 32px)',
        margin: '0 auto'
      }}>
        {/* Play Button */}
        <button
          onClick={handleSubmitCards}
          disabled={
            isSubmitting ||
            selectedCards.length === 0 ||
            totalCost > balance ||
            gameInfo?.started
          }
          style={{
            flex: 1,
            padding: '14px',
            background: selectedCards.length > 0 && totalCost <= balance && !gameInfo?.started
              ? 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)'
              : '#ddd',
            color: '#fff',
            border: 'none',
            borderRadius: '8px',
            fontWeight: 700,
            fontSize: '14px',
            cursor: selectedCards.length > 0 && totalCost <= balance && !gameInfo?.started
              ? 'pointer'
              : 'not-allowed',
            opacity: selectedCards.length > 0 ? 1 : 0.7,
            transition: 'all 0.2s'
          }}
        >
          {isSubmitting ? '⏳ Processing...' : '▶️ PLAY'}
        </button>

        {/* Spectate Button */}
        <button
          onClick={handleSpectate}
          disabled={!gameInfo?.started}
          style={{
            flex: '0 0 80px',
            padding: '14px',
            background: gameInfo?.started ? '#4ecdc4' : '#ddd',
            color: '#fff',
            border: 'none',
            borderRadius: '8px',
            fontWeight: 700,
            fontSize: '12px',
            cursor: gameInfo?.started ? 'pointer' : 'not-allowed',
            transition: 'all 0.2s'
          }}
        >
          👁️ Watch
        </button>
      </div>

      {/* Footer Info */}
      <div style={{
        marginTop: '40px',
        padding: '16px',
        background: '#f5f5f5',
        borderRadius: '8px',
        fontSize: '11px',
        color: '#666',
        lineHeight: '1.6',
        textAlign: 'center'
      }}>
        <p style={{ margin: '0 0 8px 0' }}>
          🎯 ከሞከር በደላ ወይም የሌላ ሰው ካርድ ይልወጡ
        </p>
        <p style={{ margin: '0 0 8px 0' }}>
          💰 ሽልማቱ 80% ከጠቅላላ መግብያ - 20% ለ YDM
        </p>
        <p style={{ margin: '0' }}>
          📱 Telebirr • CBE ብሎ ሜትር ተመልሰው ይጨምሩ
        </p>
      </div>
    </div>
  )
}
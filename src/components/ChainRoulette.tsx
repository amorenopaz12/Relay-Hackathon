import { useState, useCallback, useEffect, useRef } from 'react'
import { useAccount, useWalletClient, useSwitchChain, usePublicClient } from 'wagmi'
import {
  SUPPORTED_CHAINS,
  SETTLEMENT_CHAIN,
  SETTLEMENT_TOKEN,
  ENTRY_AMOUNT_USDC,
  ENTRY_AMOUNT_DISPLAY,
  getTokensForChain,
  type TokenInfo,
} from '../wagmi'
import {
  getDepositQuote,
  getPayoutQuote,
  executeSteps,
  pollStatus,
  type IntentStatus,
} from '../services/relay-service'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type GamePhase = 'entry' | 'spinning' | 'winner' | 'payout' | 'complete'

interface Player {
  address: string
  chainId: number
  chainName: string
  tokenSymbol: string
  depositStatus: IntentStatus | 'quoting' | 'executing'
  requestId?: string
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEPOSIT_CHAINS = SUPPORTED_CHAINS.filter((c) => c.id !== SETTLEMENT_CHAIN.id)
const WHEEL_COLORS = ['#4615C8', '#A7AAFF', '#6B21A8', '#7C3AED', '#DDD6FE']
const ROUND_DURATION_SECS = 60
const FEE_PERCENT = 2

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getChainName(chainId: number): string {
  return SUPPORTED_CHAINS.find((c) => c.id === chainId)?.name ?? `Chain ${chainId}`
}

function truncateAddress(addr: string): string {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`
}

function buildWheelGradient(players: Player[]): string {
  if (players.length === 0) return '#1f2937'
  const seg = 360 / players.length
  const stops = players.map((_, i) => {
    const color = WHEEL_COLORS[i % WHEEL_COLORS.length]
    return `${color} ${seg * i}deg ${seg * (i + 1)}deg`
  })
  return `conic-gradient(${stops.join(', ')})`
}

function formatPot(playerCount: number): string {
  return `$${(playerCount * ENTRY_AMOUNT_DISPLAY).toFixed(2)}`
}

function formatPrize(playerCount: number): string {
  const pot = playerCount * ENTRY_AMOUNT_DISPLAY
  const prize = pot * (1 - FEE_PERCENT / 100)
  return `$${prize.toFixed(2)}`
}

function formatFee(playerCount: number): string {
  const pot = playerCount * ENTRY_AMOUNT_DISPLAY
  return `$${(pot * (FEE_PERCENT / 100)).toFixed(2)}`
}

// ---------------------------------------------------------------------------
// Status tracker sub-component
// ---------------------------------------------------------------------------

const STATUS_STEPS: IntentStatus[] = ['waiting', 'pending', 'submitted', 'success']

function StatusTracker({ current }: { current: IntentStatus | null }) {
  const idx = current ? STATUS_STEPS.indexOf(current) : -1
  return (
    <div className="flex items-center justify-center gap-2 text-sm">
      {STATUS_STEPS.map((s, i) => {
        const isActive = i <= idx
        const isCurrent = s === current
        return (
          <div key={s} className="flex items-center gap-2">
            <div className="flex items-center gap-1.5">
              <div
                className={`status-dot ${
                  isCurrent
                    ? 'status-dot-pending'
                    : isActive
                      ? 'status-dot-active'
                      : 'status-dot-inactive'
                }`}
              />
              <span className={isActive ? 'text-white' : 'text-gray-500'}>
                {s}
              </span>
            </div>
            {i < STATUS_STEPS.length - 1 && (
              <span className={isActive ? 'text-gray-400' : 'text-gray-700'}>
                &rarr;
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function ChainRoulette() {
  const { address, isConnected, chain } = useAccount()
  const { data: walletClient } = useWalletClient()
  const { switchChainAsync } = useSwitchChain()
  const publicClient = usePublicClient()

  // Game state
  const [phase, setPhase] = useState<GamePhase>('entry')
  const [players, setPlayers] = useState<Player[]>([])
  const [winner, setWinner] = useState<Player | null>(null)
  const [payoutStatus, setPayoutStatus] = useState<IntentStatus | null>(null)
  const [spinDegrees, setSpinDegrees] = useState(0)
  const [isDepositing, setIsDepositing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Entry form state
  const [selectedChainId, setSelectedChainId] = useState<number>(DEPOSIT_CHAINS[0].id)
  const [selectedToken, setSelectedToken] = useState<TokenInfo>(
    getTokensForChain(DEPOSIT_CHAINS[0].id)[0]
  )

  // Timer state
  const [secondsLeft, setSecondsLeft] = useState(ROUND_DURATION_SECS)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const timerStarted = useRef(false)

  // Winner payout chain picker
  const [payoutChainId, setPayoutChainId] = useState<number>(SUPPORTED_CHAINS[0].id)
  const [payoutToken, setPayoutToken] = useState<TokenInfo>(
    getTokensForChain(SUPPORTED_CHAINS[0].id)[0]
  )

  // Provably fair seed
  const [blockHash, setBlockHash] = useState<string | null>(null)

  // --- Sync token when chain changes ---

  useEffect(() => {
    const tokens = getTokensForChain(selectedChainId)
    if (tokens.length > 0 && !tokens.find((t) => t.symbol === selectedToken.symbol)) {
      setSelectedToken(tokens[0])
    } else if (tokens.length > 0) {
      setSelectedToken(tokens.find((t) => t.symbol === selectedToken.symbol)!)
    }
  }, [selectedChainId, selectedToken.symbol])

  // --- Timer logic ---

  useEffect(() => {
    if (players.length >= 1 && phase === 'entry' && !timerStarted.current) {
      timerStarted.current = true
      setSecondsLeft(ROUND_DURATION_SECS)
      timerRef.current = setInterval(() => {
        setSecondsLeft((prev) => {
          if (prev <= 1) {
            if (timerRef.current) clearInterval(timerRef.current)
            return 0
          }
          return prev - 1
        })
      }, 1000)
    }

    return () => {
      if (timerRef.current && phase !== 'entry') {
        clearInterval(timerRef.current)
      }
    }
  }, [players.length, phase])

  // Auto-spin when timer expires with enough players
  useEffect(() => {
    if (secondsLeft === 0 && phase === 'entry' && players.length >= 2) {
      handleSpin()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [secondsLeft])

  // --- Player helpers ---

  const updatePlayer = useCallback(
    (addr: string, patch: Partial<Player>) =>
      setPlayers((prev) =>
        prev.map((p) => (p.address === addr ? { ...p, ...patch } : p))
      ),
    []
  )

  const removePlayer = useCallback(
    (addr: string) =>
      setPlayers((prev) => prev.filter((p) => p.address !== addr)),
    []
  )

  // --- Deposit flow ---

  async function handleDeposit() {
    if (!walletClient || !address) return
    setIsDepositing(true)
    setError(null)

    try {
      // Switch chain if needed
      if (chain?.id !== selectedChainId) {
        await switchChainAsync({ chainId: selectedChainId })
      }

      // Add player optimistically
      const newPlayer: Player = {
        address,
        chainId: selectedChainId,
        chainName: getChainName(selectedChainId),
        tokenSymbol: selectedToken.symbol,
        depositStatus: 'quoting',
      }
      setPlayers((prev) => [...prev, newPlayer])

      // 1. Get quote — EXACT_OUTPUT so exactly $5 USDC arrives on Base
      const quote = await getDepositQuote({
        userAddress: address,
        originChainId: selectedChainId,
        originCurrency: selectedToken.address,
        destinationCurrency: SETTLEMENT_TOKEN.address,
        amount: ENTRY_AMOUNT_USDC,
      })

      updatePlayer(address, { depositStatus: 'executing' })

      // 2. Execute steps
      const requestId = await executeSteps(
        quote.steps,
        walletClient,
        (_step, status) =>
          updatePlayer(address, { depositStatus: status as Player['depositStatus'] })
      )

      // 3. Poll status
      if (requestId) {
        updatePlayer(address, { requestId, depositStatus: 'waiting' })
        const finalStatus = await pollStatus(requestId, (data) =>
          updatePlayer(address, { depositStatus: data.status })
        )

        if (finalStatus.status !== 'success') {
          removePlayer(address)
          setError('Deposit failed or was refunded.')
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Deposit failed')
      removePlayer(address)
    } finally {
      setIsDepositing(false)
    }
  }

  // --- Spin (provably fair via blockhash) ---

  async function handleSpin() {
    if (players.length < 2) return
    setPhase('spinning')

    // Fetch latest block hash from Base for provably-fair seed
    let seed: string
    try {
      const block = await publicClient?.getBlock()
      seed = block?.hash ?? `0x${Date.now().toString(16)}`
    } catch {
      seed = `0x${Date.now().toString(16)}`
    }
    setBlockHash(seed)

    // Derive winner index from blockhash
    const hashSlice = seed.slice(-8)
    const winnerIndex = parseInt(hashSlice, 16) % players.length

    const segmentAngle = 360 / players.length
    const targetDeg =
      360 * 5 + (360 - winnerIndex * segmentAngle - segmentAngle / 2)
    setSpinDegrees(targetDeg)

    setTimeout(() => {
      setWinner(players[winnerIndex])
      setPhase('winner')
    }, 4200)
  }

  // --- Payout ---

  async function handlePayout() {
    if (!walletClient || !address || !winner) return
    setPhase('payout')
    setError(null)

    try {
      const potUsdc = BigInt(ENTRY_AMOUNT_USDC) * BigInt(players.length)

      // Switch to settlement chain for payout
      if (chain?.id !== SETTLEMENT_CHAIN.id) {
        await switchChainAsync({ chainId: SETTLEMENT_CHAIN.id })
      }

      const quote = await getPayoutQuote({
        operatorAddress: address,
        recipientAddress: winner.address,
        destinationChainId: payoutChainId,
        destinationCurrency: payoutToken.address,
        amount: potUsdc.toString(),
      })

      const requestId = await executeSteps(quote.steps, walletClient)

      if (requestId) {
        const finalStatus = await pollStatus(requestId, (data) =>
          setPayoutStatus(data.status)
        )

        if (finalStatus.status === 'success') {
          setPhase('complete')
        } else {
          setError('Payout failed. Please try again.')
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Payout failed')
    }
  }

  // --- Reset ---

  function handlePlayAgain() {
    setPhase('entry')
    setPlayers([])
    setWinner(null)
    setPayoutStatus(null)
    setSpinDegrees(0)
    setError(null)
    setBlockHash(null)
    setSecondsLeft(ROUND_DURATION_SECS)
    timerStarted.current = false
  }

  // --- Computed ---

  const alreadyEntered = players.some((p) => p.address === address)
  const availableTokens = getTokensForChain(selectedChainId)
  const payoutTokens = getTokensForChain(payoutChainId)

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="space-y-8">
      {/* Error banner */}
      {error && (
        <div className="bg-red-900/50 border border-red-500 rounded-lg p-4 text-red-200 text-sm">
          {error}
          <button className="ml-3 underline" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}

      {/* Timer + Pot banner */}
      {phase === 'entry' && players.length > 0 && (
        <div className="flex items-center justify-between bg-gray-900 rounded-xl px-6 py-4">
          <div>
            <span className="text-gray-400 text-sm">Pot</span>
            <p className="text-2xl font-bold text-relay-light">
              {formatPot(players.length)}
            </p>
          </div>
          <div className="text-center">
            <span className="text-gray-400 text-sm">Players</span>
            <p className="text-2xl font-bold">{players.length}</p>
          </div>
          <div className="text-right">
            <span className="text-gray-400 text-sm">Round closes in</span>
            <p
              className={`text-2xl font-bold font-mono ${
                secondsLeft <= 10 ? 'text-red-400 animate-pulse' : 'text-white'
              }`}
            >
              {Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, '0')}
            </p>
          </div>
        </div>
      )}

      {/* Roulette Wheel */}
      <div className="wheel-container">
        <div className="wheel-pointer" />
        <div
          className={`wheel ${phase === 'spinning' ? 'animate-spin-wheel' : ''}`}
          style={
            {
              background: buildWheelGradient(players),
              '--spin-degrees': `${spinDegrees}deg`,
              ...(phase !== 'spinning' && spinDegrees > 0
                ? { transform: `rotate(${spinDegrees}deg)` }
                : {}),
            } as React.CSSProperties
          }
        >
          {/* Segment labels */}
          {players.map((p, i) => {
            const seg = 360 / players.length
            const angle = seg * i + seg / 2 - 90
            return (
              <div
                key={p.address}
                className="absolute inset-0 flex items-center justify-center"
                style={{ transform: `rotate(${angle}deg)` }}
              >
                <span
                  className="text-[10px] font-bold text-white drop-shadow-md"
                  style={{ transform: `translateX(80px) rotate(${-angle}deg)` }}
                >
                  {truncateAddress(p.address)}
                </span>
              </div>
            )
          })}

          {/* Empty state */}
          {players.length === 0 && (
            <div className="absolute inset-0 flex items-center justify-center">
              <span className="text-gray-500 text-sm">No players yet</span>
            </div>
          )}
        </div>
      </div>

      {/* Entry Form */}
      {phase === 'entry' && isConnected && !alreadyEntered && (
        <div className="bg-gray-900 rounded-xl p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">Enter the Roulette</h2>
            <span className="bg-relay-purple/20 text-relay-light px-3 py-1 rounded-full text-sm font-bold">
              ${ENTRY_AMOUNT_DISPLAY} Entry
            </span>
          </div>

          <p className="text-gray-400 text-sm">
            Pick any chain and token — Relay routes your ${ENTRY_AMOUNT_DISPLAY} into the pot on Base.
          </p>

          <div className="grid grid-cols-2 gap-4">
            {/* Chain selector */}
            <div>
              <label className="block text-sm text-gray-400 mb-1">
                Your Chain
              </label>
              <select
                value={selectedChainId}
                onChange={(e) => setSelectedChainId(Number(e.target.value))}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white"
              >
                {DEPOSIT_CHAINS.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>

            {/* Token selector */}
            <div>
              <label className="block text-sm text-gray-400 mb-1">
                Pay With
              </label>
              <select
                value={selectedToken.symbol}
                onChange={(e) => {
                  const t = availableTokens.find((tk) => tk.symbol === e.target.value)
                  if (t) setSelectedToken(t)
                }}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white"
              >
                {availableTokens.map((t) => (
                  <option key={t.symbol} value={t.symbol}>
                    {t.symbol}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <button
            onClick={handleDeposit}
            disabled={isDepositing}
            className="w-full bg-relay-purple hover:bg-relay-purple/80 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg py-3 font-semibold transition-colors"
          >
            {isDepositing
              ? 'Depositing...'
              : `Enter with ${selectedToken.symbol} on ${getChainName(selectedChainId)}`}
          </button>
        </div>
      )}

      {/* Already entered badge */}
      {phase === 'entry' && isConnected && alreadyEntered && (
        <div className="bg-gray-900 rounded-xl p-6 text-center">
          <p className="text-green-400 font-semibold">You're in! Waiting for more players...</p>
          <p className="text-gray-400 text-sm mt-1">
            {players.length < 2
              ? 'Need at least 2 players to spin.'
              : `${players.length} players in the pot. Spin is ready!`}
          </p>
        </div>
      )}

      {/* Not connected prompt */}
      {phase === 'entry' && !isConnected && (
        <div className="bg-gray-900 rounded-xl p-6 text-center text-gray-400">
          Connect your wallet to enter the roulette.
        </div>
      )}

      {/* Player List */}
      {players.length > 0 && (
        <div className="bg-gray-900 rounded-xl p-6">
          <h2 className="text-lg font-semibold mb-4">
            Players ({players.length})
          </h2>
          <div className="space-y-3">
            {players.map((p) => (
              <div
                key={p.address}
                className="flex items-center justify-between bg-gray-800 rounded-lg px-4 py-3"
              >
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-full bg-relay-purple/30 flex items-center justify-center text-xs font-bold">
                    {p.chainName.slice(0, 2)}
                  </div>
                  <div>
                    <p className="font-mono text-sm">
                      {truncateAddress(p.address)}
                    </p>
                    <p className="text-xs text-gray-400">
                      {p.tokenSymbol} on {p.chainName}
                    </p>
                  </div>
                </div>
                <div className="text-right">
                  <p className="text-sm font-semibold">${ENTRY_AMOUNT_DISPLAY}</p>
                  <p className="text-xs">
                    {p.depositStatus === 'success' ? (
                      <span className="text-green-400">Confirmed</span>
                    ) : p.depositStatus === 'failure' ||
                      p.depositStatus === 'refunded' ? (
                      <span className="text-red-400">{p.depositStatus}</span>
                    ) : (
                      <span className="text-yellow-400">
                        {p.depositStatus}...
                      </span>
                    )}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Spin Button */}
      {phase === 'entry' && players.length >= 2 && (
        <button
          onClick={handleSpin}
          className="w-full bg-gradient-to-r from-relay-purple to-purple-500 hover:from-relay-purple/80 hover:to-purple-400 rounded-lg py-4 text-xl font-bold transition-all shadow-lg shadow-relay-purple/30"
        >
          Spin the Wheel!
        </button>
      )}

      {/* Winner + Payout chain picker */}
      {phase === 'winner' && winner && (
        <div className="bg-gray-900 rounded-xl p-8 space-y-6">
          <div className="text-center">
            <p className="text-gray-400 text-sm mb-1">Winner</p>
            <p className="text-3xl font-bold text-relay-light">
              {truncateAddress(winner.address)}
            </p>
            <p className="text-gray-400 mt-1">
              entered with {winner.tokenSymbol} on {winner.chainName}
            </p>
          </div>

          <div className="text-center">
            <p className="text-gray-400 text-sm mb-1">Prize</p>
            <p className="text-2xl font-bold text-green-400">
              {formatPrize(players.length)}
            </p>
            <p className="text-xs text-gray-500">
              {formatPot(players.length)} pot &minus; {formatFee(players.length)} ({FEE_PERCENT}% fee)
            </p>
          </div>

          {/* Provably fair proof */}
          {blockHash && (
            <div className="bg-gray-800 rounded-lg p-4 text-center">
              <p className="text-xs text-gray-400 mb-1">Randomness seed (blockhash)</p>
              <p className="font-mono text-xs text-relay-light break-all">
                {blockHash}
              </p>
              <p className="text-xs text-gray-500 mt-1">
                Winner = hash[-8:] mod {players.length} = {parseInt(blockHash.slice(-8), 16) % players.length}
              </p>
            </div>
          )}

          {/* Destination chain picker */}
          <div className="bg-gray-800 rounded-lg p-4 space-y-3">
            <p className="text-sm font-semibold text-center">
              Where should the prize be delivered?
            </p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-gray-400 mb-1">Chain</label>
                <select
                  value={payoutChainId}
                  onChange={(e) => {
                    const newChainId = Number(e.target.value)
                    setPayoutChainId(newChainId)
                    const tokens = getTokensForChain(newChainId)
                    setPayoutToken(tokens[0])
                  }}
                  className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm"
                >
                  {SUPPORTED_CHAINS.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1">Token</label>
                <select
                  value={payoutToken.symbol}
                  onChange={(e) => {
                    const t = payoutTokens.find((tk) => tk.symbol === e.target.value)
                    if (t) setPayoutToken(t)
                  }}
                  className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-white text-sm"
                >
                  {payoutTokens.map((t) => (
                    <option key={t.symbol} value={t.symbol}>
                      {t.symbol}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          <button
            onClick={handlePayout}
            className="w-full bg-green-600 hover:bg-green-500 rounded-lg px-8 py-3 font-semibold transition-colors"
          >
            Pay Out {formatPrize(players.length)} via Relay
          </button>
        </div>
      )}

      {/* Payout In Progress */}
      {phase === 'payout' && (
        <div className="bg-gray-900 rounded-xl p-8 text-center space-y-6">
          <p className="text-lg font-semibold">Paying out winner...</p>
          <p className="text-gray-400">
            Bridging {formatPrize(players.length)} as {payoutToken.symbol} to{' '}
            {getChainName(payoutChainId)} via Relay
          </p>
          <StatusTracker current={payoutStatus} />
        </div>
      )}

      {/* Complete */}
      {phase === 'complete' && winner && (
        <div className="bg-gray-900 rounded-xl p-8 text-center space-y-6">
          <p className="text-4xl">&#127881;</p>
          <div>
            <p className="text-2xl font-bold text-green-400">Payout Complete!</p>
            <p className="text-gray-400 mt-2">
              {formatPrize(players.length)} sent to{' '}
              {truncateAddress(winner.address)} on {getChainName(payoutChainId)}
            </p>
            <p className="text-gray-500 text-sm mt-1">
              Arrived as {payoutToken.symbol} — cross-chain in seconds.
            </p>
          </div>
          <button
            onClick={handlePlayAgain}
            className="bg-relay-purple hover:bg-relay-purple/80 rounded-lg px-8 py-3 font-semibold transition-colors"
          >
            Play Again
          </button>
        </div>
      )}
    </div>
  )
}

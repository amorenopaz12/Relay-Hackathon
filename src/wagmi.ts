import { getDefaultConfig } from '@rainbow-me/rainbowkit'
import { http } from 'wagmi'
import { mainnet, base, arbitrum, optimism, zora, polygon } from 'wagmi/chains'
import {
  createClient,
  convertViemChainToRelayChain,
  MAINNET_RELAY_API,
} from '@relayprotocol/relay-sdk'

// ---------------------------------------------------------------------------
// Chains
// ---------------------------------------------------------------------------

export const SUPPORTED_CHAINS = [base, arbitrum, optimism, mainnet, polygon, zora] as const

export const SETTLEMENT_CHAIN = base

export const CHAIN_COLORS: Record<number, string> = {
  [base.id]: '#0052FF',
  [arbitrum.id]: '#28A0F0',
  [optimism.id]: '#FF0420',
  [mainnet.id]: '#627EEA',
  [polygon.id]: '#8247E5',
  [zora.id]: '#A1723A',
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

const NATIVE = '0x0000000000000000000000000000000000000000'

export interface TokenInfo {
  symbol: string
  address: string
  decimals: number
}

/** Tokens available per chain. Key = symbol, inner key = chainId. */
export const TOKEN_MAP: Record<string, Record<number, TokenInfo>> = {
  ETH: {
    [mainnet.id]: { symbol: 'ETH', address: NATIVE, decimals: 18 },
    [base.id]: { symbol: 'ETH', address: NATIVE, decimals: 18 },
    [arbitrum.id]: { symbol: 'ETH', address: NATIVE, decimals: 18 },
    [optimism.id]: { symbol: 'ETH', address: NATIVE, decimals: 18 },
    [polygon.id]: { symbol: 'ETH', address: NATIVE, decimals: 18 },
    [zora.id]: { symbol: 'ETH', address: NATIVE, decimals: 18 },
  },
  USDC: {
    [mainnet.id]: { symbol: 'USDC', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 },
    [base.id]: { symbol: 'USDC', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
    [arbitrum.id]: { symbol: 'USDC', address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6 },
    [optimism.id]: { symbol: 'USDC', address: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', decimals: 6 },
    [polygon.id]: { symbol: 'USDC', address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', decimals: 6 },
  },
  USDT: {
    [mainnet.id]: { symbol: 'USDT', address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6 },
    [arbitrum.id]: { symbol: 'USDT', address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', decimals: 6 },
    [optimism.id]: { symbol: 'USDT', address: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e68', decimals: 6 },
    [polygon.id]: { symbol: 'USDT', address: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', decimals: 6 },
  },
}

/** Get all tokens available on a given chain. */
export function getTokensForChain(chainId: number): TokenInfo[] {
  return Object.values(TOKEN_MAP)
    .map((chainMap) => chainMap[chainId])
    .filter(Boolean)
}

/** USDC on Base — the settlement currency. */
export const SETTLEMENT_TOKEN = TOKEN_MAP.USDC[base.id]

/** Fixed entry in USDC smallest unit ($5 = 5_000_000). */
export const ENTRY_AMOUNT_USDC = '5000000'
export const ENTRY_AMOUNT_DISPLAY = 5

// ---------------------------------------------------------------------------
// Wagmi + Relay config
// ---------------------------------------------------------------------------

export const wagmiConfig = getDefaultConfig({
  appName: 'Chain Roulette',
  projectId: 'chain-roulette-demo',
  chains: [base, arbitrum, optimism, mainnet, polygon, zora],
  transports: {
    [mainnet.id]: http(),
    [base.id]: http(),
    [arbitrum.id]: http(),
    [optimism.id]: http(),
    [polygon.id]: http(),
    [zora.id]: http(),
  },
})

createClient({
  baseApiUrl: MAINNET_RELAY_API,
  source: 'chain-roulette',
  chains: SUPPORTED_CHAINS.map((c) => convertViemChainToRelayChain(c)),
})

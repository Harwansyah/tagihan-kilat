import { connectorsForWallets } from "@rainbow-me/rainbowkit";
import {
  injectedWallet,
  metaMaskWallet,
  rabbyWallet,
  walletConnectWallet,
} from "@rainbow-me/rainbowkit/wallets";
import type { Chain } from "viem";
import { createConfig, http, type Transport } from "wagmi";
import { networks, walletConnectProjectId } from "./env";

const appName = "Aevum Starter Kit";

// With a WalletConnect project id: extension wallets + QR for mobile wallets.
// Without one: any injected browser wallet (MetaMask, Rabby, …) still works.
const connectors = connectorsForWallets(
  walletConnectProjectId
    ? [
        { groupName: "Popular", wallets: [metaMaskWallet, rabbyWallet, walletConnectWallet] },
        { groupName: "More", wallets: [injectedWallet] },
      ]
    : [{ groupName: "Browser wallet", wallets: [injectedWallet] }],
  { appName, projectId: walletConnectProjectId ?? "not-set" },
);

const chains = networks.map((n) => n.chain) as [Chain, ...Chain[]];

export const wagmiConfig = createConfig({
  chains,
  connectors,
  // The Aevum public RPC sometimes hangs on eth_call (observed 2026-11-25: ~1 in 5
  // calls never answered). viem's default http timeout is 10s, so a hung call fails
  // the whole simulate/send flow with "Internal JSON-RPC error" in the wallet.
  // Give it a long timeout and several retries so a slow node doesn't break the demo.
  transports: Object.fromEntries(
    chains.map((c) => [
      c.id,
      http(c.rpcUrls.default.http[0], { timeout: 30_000, retryCount: 4, retryDelay: 500 }),
    ]),
  ) as Record<number, Transport>,
  ssr: true,
});

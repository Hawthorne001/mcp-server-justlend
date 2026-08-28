import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as services from "../services/index.js";
import { resolveKnownToken } from "../services/tokens.js";
import { utils } from "../services/utils.js";
import { getWalletMode, setWalletMode } from "../services/global.js";
import { getBrowserSigner } from "../services/wallet.js";
import { tronAddress, amountString, toolError } from "./shared.js";

export function registerWalletTools(server: McpServer) {

  // ============================================================================
  // WALLET & NETWORK (Read-only)
  // ============================================================================

  server.registerTool(
    "get_wallet_address",
    {
      description:
        "Get the active agent-wallet address, or a first-use wallet setup guide if no wallet mode has been chosen yet. " +
        "Legacy browser mode is disabled until its bridge supports request-level authentication.",
      inputSchema: {},
      annotations: { title: "Get Wallet Address", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      try {
        const mode = getWalletMode();
        if (mode === "unset") {
          const status = await services.checkWalletStatus().catch(() => null);
          return { content: [{ type: "text", text: JSON.stringify({
            walletMode: "unset",
            address: null,
            agentWalletAvailable: !!status?.activeAddress,
            agentAddress: status?.activeAddress ?? null,
            message: "No wallet mode selected yet. Choose how you want to sign transactions before your first write operation.",
            options: {
              recommended: {
                mode: "agent",
                action: "set_wallet_mode",
                params: { mode: "agent" },
                reason: status?.activeAddress
                  ? "Use the existing encrypted agent-wallet."
                  : "Create or use an encrypted agent-wallet stored in ~/.agent-wallet/.",
              },
              browser: {
                available: false,
                reason: "Disabled until the local bridge supports request-level authentication.",
              },
            },
          }, null, 2) }] };
        }
        if (mode === "browser") {
          return { content: [{ type: "text", text: JSON.stringify({
            walletMode: "browser",
            connected: false,
            message: "Browser wallet mode is disabled. Switch to agent mode with set_wallet_mode.",
          }, null, 2) }], isError: true };
        }

        const { address, walletId, created } = await services.autoInitWallet();
        if (created) {
          return { content: [{ type: "text", text: JSON.stringify({
            address,
            walletId,
            walletMode: "agent",
            newlyCreated: true,
            message: "New wallet auto-generated. Encrypted private key stored in ~/.agent-wallet/. Fund this address with TRX before performing write operations.",
            tip: "Use AGENT_WALLET_PASSWORD so the encryption key is not stored next to the wallet.",
          }, null, 2) }] };
        }
        const status = await services.checkWalletStatus();
        return { content: [{ type: "text", text: JSON.stringify({
          address,
          walletId,
          walletMode: "agent",
          totalWallets: status.wallets.length,
          message: "This wallet will be used for all JustLend operations",
          tip: "Use AGENT_WALLET_PASSWORD so the encryption key is not stored next to the wallet.",
        }, null, 2) }] };
      } catch (error: any) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "list_wallets",
    {
      description: "List all wallets configured in agent-wallet. Shows wallet IDs, types, active status, and addresses.",
      inputSchema: {},
      annotations: { title: "List Wallets", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      try {
        const status = await services.checkWalletStatus();
        return { content: [{ type: "text", text: JSON.stringify({
          initialized: status.initialized,
          activeWalletId: status.activeWalletId,
          wallets: status.wallets,
          message: status.message,
        }, null, 2) }] };
      } catch (error: any) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "set_active_wallet",
    {
      description: "Set the active wallet by wallet ID. Use list_wallets to see available wallet IDs.",
      inputSchema: {
        walletId: z.string().describe("The wallet ID to set as active"),
      },
      annotations: { title: "Set Active Wallet", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ walletId }: { walletId: string }) => {
      const result = services.setActiveWallet(walletId);
      if (!result.success) {
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], isError: true };
      }
      // Return new status after switching
      const status = await services.checkWalletStatus();
      return { content: [{ type: "text", text: JSON.stringify({
        ...result,
        activeAddress: status.activeAddress,
        wallets: status.wallets,
      }, null, 2) }] };
    },
  );

  // ============================================================================
  // BROWSER WALLET (disabled until the loopback bridge is authenticated)
  // ============================================================================

  server.registerTool(
    "connect_browser_wallet",
    {
      description:
        "Browser wallet signing is temporarily disabled because the legacy local bridge lacks request-level authentication. " +
        "Use agent-wallet with AGENT_WALLET_PASSWORD until an authenticated bridge is available.",
      inputSchema: {
        address: tronAddress("Required TRON address (T...). If set, the user must connect this exact address.").optional(),
      },
      annotations: { title: "Connect Browser Wallet", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ address }: { address?: string }) => {
      try {
        void address;
        throw new Error(
          "Browser wallet signing is disabled: the legacy loopback bridge has no request-level authentication. " +
          "Use set_wallet_mode with mode='agent'.",
        );
      } catch (error: any) {
        // Revert to agent mode on failure
        setWalletMode("agent");
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "set_wallet_mode",
    {
      description:
        "Switch wallet signing mode. " +
        "'agent' uses an encrypted key stored in ~/.agent-wallet/. " +
        "Browser mode is disabled until the local bridge supports request-level authentication. " +
        "Selecting agent mode for the first time will create an encrypted agent-wallet if needed.",
      inputSchema: {
        mode: z.enum(["browser", "agent"]).describe("Wallet mode: 'browser' or 'agent'"),
      },
      annotations: { title: "Set Wallet Mode", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ mode }: { mode: "browser" | "agent" }) => {
      try {
        if (mode === "browser") {
          return { content: [{ type: "text", text: JSON.stringify({
            success: false,
            message: "Browser wallet mode is disabled until its local bridge supports request-level authentication.",
          }, null, 2) }], isError: true };
        }
        setWalletMode("agent");
        const { address, walletId, created } = await services.autoInitWallet();
        return { content: [{ type: "text", text: JSON.stringify({
          mode: "agent",
          address,
          walletId,
          ...(created ? { newlyCreated: true } : {}),
          message: address
            ? created
              ? `Switched to agent wallet mode. New encrypted wallet created: ${address}`
              : `Switched to agent wallet mode. Active address: ${address}`
            : "Switched to agent wallet mode.",
        }, null, 2) }] };
      } catch (error: any) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "get_wallet_mode",
    {
      description: "Get the current wallet signing mode and agent-wallet status. Legacy browser mode is reported as disabled.",
      inputSchema: {},
      annotations: { title: "Get Wallet Mode", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const mode = getWalletMode();
      const browserAddress = getBrowserSigner().getConnectedAddress();
      let agentAddress: string | null = null;
      let agentWalletAvailable = false;
      try {
        const status = await services.checkWalletStatus();
        agentAddress = status.activeAddress;
        agentWalletAvailable = !!status.activeAddress;
      } catch (err: any) {
        console.warn(`[get_wallet_mode] checkWalletStatus failed: ${err?.message ?? err}`);
      }

      return { content: [{ type: "text", text: JSON.stringify({
        mode,
        address: mode === "browser" ? browserAddress : mode === "agent" ? agentAddress : null,
        browserConnected: browserAddress !== null,
        browserAddress,
        agentAddress,
        agentWalletAvailable,
        recommendation: "Use agent mode with AGENT_WALLET_PASSWORD; browser mode is temporarily disabled.",
      }, null, 2) }] };
    },
  );

  // ============================================================================
  // GLOBAL CONFIGURATION
  // ============================================================================

  server.registerTool(
    "set_network",
    {
      description: "Set the global default network used by all JustLend operations unless explicitly overridden.",
      inputSchema: {
        network: z.string().describe("Network name (mainnet, nile)."),
      },
      annotations: { title: "Set Global Network", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ network }) => {
      try {
        services.setGlobalNetwork(network);
        return { content: [{ type: "text", text: `Successfully switched global default network to: ${network}` }] };
      } catch (error: any) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "get_network",
    {
      description: "Get the current global default network used by all JustLend operations.",
      inputSchema: {},
      annotations: { title: "Get Global Network", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      return { content: [{ type: "text", text: `Current global default network: ${services.getGlobalNetwork()}` }] };
    },
  );

  // ============================================================================
  // TRANSFER
  // ============================================================================

  server.registerTool(
    "transfer_trx",
    {
      description:
        "Transfer TRX to another TRON address. " +
        "Checks balance sufficiency (including gas) before sending. " +
        "Typical cost: ~0 energy + ~270 bandwidth.",
      inputSchema: {
        to: tronAddress("Recipient TRON address (Base58 T... format)"),
        amount: amountString("Amount of TRX to transfer (e.g. '1', '10.5')"),
        network: z.string().optional().describe("Network. Default: mainnet"),
      },
      annotations: { title: "Transfer TRX", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ to, amount, network = services.getGlobalNetwork() }) => {
      try {
        const txId = await services.transferTRX(to, amount, network);
        return { content: [{ type: "text", text: JSON.stringify({
          success: true,
          txId,
          from: await services.getWalletAddress(),
          to,
          amount: `${amount} TRX`,
          network,
        }, null, 2) }] };
      } catch (error: any) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "transfer_trc20",
    {
      description:
        "Transfer TRC20 tokens to another TRON address. " +
        "You can pass a token symbol (e.g. 'USDT', 'JST', 'wstUSDT') or a contract address. " +
        "Symbol resolution uses the server's known TRON token registry and JustLend underlying-token mappings. " +
        "Amount is in human-readable units (e.g. '100' for 100 USDT). " +
        "Checks balance sufficiency before sending.",
      inputSchema: {
        to: tronAddress("Recipient TRON address (Base58 T... format)"),
        amount: amountString("Amount to transfer in human-readable units (e.g. '100' for 100 USDT)"),
        token: z.string().optional().describe("Token symbol (e.g. 'USDT', 'JST', 'SUN'). Preferred over tokenAddress."),
        tokenAddress: tronAddress("TRC20 token contract address. Use 'token' parameter instead when possible.").optional(),
        network: z.string().optional().describe("Network. Default: mainnet"),
      },
      annotations: { title: "Transfer TRC20", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ to, amount, token, tokenAddress, network = services.getGlobalNetwork() }) => {
      try {
        const resolvedToken = token ? resolveKnownToken(token, network) : null;
        const resolvedAddress = tokenAddress || resolvedToken?.address;
        if (!resolvedAddress) {
          if (token) {
            throw new Error(
              `Unknown token symbol: ${token}. ` +
              "Use a known TRON token symbol or provide the TRC20 contract address directly via tokenAddress.",
            );
          }
          throw new Error("Either 'token' or 'tokenAddress' must be provided.");
        }

        // Resolve real decimals: known-symbol path is trusted; otherwise
        // (raw address, or symbol that resolved by address) fetch on-chain
        // metadata so we never silently default to 18.
        let decimals = resolvedToken?.decimals;
        if (decimals == null) {
          const info = await services.getTRC20TokenInfo(resolvedAddress, network);
          decimals = info.decimals;
        }
        const rawAmount = utils.parseUnits(amount, decimals).toString();

        const result = await services.transferTRC20(resolvedAddress, to, rawAmount, network);
        return { content: [{ type: "text", text: JSON.stringify({
          success: true,
          txId: result.txHash,
          from: await services.getWalletAddress(),
          to,
          amount: `${amount} ${result.token.symbol}`,
          network,
        }, null, 2) }] };
      } catch (error: any) {
        return toolError(error);
      }
    },
  );
}

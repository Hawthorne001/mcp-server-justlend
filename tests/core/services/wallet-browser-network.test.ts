import { beforeEach, describe, expect, it } from "vitest";
import {
  createSessionState,
  runWithSessionState,
  setWalletMode,
} from "../../../src/core/services/global.js";
import {
  getWalletAddress,
  signMessage,
  signTransactionWithWallet,
  signTypedData,
} from "../../../src/core/services/wallet.js";
import { TronWalletSigner } from "../../../src/core/browser-signer.js";

describe("unauthenticated browser bridge shutdown", () => {
  beforeEach(() => {
    // Each test uses an isolated MCP session state.
  });

  it("refuses browser wallet address resolution", async () => {
    const session = createSessionState("wallet-browser-address-disabled");
    await runWithSessionState(session, async () => {
      setWalletMode("browser");
      await expect(getWalletAddress()).rejects.toThrow(/disabled.*request-level authentication/i);
    });
  });

  it("refuses browser message and typed-data signing", async () => {
    const session = createSessionState("wallet-browser-messages-disabled");
    await runWithSessionState(session, async () => {
      setWalletMode("browser");
      await expect(signMessage("hello")).rejects.toThrow(/disabled.*unauthenticated/i);
      await expect(signTypedData({}, {}, {})).rejects.toThrow(/disabled.*unauthenticated/i);
    });
  });

  it("refuses browser transaction signing and never starts a loopback server", async () => {
    const session = createSessionState("wallet-browser-tx-disabled");
    await runWithSessionState(session, async () => {
      setWalletMode("browser");
      await expect(signTransactionWithWallet({ txID: "unsigned" }, "test", "nile"))
        .rejects.toThrow(/disabled.*unauthenticated/i);
    });
    const signer = new TronWalletSigner();
    await expect(signer.start()).rejects.toThrow(/no request-level authentication/i);
    expect(signer.getConnectedAddress()).toBeNull();
  });
});

import { beforeEach, describe, expect, it } from "vitest";
import {
  createSessionState,
  getActiveWalletId,
  getGlobalNetwork,
  getWalletMode,
  runWithSessionState,
  setGlobalNetwork,
  setActiveWalletId,
  setWalletMode,
} from "../../../src/core/services/global.js";

describe("global session state", () => {
  beforeEach(() => {
    setGlobalNetwork("mainnet");
    setWalletMode("unset");
  });

  it("uses the fallback process state when no session context is bound", () => {
    expect(getGlobalNetwork()).toBe("mainnet");
    expect(getWalletMode()).toBe("unset");

    setGlobalNetwork("nile");
    setWalletMode("agent");

    expect(getGlobalNetwork()).toBe("nile");
    expect(getWalletMode()).toBe("agent");
  });

  it("isolates network and wallet mode between concurrent session states", () => {
    const sessionA = createSessionState("session-a");
    const sessionB = createSessionState("session-b");

    runWithSessionState(sessionA, () => {
      setGlobalNetwork("nile");
      setWalletMode("browser");
      expect(getGlobalNetwork()).toBe("nile");
      expect(getWalletMode()).toBe("browser");
    });

    runWithSessionState(sessionB, () => {
      expect(getGlobalNetwork()).toBe("mainnet");
      expect(getWalletMode()).toBe("unset");
      setWalletMode("agent");
    });

    runWithSessionState(sessionA, () => {
      expect(getGlobalNetwork()).toBe("nile");
      expect(getWalletMode()).toBe("browser");
    });

    runWithSessionState(sessionB, () => {
      expect(getGlobalNetwork()).toBe("mainnet");
      expect(getWalletMode()).toBe("agent");
    });
  });

  it("isolates the selected wallet between session states", () => {
    const sessionA = createSessionState("wallet-a");
    const sessionB = createSessionState("wallet-b");

    runWithSessionState(sessionA, () => {
      setActiveWalletId("wallet-one");
      expect(getActiveWalletId()).toBe("wallet-one");
    });

    runWithSessionState(sessionB, () => {
      expect(getActiveWalletId()).toBeUndefined();
      setActiveWalletId("wallet-two");
    });

    runWithSessionState(sessionA, () => expect(getActiveWalletId()).toBe("wallet-one"));
    runWithSessionState(sessionB, () => expect(getActiveWalletId()).toBe("wallet-two"));
  });
});

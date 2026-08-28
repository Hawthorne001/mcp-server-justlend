import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/core/services/wallet.js", () => ({
  getWalletAddress: vi.fn(),
  getSigningClient: vi.fn(),
  signTransactionWithWallet: vi.fn(),
}));

vi.mock("../../../src/core/services/clients.js", () => ({
  getTronWeb: vi.fn(),
}));

import {
  DEFAULT_ENERGY_PURCHASE_API_URL,
  EnergyPurchaseApi,
  EnergyPurchaseError,
  FileEnergyPaymentRiskStore,
  type EnergyPaymentRisk,
  type EnergyPaymentRiskStore,
} from "../../../src/core/services/energy-purchase.js";
import { getSigningClient, getWalletAddress, signTransactionWithWallet } from "../../../src/core/services/wallet.js";
import { getTronWeb } from "../../../src/core/services/clients.js";

const PAYER = "TJRabPrwbZy45sbavfcjinPJC18kjpRTv8";
const SECOND_PAYER = "TMwFHYXLJaRUPeW6421aqXL4ZEzPRFGkGT";
const RECEIVER = "TVjsyZ7fYF3qLF6BQgPmTEZy1xrNNyVAAA";
const PAY_ADDRESS = "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb";
const TX_ID = "ab".repeat(32);
const RAW_HEX = "cd".repeat(16);

function envelope(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ code: "0", msg: "ok", data }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function config() {
  return {
    min_energy: 65000,
    max_energy: 5000000,
    max_batch_receivers: 50,
    supported_durations: ["1h"],
    energy_presets: [65000],
    payment_address: PAY_ADDRESS,
  };
}

class MemoryRiskStore implements EnergyPaymentRiskStore {
  risks: EnergyPaymentRisk[] = [];
  intents = new Map<string, string>();
  list(payerAddress: string) { return this.risks.filter(risk => risk.payerAddress === payerAddress); }
  save(risk: EnergyPaymentRisk) {
    this.risks = this.risks.filter(item => !(item.payerAddress === risk.payerAddress && item.signedTxId === risk.signedTxId));
    this.risks.push({ ...risk });
  }
  remove(payerAddress: string, signedTxId?: string) {
    this.risks = this.risks.filter(risk =>
      risk.payerAddress !== payerAddress || (signedTxId !== undefined && risk.signedTxId !== signedTxId),
    );
  }
  acquireIntent(payerAddress: string) {
    if (this.intents.has(payerAddress)) {
      throw new EnergyPurchaseError("PAYMENT_IN_PROGRESS", "Another payment is in progress.");
    }
    const token = `intent-${payerAddress}`;
    this.intents.set(payerAddress, token);
    return token;
  }
  releaseIntent(payerAddress: string, token: string) {
    if (this.intents.get(payerAddress) === token) this.intents.delete(payerAddress);
  }
}

function tronWebHarness() {
  const unsigned = { txID: "unsigned", raw_data: { expiration: 1000, contract: [] }, raw_data_hex: "00", visible: false };
  const extended = { ...unsigned, raw_data: { ...unsigned.raw_data, expiration: 300001 } };
  return {
    fullNode: { host: "https://api.trongrid.io" },
    utils: { transaction: {
      txJsonToPb: vi.fn((transaction: unknown) => transaction),
      txPbToRawDataHex: vi.fn(() => RAW_HEX),
      txPbToTxID: vi.fn(() => TX_ID),
    } },
    transactionBuilder: {
      sendTrx: vi.fn(async () => unsigned),
      extendExpiration: vi.fn(async () => extended),
    },
    trx: {
      getBalance: vi.fn(async () => 10_000_000),
      getUnconfirmedTransactionInfo: vi.fn(async () => ({})),
      getTransactionInfo: vi.fn(async () => ({})),
      getTransaction: vi.fn(async () => null),
    },
  };
}

describe("energy direct-purchase service", () => {
  const previousEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.JUSTLEND_ALLOW_UNTRUSTED_HOSTS = "1";
    delete process.env.JUSTLEND_ENERGY_API_URL;
  });

  afterEach(() => {
    process.env = { ...previousEnv };
  });

  it("uses the official production endpoint without an untrusted-host opt-in", () => {
    delete process.env.JUSTLEND_ALLOW_UNTRUSTED_HOSTS;
    const api = new EnergyPurchaseApi({ fetch: vi.fn() });
    expect(api.baseUrl).toBe(DEFAULT_ENERGY_PURCHASE_API_URL);
  });

  it("does not pair the production API with a non-mainnet signer", async () => {
    delete process.env.JUSTLEND_ALLOW_UNTRUSTED_HOSTS;
    vi.mocked(getWalletAddress).mockResolvedValue(PAYER);
    const api = new EnergyPurchaseApi({ fetch: vi.fn(), riskStore: new MemoryRiskStore() });

    await expect(api.purchase({
      receivers: [RECEIVER],
      energyPerReceiver: 65000,
      duration: "1h",
      expectedAmountSun: 2340000,
      expectedPayAddress: PAY_ADDRESS,
      network: "nile",
    })).rejects.toMatchObject({ code: "CONFIG_MISSING" });
    expect(getSigningClient).not.toHaveBeenCalled();
  });

  it("normalizes the app production config and quote contract", async () => {
    delete process.env.JUSTLEND_ALLOW_UNTRUSTED_HOSTS;
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/v1/config")) return envelope({
        min_energy: 65000,
        max_energy: 5000000,
        max_receivers: 50,
        presets: [65000, 131000],
        durations: ["1h"],
        activation_fee_sun: 1100000,
      });
      if (String(input).endsWith("/v1/price")) {
        expect(JSON.parse(String(init?.body))).toEqual({
          receivers: [RECEIVER],
          energy_per_receiver: 65000,
        });
        return envelope({ amount_sun: 2340000, amount_trx: "2.34", pay_address: PAY_ADDRESS, can_fulfill: true });
      }
      throw new Error(`unexpected ${input}`);
    });
    const api = new EnergyPurchaseApi({ fetch });

    const liveConfig = await api.getConfig();
    expect(liveConfig).toMatchObject({
      max_batch_receivers: 50,
      energy_presets: [65000, 131000],
      supported_durations: ["1h"],
    });
    await expect(api.quote([RECEIVER], 65000, "1h", liveConfig)).resolves.toMatchObject({
      total_sun: 2340000,
      total_trx: "2.34",
      payment_address: PAY_ADDRESS,
      amount_sun: 2340000,
      pay_address: PAY_ADDRESS,
    });
  });

  it("reads public payer history with optional server pagination", async () => {
    const calls: string[] = [];
    const api = new EnergyPurchaseApi({
      baseUrl: "https://energy.example",
      fetch: vi.fn(async (input: string | URL | Request) => {
        calls.push(String(input));
        return envelope({ total: 1, page: 2, size: 10, rows: [{ order_id: "7", payment_tx_id: TX_ID }] });
      }),
    });

    await expect(api.getHistory(PAYER, { page: 2, size: 10 })).resolves.toMatchObject({ total: 1 });
    expect(calls[0]).toContain("/v1/consumer/energy/orders/history?address=");
    expect(calls[0]).toContain("page=2");
    expect(calls[0]).toContain("size=10");
  });

  it("validates a read-only quote against live config", async () => {
    const fetch = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith("/v1/config")) return envelope(config());
      throw new Error(`unexpected ${input}`);
    });
    const api = new EnergyPurchaseApi({ baseUrl: "https://energy.example", fetch });

    await expect(api.quote([RECEIVER], 1, "1h")).rejects.toMatchObject({ code: "INVALID_AMOUNT" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("fails closed without overwriting a corrupt payment-risk file", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-energy-risks-"));
    const file = path.join(directory, "risks.json");
    fs.writeFileSync(file, "{not-json", { mode: 0o600 });
    const store = new FileEnergyPaymentRiskStore(file);

    try {
      expect(() => store.list(PAYER)).toThrowError(expect.objectContaining({ code: "PAYMENT_RISK_STORE_INVALID" }));
      expect(() => store.save({
        payerAddress: PAYER,
        signedTxId: "new-id",
        createdAt: 1,
        expiresAt: 2,
        paymentConfirmed: false,
      })).toThrowError(expect.objectContaining({ code: "PAYMENT_RISK_STORE_INVALID" }));
      expect(fs.readFileSync(file, "utf8")).toBe("{not-json");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("acquires the payment intent atomically across store instances", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-energy-intent-"));
    const file = path.join(directory, "risks.json");
    const firstStore = new FileEnergyPaymentRiskStore(file);
    const secondStore = new FileEnergyPaymentRiskStore(file);
    const firstToken = firstStore.acquireIntent(PAYER, Date.now() + 60_000);

    try {
      expect(() => secondStore.acquireIntent(PAYER, Date.now() + 60_000))
        .toThrowError(expect.objectContaining({ code: "PAYMENT_IN_PROGRESS" }));
      firstStore.releaseIntent(PAYER, firstToken);
      const secondToken = secondStore.acquireIntent(PAYER, Date.now() + 60_000);
      secondStore.releaseIntent(PAYER, secondToken);
    } finally {
      try { firstStore.releaseIntent(PAYER, firstToken); } catch { /* Already released. */ }
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("holds the shared mutation lock while releasing and finalizing intents", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-energy-intent-lifecycle-"));
    const file = path.join(directory, "risks.json");
    const intentPath = `${file}.${PAYER}.intent`;
    const mutationLockPath = `${file}.mutation.lock`;
    const store = new FileEnergyPaymentRiskStore(file);
    const internals = store as unknown as {
      readIntent(path: string): unknown;
    };
    const readIntent = internals.readIntent.bind(store);
    const observedLockStates: boolean[] = [];
    internals.readIntent = (target) => {
      observedLockStates.push(fs.existsSync(mutationLockPath));
      return readIntent(target);
    };

    try {
      const releaseToken = store.acquireIntent(PAYER, Date.now() + 60_000);
      store.releaseIntent(PAYER, releaseToken);
      expect(fs.existsSync(intentPath)).toBe(false);

      const finalizeToken = store.acquireIntent(PAYER, Date.now() + 60_000);
      const risk: EnergyPaymentRisk = {
        payerAddress: PAYER,
        signedTxId: "finalized",
        createdAt: 1,
        expiresAt: 2,
        paymentConfirmed: false,
      };
      store.finalizeIntent(PAYER, finalizeToken, risk);

      expect(observedLockStates).toEqual([true, true]);
      expect(fs.existsSync(intentPath)).toBe(false);
      expect(store.list(PAYER)).toEqual([risk]);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("serializes the shared risk-file read-modify-write across payer stores", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-energy-risk-lock-"));
    const file = path.join(directory, "risks.json");
    const firstStore = new FileEnergyPaymentRiskStore(file);
    const secondStore = new FileEnergyPaymentRiskStore(file);
    const firstRisk: EnergyPaymentRisk = {
      payerAddress: PAYER,
      signedTxId: "first",
      createdAt: 1,
      expiresAt: 2,
      paymentConfirmed: false,
    };
    const secondRisk: EnergyPaymentRisk = {
      payerAddress: SECOND_PAYER,
      signedTxId: "second",
      createdAt: 1,
      expiresAt: 2,
      paymentConfirmed: false,
    };
    const firstInternals = firstStore as unknown as {
      writeAll(risks: EnergyPaymentRisk[]): void;
    };
    const writeAll = firstInternals.writeAll.bind(firstStore);
    firstInternals.writeAll = (risks) => {
      expect(() => secondStore.save(secondRisk))
        .toThrowError(expect.objectContaining({ code: "PAYMENT_RISK_STORE_BUSY" }));
      writeAll(risks);
    };

    try {
      firstStore.save(firstRisk);
      secondStore.save(secondRisk);
      expect(firstStore.list(PAYER)).toEqual([firstRisk]);
      expect(firstStore.list(SECOND_PAYER)).toEqual([secondRisk]);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("signs without local broadcast and retries only the same signed transaction", async () => {
    const tronWeb = tronWebHarness();
    vi.mocked(getWalletAddress).mockResolvedValue(PAYER);
    vi.mocked(getSigningClient).mockResolvedValue(tronWeb as any);
    vi.mocked(getTronWeb).mockReturnValue(tronWeb as any);
    vi.mocked(signTransactionWithWallet).mockImplementation(async transaction => ({ ...transaction, signature: ["aa"] }));
    const store = new MemoryRiskStore();
    const submitted: string[] = [];
    let buyCalls = 0;
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/config")) return envelope(config());
      if (url.endsWith("/v1/price")) {
        return envelope({ total_sun: 2405000, total_trx: "2.405" });
      }
      if (url.endsWith("/v1/consumer/energy/buy")) {
        expect(init?.redirect).toBe("error");
        const submittedRequest = JSON.parse(String(init?.body));
        submitted.push(submittedRequest.signed_transaction.txID);
        expect(submittedRequest.energy_per_receiver).toBe(65000);
        expect(submittedRequest.energy).toBeUndefined();
        expect(submittedRequest.signed_transaction.raw_data).toBeDefined();
        buyCalls += 1;
        if (buyCalls === 1) throw new Error("connection reset");
        return envelope({ id: "7", access_token: "token", state: "paid", tx_id: TX_ID });
      }
      if (url.endsWith("/v1/consumer/energy/orders/7")) return envelope({ id: 7, state: "delivered" });
      if (url.includes("/v1/consumer/energy/orders/history?")) {
        return envelope({ rows: [{ order_id: "7", payment_tx_id: TX_ID }] });
      }
      throw new Error(`unexpected ${url}`);
    });
    const api = new EnergyPurchaseApi({
      baseUrl: "https://energy.example",
      fetch,
      riskStore: store,
      sleep: async () => {},
      now: () => 1,
    });

    const result = await api.purchase({
      receivers: [RECEIVER],
      energyPerReceiver: 65000,
      duration: "1h",
      expectedAmountSun: 2405000,
      expectedPayAddress: PAY_ADDRESS,
      network: "mainnet",
    });

    expect(submitted).toEqual([TX_ID, TX_ID]);
    expect(signTransactionWithWallet).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: true, orderId: "7", txHash: TX_ID, state: "delivered" });
    expect(store.risks).toEqual([]);
    expect("sendRawTransaction" in tronWeb.trx).toBe(false);
  });

  it("returns tokenless idempotent orders without polling and retains risk until history confirms them", async () => {
    const tronWeb = tronWebHarness();
    vi.mocked(getWalletAddress).mockResolvedValue(PAYER);
    vi.mocked(getSigningClient).mockResolvedValue(tronWeb as any);
    vi.mocked(getTronWeb).mockReturnValue(tronWeb as any);
    vi.mocked(signTransactionWithWallet).mockImplementation(async transaction => ({ ...transaction, signature: ["aa"] }));
    const store = new MemoryRiskStore();
    let historyVisible = false;
    let orderPollCalls = 0;
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/v1/config")) return envelope(config());
      if (url.endsWith("/v1/price")) return envelope({ total_sun: 2405000, total_trx: "2.405" });
      if (url.endsWith("/v1/consumer/energy/buy")) {
        return envelope({ batch: { id: "9", access_token: null, state: "paid" }, payment: { tx_hash: TX_ID } });
      }
      if (url.includes("/v1/consumer/energy/orders/history?")) {
        return envelope({ rows: historyVisible ? [{ order_id: "9", payment_tx_id: TX_ID }] : [] });
      }
      if (url.includes("/v1/consumer/energy/orders/9")) {
        orderPollCalls += 1;
        return envelope({ id: 9, state: "delivered" });
      }
      throw new Error(`unexpected ${url}`);
    });
    const api = new EnergyPurchaseApi({
      baseUrl: "https://energy.example",
      fetch,
      riskStore: store,
      sleep: async () => {},
      now: () => 1,
      networkFingerprint: "mainnet-provider",
    });

    await expect(api.purchase({
      receivers: [RECEIVER],
      energyPerReceiver: 65000,
      duration: "1h",
      expectedAmountSun: 2405000,
      expectedPayAddress: PAY_ADDRESS,
      network: "mainnet",
    })).resolves.toMatchObject({
      orderId: "9",
      state: "paid",
      detail: null,
      reconciliationRequired: true,
    });
    expect(orderPollCalls).toBe(0);
    expect(store.risks).toHaveLength(1);
    expect(store.risks[0]?.paymentConfirmed).toBe(true);

    historyVisible = true;
    await expect(api.reconcilePaymentRisks(PAYER)).resolves.toEqual([]);
  });

  it("rejects a concurrent purchase for the same payer before a second signature", async () => {
    const tronWeb = tronWebHarness();
    vi.mocked(getWalletAddress).mockResolvedValue(PAYER);
    vi.mocked(getSigningClient).mockResolvedValue(tronWeb as any);
    vi.mocked(getTronWeb).mockReturnValue(tronWeb as any);
    let signStartedResolve!: () => void;
    let releaseSignature!: () => void;
    const signStarted = new Promise<void>(resolve => { signStartedResolve = resolve; });
    const signatureGate = new Promise<void>(resolve => { releaseSignature = resolve; });
    vi.mocked(signTransactionWithWallet).mockImplementation(async transaction => {
      signStartedResolve();
      await signatureGate;
      return { ...transaction, signature: ["aa"] };
    });
    const store = new MemoryRiskStore();
    let buyCalls = 0;
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/v1/config")) return envelope(config());
      if (url.endsWith("/v1/price")) {
        return envelope({ total_sun: 2405000, total_trx: "2.405" });
      }
      if (url.endsWith("/v1/consumer/energy/buy")) {
        buyCalls += 1;
        return envelope({ batch: { id: "7", access_token: "token", state: "paid" }, payment: { tx_hash: TX_ID } });
      }
      if (url.endsWith("/v1/consumer/energy/orders/7")) return envelope({ id: 7, state: "delivered" });
      throw new Error(`unexpected ${url}`);
    });
    const api = new EnergyPurchaseApi({
      baseUrl: "https://energy.example",
      fetch,
      riskStore: store,
      sleep: async () => {},
      now: () => 1,
    });
    const input = {
      receivers: [RECEIVER],
      energyPerReceiver: 65000,
      duration: "1h",
      expectedAmountSun: 2405000,
      expectedPayAddress: PAY_ADDRESS,
      network: "mainnet",
    };

    const first = api.purchase(input);
    await signStarted;
    await expect(api.purchase(input)).rejects.toMatchObject({ code: "PAYMENT_IN_PROGRESS" });
    releaseSignature();
    await expect(first).resolves.toMatchObject({ ok: true, orderId: "7" });

    expect(signTransactionWithWallet).toHaveBeenCalledTimes(1);
    expect(buyCalls).toBe(1);
  });

  it("requires the live quote to exactly match the confirmed amount", async () => {
    const tronWeb = tronWebHarness();
    vi.mocked(getWalletAddress).mockResolvedValue(PAYER);
    vi.mocked(getSigningClient).mockResolvedValue(tronWeb as any);
    vi.mocked(getTronWeb).mockReturnValue(tronWeb as any);
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/v1/config")) return envelope(config());
      if (url.endsWith("/v1/price")) {
        return envelope({ total_sun: 2405001, total_trx: "2.405001" });
      }
      throw new Error(`unexpected ${url}`);
    });
    const store = new MemoryRiskStore();
    const api = new EnergyPurchaseApi({
      baseUrl: "https://energy.example",
      fetch,
      riskStore: store,
    });

    await expect(api.purchase({
      receivers: [RECEIVER],
      energyPerReceiver: 65000,
      duration: "1h",
      expectedAmountSun: 2405000,
      expectedPayAddress: PAY_ADDRESS,
      network: "mainnet",
    })).rejects.toMatchObject({
      code: "AMOUNT_CHANGED",
      details: { expectedAmountSun: 2405000, amountSun: 2405001 },
    });
    expect(signTransactionWithWallet).not.toHaveBeenCalled();
    expect(store.intents.size).toBe(0);
  });

  it("retains an expired risk when the chain lookup is unavailable", async () => {
    const tronWeb = tronWebHarness();
    tronWeb.trx.getTransaction.mockRejectedValue(new Error("network unavailable"));
    vi.mocked(getTronWeb).mockReturnValue(tronWeb as any);
    const store = new MemoryRiskStore();
    store.risks.push({
      payerAddress: PAYER,
      signedTxId: "unknown-id",
      createdAt: 1,
      expiresAt: 2,
      paymentConfirmed: false,
    });
    const api = new EnergyPurchaseApi({
      baseUrl: "https://energy.example",
      fetch: vi.fn(),
      riskStore: store,
      now: () => 3,
    });

    await expect(api.reconcilePaymentRisks(PAYER)).resolves.toHaveLength(1);
  });

  it("records FullNode inclusion before SolidityNode finality", async () => {
    const tronWeb = tronWebHarness();
    tronWeb.trx.getUnconfirmedTransactionInfo.mockResolvedValue({
      id: TX_ID,
      blockNumber: 100,
      receipt: { result: "SUCCESS" },
    });
    vi.mocked(getTronWeb).mockReturnValue(tronWeb as any);
    const store = new MemoryRiskStore();
    const api = new EnergyPurchaseApi({
      baseUrl: "https://energy.example",
      networkFingerprint: "mainnet-provider",
      fetch: vi.fn(async () => new Response(JSON.stringify({
        code: "wallet_rpc_error",
        msg: "retry the same transaction",
        data: null,
      }), { status: 502, headers: { "content-type": "application/json" } })),
      riskStore: store,
    });
    store.risks.push({
      payerAddress: PAYER,
      signedTxId: TX_ID,
      createdAt: 1,
      expiresAt: 300001,
      paymentConfirmed: false,
      chainStatus: "unknown",
      chainExecution: "unknown",
      networkFingerprint: `api=${api.baseUrl};provider=mainnet-provider`,
      signedRequest: {
        receivers: [RECEIVER],
        energy: 65000,
        duration: "1h",
        payer_address: PAYER,
        signed_transaction: { txID: TX_ID, raw_data: {}, raw_data_hex: RAW_HEX, signature: ["aa"], visible: false },
      },
    });

    await expect(api.reconcilePaymentRisks(PAYER)).resolves.toMatchObject([{
      paymentConfirmed: false,
      chainStatus: "included",
      chainExecution: "success",
    }]);

    tronWeb.trx.getTransactionInfo.mockResolvedValue({
      id: TX_ID,
      blockNumber: 100,
      receipt: { result: "SUCCESS" },
    });
    await expect(api.reconcilePaymentRisks(PAYER)).resolves.toMatchObject([{
      paymentConfirmed: true,
      chainStatus: "solidified",
      chainExecution: "success",
    }]);
    expect(tronWeb.trx.getUnconfirmedTransactionInfo).toHaveBeenCalledWith(TX_ID);
    expect(tronWeb.trx.getTransactionInfo).toHaveBeenCalledWith(TX_ID);
  });
});

import fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { TronWeb } from "tronweb";
import { fetchWithTimeout } from "./http.js";
import { getSigningClient, getWalletAddress, signTransactionWithWallet } from "./wallet.js";
import { getTronWeb } from "./clients.js";

export const ENERGY_PURCHASE_PATHS = {
  config: "/v1/config",
  currentPrice: "/v1/price/current",
  poolHealth: "/v1/pool/health",
  quote: "/v1/price",
  buy: "/v1/consumer/energy/buy",
  history: "/v1/consumer/energy/orders/history",
  order: (id: string | number) => `/v1/consumer/energy/orders/${encodeURIComponent(String(id))}`,
} as const;

export const DEFAULT_ENERGY_PURCHASE_API_URL = "https://tegrow.ablesdxd.link";
const TRUSTED_ENERGY_PURCHASE_HOSTS = new Set(["tegrow.ablesdxd.link"]);

export const ENERGY_PURCHASE_TERMINAL_STATES = ["delivered", "partial", "failed", "expired", "cancelled"];

const ORDER_TTL_MS = 5 * 60 * 1000;
const PAYMENT_RETRY_TIMEOUT_MS = 2 * 60 * 1000;
const PAYMENT_INTENT_TTL_MS = 30 * 60 * 1000;
const DETERMINISTIC_PRE_BROADCAST_CODES = new Set([
  "ADDR_OVERFLOW", "BAD_REQUEST", "CONFIG_INVALID", "EMPTY_RECEIVERS",
  "INVALID_DURATION", "INVALID_RECEIVERS", "PAYMENT_CALC_FAILED",
  "POOL_INSUFFICIENT", "PRICE_MOVED", "RECEIVER_IS_CONTRACT", "TX_EXPIRED",
]);
const RISK_MUTATION_LOCK_WAIT_MS = 2_000;
const RISK_MUTATION_LOCK_RETRY_MS = 10;
const RISK_FILE = path.join(os.homedir(), ".mcp-server-justlend", "energy-payment-risks.json");
const activePayers = new Set<string>();
const mutationLockWaitBuffer = new Int32Array(new SharedArrayBuffer(4));

export class EnergyPurchaseError extends Error {
  code: string;
  status?: number;
  isBusinessError: boolean;
  retryable: boolean;
  details?: unknown;
  paymentRisk?: EnergyPaymentRisk;

  constructor(code: string, message?: string, options: {
    status?: number;
    isBusinessError?: boolean;
    retryable?: boolean;
    details?: unknown;
    cause?: unknown;
  } = {}) {
    super(message ? `${code}: ${message}` : code, { cause: options.cause });
    this.name = "EnergyPurchaseError";
    this.code = code;
    this.status = options.status;
    this.isBusinessError = options.isBusinessError === true;
    this.retryable = options.retryable === true;
    this.details = options.details;
  }
}

export interface EnergyPurchaseConfig {
  min_energy: number;
  max_energy: number;
  max_batch_receivers: number;
  energy_presets: number[];
  activation_fee_sun?: number;
  supported_durations: string[];
  payment_address?: string;
  [key: string]: unknown;
}

export interface EnergyPurchaseQuote {
  total_sun: number;
  total_trx?: string;
  payment_address: string;
  [key: string]: unknown;
}

export interface SignedEnergyPurchaseRequest {
  receivers: string[];
  energy_per_receiver: number;
  /** Legacy persisted field from pre-production contract drafts. */
  energy?: number;
  duration: string;
  payer_address: string;
  signed_transaction: {
    txID: string;
    raw_data: Record<string, unknown>;
    raw_data_hex: string;
    signature: string[];
    visible: boolean;
  };
}

export type EnergyPaymentChainStatus = "unknown" | "observed" | "included" | "solidified";
export type EnergyPaymentChainExecution = "unknown" | "success" | "failed";

export interface EnergyPaymentRisk {
  payerAddress: string;
  signedTxId: string;
  createdAt: number;
  expiresAt: number;
  paymentConfirmed: boolean;
  /** FullNode observation first, followed by SolidityNode finality. */
  chainStatus?: EnergyPaymentChainStatus;
  chainExecution?: EnergyPaymentChainExecution;
  networkFingerprint?: string;
  signedRequest?: SignedEnergyPurchaseRequest;
  recoveredOrder?: Record<string, unknown>;
}

export interface EnergyPaymentRiskStore {
  list(payerAddress: string): EnergyPaymentRisk[];
  save(risk: EnergyPaymentRisk): void;
  remove(payerAddress: string, signedTxId?: string): void;
  /** Acquire an atomic payer-scoped intent before any transaction is signed. */
  acquireIntent(payerAddress: string, expiresAt: number): string;
  /** Release only the intent owned by token. */
  releaseIntent(payerAddress: string, token: string): void;
  /** Atomically publish the signed risk before releasing the payer intent. */
  finalizeIntent?(payerAddress: string, token: string, risk: EnergyPaymentRisk): void;
}

export class FileEnergyPaymentRiskStore implements EnergyPaymentRiskStore {
  constructor(private readonly filePath = RISK_FILE) {}

  private readAll(): EnergyPaymentRisk[] {
    let source: string;
    try {
      source = fs.readFileSync(this.filePath, "utf8");
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new EnergyPurchaseError(
        "PAYMENT_RISK_STORE_UNAVAILABLE",
        "Unable to read the payment-risk store. New payments are blocked until it is repaired.",
        { cause },
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(source);
    } catch (cause) {
      throw new EnergyPurchaseError(
        "PAYMENT_RISK_STORE_INVALID",
        "The payment-risk store contains invalid JSON. New payments are blocked until it is repaired.",
        { cause },
      );
    }
    if (!Array.isArray(parsed) || !parsed.every(isEnergyPaymentRisk)) {
      throw new EnergyPurchaseError(
        "PAYMENT_RISK_STORE_INVALID",
        "The payment-risk store has an invalid schema. New payments are blocked until it is repaired.",
      );
    }
    return parsed;
  }

  private writeAll(risks: EnergyPaymentRisk[]): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temp = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(risks, null, 2), { mode: 0o600 });
    fs.renameSync(temp, this.filePath);
  }

  private mutationLockPath(): string {
    return `${this.filePath}.mutation.lock`;
  }

  private acquireMutationLock(): string {
    const lockPath = this.mutationLockPath();
    const deadline = Date.now() + RISK_MUTATION_LOCK_WAIT_MS;
    fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });

    for (;;) {
      const token = randomUUID();
      let descriptor: number;
      try {
        descriptor = fs.openSync(lockPath, "wx", 0o600);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "EEXIST") {
          throw new EnergyPurchaseError(
            "PAYMENT_RISK_STORE_LOCK_UNAVAILABLE",
            "Unable to lock the payment-risk store. New payments are blocked.",
            { cause },
          );
        }
        if (Date.now() >= deadline) {
          throw new EnergyPurchaseError(
            "PAYMENT_RISK_STORE_BUSY",
            "The payment-risk store is busy or its previous writer exited unexpectedly. New payments are blocked.",
            { retryable: true },
          );
        }
        Atomics.wait(mutationLockWaitBuffer, 0, 0, RISK_MUTATION_LOCK_RETRY_MS);
        continue;
      }

      try {
        fs.writeFileSync(descriptor, JSON.stringify({ token, pid: process.pid, createdAt: Date.now() }));
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor);
      } catch (cause) {
        try { fs.closeSync(descriptor); } catch { /* Preserve the original persistence error. */ }
        try { fs.unlinkSync(lockPath); } catch { /* Best effort after a failed exclusive create. */ }
        throw new EnergyPurchaseError(
          "PAYMENT_RISK_STORE_LOCK_UNAVAILABLE",
          "Unable to persist the payment-risk store lock. New payments are blocked.",
          { cause },
        );
      }
      return token;
    }
  }

  private releaseMutationLock(token: string): void {
    const lockPath = this.mutationLockPath();
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    } catch (cause) {
      throw new EnergyPurchaseError(
        "PAYMENT_RISK_STORE_LOCK_LOST",
        "The payment-risk store lock cannot be verified. It was preserved for manual recovery.",
        { cause },
      );
    }
    if (!isRiskMutationLock(parsed) || parsed.token !== token) {
      throw new EnergyPurchaseError(
        "PAYMENT_RISK_STORE_LOCK_LOST",
        "The payment-risk store lock owner changed unexpectedly. The current lock was preserved.",
      );
    }
    try {
      fs.unlinkSync(lockPath);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new EnergyPurchaseError(
        "PAYMENT_RISK_STORE_LOCK_UNAVAILABLE",
        "Unable to release the payment-risk store lock. New payments remain blocked.",
        { cause },
      );
    }
  }

  private mutateAll(mutator: (risks: EnergyPaymentRisk[]) => EnergyPaymentRisk[]): void {
    const token = this.acquireMutationLock();
    try {
      this.mutateAllLocked(mutator);
    } finally {
      this.releaseMutationLock(token);
    }
  }

  /** Apply a risk-file mutation while the caller owns the shared mutation lock. */
  private mutateAllLocked(mutator: (risks: EnergyPaymentRisk[]) => EnergyPaymentRisk[]): void {
    this.writeAll(mutator(this.readAll()));
  }

  list(payerAddress: string): EnergyPaymentRisk[] {
    return this.readAll().filter(risk => risk.payerAddress === payerAddress);
  }

  save(risk: EnergyPaymentRisk): void {
    this.mutateAll((risks) => {
      const remaining = risks.filter(item =>
        !(item.payerAddress === risk.payerAddress && item.signedTxId === risk.signedTxId),
      );
      remaining.push(risk);
      return remaining;
    });
  }

  remove(payerAddress: string, signedTxId?: string): void {
    this.mutateAll(risks => risks.filter(risk =>
      risk.payerAddress !== payerAddress || (signedTxId !== undefined && risk.signedTxId !== signedTxId),
    ));
  }

  private intentPath(payerAddress: string): string {
    return `${this.filePath}.${payerAddress}.intent`;
  }

  acquireIntent(payerAddress: string, expiresAt: number): string {
    validateAddress(payerAddress, "payerAddress");
    // Stale intent recovery is a delete-then-create sequence. Serialize it
    // with the same global store mutation lock used by risk RMW operations so
    // another process cannot unlink a freshly-created intent from an old read.
    const mutationToken = this.acquireMutationLock();
    try {
      return this.acquireIntentLocked(payerAddress, expiresAt);
    } finally {
      this.releaseMutationLock(mutationToken);
    }
  }

  private acquireIntentLocked(payerAddress: string, expiresAt: number): string {
    const intentPath = this.intentPath(payerAddress);
    fs.mkdirSync(path.dirname(intentPath), { recursive: true, mode: 0o700 });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const token = randomUUID();
      let descriptor: number;
      try {
        descriptor = fs.openSync(intentPath, "wx", 0o600);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "EEXIST") {
          throw new EnergyPurchaseError(
            "PAYMENT_INTENT_LOCK_UNAVAILABLE",
            "Unable to create the payment-intent lock. New payments are blocked.",
            { cause },
          );
        }
        const existing = this.readIntent(intentPath);
        if (existing.expiresAt > Date.now()) {
          throw new EnergyPurchaseError(
            "PAYMENT_IN_PROGRESS",
            "Another energy payment is already in progress for this payer.",
            { retryable: true },
          );
        }
        try {
          fs.unlinkSync(intentPath);
        } catch (unlinkCause) {
          if ((unlinkCause as NodeJS.ErrnoException).code !== "ENOENT") {
            throw new EnergyPurchaseError(
              "PAYMENT_INTENT_LOCK_UNAVAILABLE",
              "Unable to clear an expired payment-intent lock. New payments are blocked.",
              { cause: unlinkCause },
            );
          }
        }
        continue;
      }

      try {
        fs.writeFileSync(descriptor, JSON.stringify({ payerAddress, token, createdAt: Date.now(), expiresAt }));
        fs.fsyncSync(descriptor);
      } catch (cause) {
        try { fs.closeSync(descriptor); } catch { /* Preserve the original persistence error. */ }
        try { fs.unlinkSync(intentPath); } catch { /* Best effort after a failed exclusive create. */ }
        throw new EnergyPurchaseError(
          "PAYMENT_INTENT_LOCK_UNAVAILABLE",
          "Unable to persist the payment-intent lock. New payments are blocked.",
          { cause },
        );
      }
      try {
        fs.closeSync(descriptor);
      } catch (cause) {
        try { fs.unlinkSync(intentPath); } catch { /* Best effort after a failed exclusive create. */ }
        throw new EnergyPurchaseError(
          "PAYMENT_INTENT_LOCK_UNAVAILABLE",
          "Unable to finalize the payment-intent lock. New payments are blocked.",
          { cause },
        );
      }
      return token;
    }

    throw new EnergyPurchaseError(
      "PAYMENT_INTENT_LOCK_UNAVAILABLE",
      "Unable to acquire the payment-intent lock after clearing an expired lock.",
    );
  }

  releaseIntent(payerAddress: string, token: string): void {
    const mutationToken = this.acquireMutationLock();
    try {
      const intentPath = this.intentPath(payerAddress);
      let existing: EnergyPaymentIntent;
      try {
        existing = this.readIntent(intentPath);
      } catch (cause) {
        if ((cause as EnergyPurchaseError).code === "PAYMENT_INTENT_LOCK_MISSING") return;
        throw cause;
      }
      if (existing.token !== token) {
        throw new EnergyPurchaseError(
          "PAYMENT_INTENT_LOCK_LOST",
          "The payment-intent lock owner changed unexpectedly. The current lock was preserved.",
        );
      }
      try {
        fs.unlinkSync(intentPath);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
        throw new EnergyPurchaseError(
          "PAYMENT_INTENT_LOCK_UNAVAILABLE",
          "Unable to release the payment-intent lock. New payments remain blocked.",
          { cause },
        );
      }
    } finally {
      this.releaseMutationLock(mutationToken);
    }
  }

  finalizeIntent(payerAddress: string, token: string, risk: EnergyPaymentRisk): void {
    const mutationToken = this.acquireMutationLock();
    try {
      const intentPath = this.intentPath(payerAddress);
      const existing = this.readIntent(intentPath);
      if (existing.token !== token) {
        throw new EnergyPurchaseError(
          "PAYMENT_INTENT_LOCK_LOST",
          "The payment-intent lock owner changed unexpectedly. No payment risk was published.",
        );
      }
      this.mutateAllLocked((risks) => {
        const remaining = risks.filter(item =>
          !(item.payerAddress === risk.payerAddress && item.signedTxId === risk.signedTxId),
        );
        remaining.push(risk);
        return remaining;
      });
      try {
        fs.unlinkSync(intentPath);
      } catch (cause) {
        throw new EnergyPurchaseError(
          "PAYMENT_INTENT_LOCK_UNAVAILABLE",
          "Payment risk was persisted but the payment-intent lock could not be released.",
          { cause },
        );
      }
    } finally {
      this.releaseMutationLock(mutationToken);
    }
  }

  private readIntent(intentPath: string): EnergyPaymentIntent {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(intentPath, "utf8"));
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
        throw new EnergyPurchaseError("PAYMENT_INTENT_LOCK_MISSING", "The payment-intent lock does not exist.");
      }
      throw new EnergyPurchaseError(
        "PAYMENT_INTENT_LOCK_INVALID",
        "The payment-intent lock cannot be read safely. New payments are blocked.",
        { cause },
      );
    }
    if (!isEnergyPaymentIntent(parsed)) {
      throw new EnergyPurchaseError(
        "PAYMENT_INTENT_LOCK_INVALID",
        "The payment-intent lock has an invalid schema. New payments are blocked.",
      );
    }
    return parsed;
  }
}

interface EnergyPaymentIntent {
  payerAddress: string;
  token: string;
  createdAt: number;
  expiresAt: number;
}

interface RiskMutationLock {
  token: string;
  pid: number;
  createdAt: number;
}

function isEnergyPaymentRisk(value: unknown): value is EnergyPaymentRisk {
  const risk = value as Partial<EnergyPaymentRisk> | null;
  return Boolean(
    risk && typeof risk.payerAddress === "string" && isValidTronAddress(risk.payerAddress) &&
    typeof risk.signedTxId === "string" && risk.signedTxId.length > 0 &&
    Number.isSafeInteger(risk.createdAt) && Number(risk.createdAt) >= 0 &&
    Number.isSafeInteger(risk.expiresAt) && Number(risk.expiresAt) > 0 &&
    typeof risk.paymentConfirmed === "boolean" &&
    (risk.chainStatus === undefined ||
      ["unknown", "observed", "included", "solidified"].includes(risk.chainStatus)) &&
    (risk.chainExecution === undefined ||
      ["unknown", "success", "failed"].includes(risk.chainExecution)) &&
    (risk.networkFingerprint === undefined ||
      (typeof risk.networkFingerprint === "string" && risk.networkFingerprint.length > 0)) &&
    (risk.signedRequest === undefined ||
      risk.signedRequest?.signed_transaction?.txID === risk.signedTxId),
  );
}

function isEnergyPaymentIntent(value: unknown): value is EnergyPaymentIntent {
  const intent = value as Partial<EnergyPaymentIntent> | null;
  return Boolean(
    intent && typeof intent.payerAddress === "string" && isValidTronAddress(intent.payerAddress) &&
    typeof intent.token === "string" && intent.token.length > 0 &&
    Number.isSafeInteger(intent.createdAt) && Number(intent.createdAt) >= 0 &&
    Number.isSafeInteger(intent.expiresAt) && Number(intent.expiresAt) > 0,
  );
}

function isRiskMutationLock(value: unknown): value is RiskMutationLock {
  const lock = value as Partial<RiskMutationLock> | null;
  return Boolean(
    lock && typeof lock.token === "string" && lock.token.length > 0 &&
    Number.isSafeInteger(lock.pid) && Number(lock.pid) > 0 &&
    Number.isSafeInteger(lock.createdAt) && Number(lock.createdAt) >= 0,
  );
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface EnergyPurchaseApiOptions {
  baseUrl?: string;
  fetch?: FetchLike;
  riskStore?: EnergyPaymentRiskStore;
  requestTimeoutMs?: number;
  paymentRetryIntervalMs?: number;
  paymentRetryTimeoutMs?: number;
  orderPollIntervalMs?: number;
  orderPollTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  networkFingerprint?: string;
}

function envFlag(name: string): boolean {
  const value = process.env[name]?.toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

function resolveBaseUrl(explicit?: string): string {
  const value = explicit || process.env.JUSTLEND_ENERGY_API_URL || DEFAULT_ENERGY_PURCHASE_API_URL;
  let url: URL;
  try {
    url = new URL(value);
  } catch (cause) {
    throw new EnergyPurchaseError("CONFIG_INVALID", "JUSTLEND_ENERGY_API_URL must be a valid URL.", { cause });
  }
  const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  const insecureLocalAllowed = local && url.protocol === "http:" && envFlag("JUSTLEND_ALLOW_INSECURE_HOSTS");
  if (url.protocol !== "https:" && !insecureLocalAllowed) {
    throw new EnergyPurchaseError("CONFIG_INVALID", "Energy purchase API must use HTTPS.");
  }
  if (!TRUSTED_ENERGY_PURCHASE_HOSTS.has(url.hostname) && !envFlag("JUSTLEND_ALLOW_UNTRUSTED_HOSTS")) {
    throw new EnergyPurchaseError(
      "UNTRUSTED_HOST",
      `Energy purchase API host ${url.hostname} is not in the official allowlist; ` +
      "set JUSTLEND_ALLOW_UNTRUSTED_HOSTS=1 only after verifying it.",
    );
  }
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/$/, "");
}

function validateAddress(address: string, label: string): void {
  if (!isValidTronAddress(address)) {
    throw new EnergyPurchaseError("INVALID_ADDRESS", `${label} must be a Base58Check TRON address.`);
  }
}

function isValidTronAddress(address: string): boolean {
  return /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address) && TronWeb.isAddress(address);
}

function positiveInteger(value: unknown, label: string): number {
  const numberValue = Number(value);
  if (!Number.isSafeInteger(numberValue) || numberValue <= 0) {
    throw new EnergyPurchaseError("INVALID_AMOUNT", `${label} must be a positive safe integer.`);
  }
  return numberValue;
}

function validateQuoteInput(
  receivers: string[],
  energyPerReceiver: number,
  duration: string,
  config: EnergyPurchaseConfig,
): void {
  if (!Array.isArray(receivers) || receivers.length === 0) {
    throw new EnergyPurchaseError("EMPTY_RECEIVERS", "At least one receiver is required.");
  }
  receivers.forEach((receiver, index) => validateAddress(receiver, `receivers[${index}]`));
  const energy = positiveInteger(energyPerReceiver, "energyPerReceiver");
  const min = positiveInteger(config?.min_energy, "config.min_energy");
  const max = positiveInteger(config?.max_energy, "config.max_energy");
  const maxReceivers = positiveInteger(config?.max_batch_receivers, "config.max_batch_receivers");
  if (max < min) throw new EnergyPurchaseError("INVALID_RESPONSE", "API returned max_energy below min_energy.");
  if (energy < min || energy > max) {
    throw new EnergyPurchaseError("INVALID_AMOUNT", `Energy per receiver must be between ${min} and ${max}.`);
  }
  if (receivers.length > maxReceivers) {
    throw new EnergyPurchaseError("ADDR_OVERFLOW", `A maximum of ${maxReceivers} receivers is allowed.`);
  }
  if (!Array.isArray(config.supported_durations) || !config.supported_durations.includes(duration)) {
    throw new EnergyPurchaseError("INVALID_DURATION", "duration must come from the live supported_durations list.");
  }
}

function normalizeConfig(value: Record<string, any>): EnergyPurchaseConfig {
  return {
    ...value,
    max_batch_receivers: value.max_batch_receivers ?? value.max_receivers,
    energy_presets: value.energy_presets ?? value.presets,
    supported_durations: value.supported_durations ?? value.durations,
  } as EnergyPurchaseConfig;
}

function normalizeQuote(value: Record<string, any>): EnergyPurchaseQuote {
  return {
    ...value,
    total_sun: value.total_sun ?? value.amount_sun,
    total_trx: value.total_trx ?? value.amount_trx,
    payment_address: value.payment_address ?? value.pay_address,
  } as EnergyPurchaseQuote;
}

function requestForProductionApi(request: SignedEnergyPurchaseRequest): SignedEnergyPurchaseRequest {
  const energyPerReceiver = request.energy_per_receiver ?? request.energy;
  return {
    ...request,
    energy_per_receiver: energyPerReceiver as number,
    energy: undefined,
  };
}

function normalizeHex(value: unknown): string {
  return typeof value === "string" ? value.replace(/^0x/i, "").toLowerCase() : "";
}

interface EnergyTransactionLookup {
  status: EnergyPaymentChainStatus | "not_found" | "unavailable";
  execution: EnergyPaymentChainExecution;
}

function transactionExecution(value: any): EnergyPaymentChainExecution {
  const result = value?.receipt?.result ?? value?.ret?.[0]?.contractRet;
  if (typeof result !== "string" || !result.trim()) return "unknown";
  return result.toUpperCase() === "SUCCESS" ? "success" : "failed";
}

function hasTransactionInfo(value: any, txId: string): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const responseId = normalizeHex(value.id);
  return responseId ? responseId === normalizeHex(txId) : Boolean(value.receipt || value.blockNumber !== undefined);
}

function isTransactionNotFound(error: unknown): boolean {
  return String((error as Error)?.message || error).toLowerCase().includes("transaction not found");
}

function providerFingerprint(tronWeb: TronWeb): string {
  const values = [
    (tronWeb.fullNode as any)?.host,
    (tronWeb.solidityNode as any)?.host,
    (tronWeb.eventServer as any)?.host,
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  return [...new Set(values.map(value => {
    try {
      const parsed = new URL(value);
      return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/$/, "")}`;
    } catch {
      return value.trim();
    }
  }))].join("|");
}

function consumerBuyMemo(receivers: string[], energy: number, duration: string): string {
  const payload = ["a6-buy-v1", String(energy), duration, ...receivers].join("\0");
  return `a6-buy-v1:${createHash("sha256").update(payload).digest("hex")}`;
}

function attachMemo(tronWeb: TronWeb, transaction: Record<string, any>, memo: string): Record<string, any> {
  const utils = (tronWeb as any)?.utils?.transaction;
  if (!transaction?.raw_data || typeof utils?.txJsonToPb !== "function" ||
      typeof utils?.txPbToRawDataHex !== "function" || typeof utils?.txPbToTxID !== "function") {
    throw new EnergyPurchaseError(
      "CONFIG_MISSING",
      "TronWeb protobuf utilities are required to bind the payment memo safely.",
    );
  }
  const payable: Record<string, any> = {
    ...transaction,
    raw_data: { ...transaction.raw_data, data: Buffer.from(memo, "utf8").toString("hex") },
  };
  const protobuf = utils.txJsonToPb(payable);
  payable.raw_data_hex = normalizeHex(utils.txPbToRawDataHex(protobuf));
  payable.txID = normalizeHex(utils.txPbToTxID(protobuf));
  if (!payable.txID || !payable.raw_data_hex) {
    throw new EnergyPurchaseError("INVALID_UNSIGNED_TX", "Unable to derive the memo-bound transaction identity.");
  }
  return payable;
}

function normalizeSignedTransaction(value: unknown, expected: Record<string, any>): Record<string, any> {
  const signed = (value as Record<string, any>)?.signedTransaction || value as Record<string, any>;
  if (
    !signed || typeof signed.txID !== "string" || typeof signed.raw_data_hex !== "string" || !signed.raw_data ||
    !Array.isArray(signed.signature) || signed.signature.length !== 1
  ) {
    throw new EnergyPurchaseError(
      "INVALID_SIGNED_TX",
      "Signer must return one signed TRX transfer with txID, raw_data, and exactly one signature.",
    );
  }
  if (normalizeHex(signed.txID) !== normalizeHex(expected.txID) ||
      normalizeHex(signed.raw_data_hex) !== normalizeHex(expected.raw_data_hex)) {
    throw new EnergyPurchaseError(
      "SIGNED_TX_MISMATCH",
      "Signer returned a transaction that does not match the confirmed payer, recipient, amount, and request memo.",
    );
  }
  return signed;
}

function signedTransactionForWire(signed: Record<string, any>): SignedEnergyPurchaseRequest["signed_transaction"] {
  return {
    txID: normalizeHex(signed.txID),
    raw_data: signed.raw_data,
    raw_data_hex: normalizeHex(signed.raw_data_hex),
    signature: [...signed.signature],
    visible: signed.visible === true,
  };
}

function shouldClearSignedRisk(error: EnergyPurchaseError): boolean {
  return error.isBusinessError && Number(error.status) >= 400 && Number(error.status) < 500 &&
    DETERMINISTIC_PRE_BROADCAST_CODES.has(error.code);
}

export class EnergyPurchaseApi {
  readonly baseUrl: string;
  private readonly fetchImpl?: FetchLike;
  private readonly riskStore: EnergyPaymentRiskStore;
  private readonly requestTimeoutMs: number;
  private readonly paymentRetryIntervalMs: number;
  private readonly paymentRetryTimeoutMs: number;
  private readonly orderPollIntervalMs: number;
  private readonly orderPollTimeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly explicitNetworkFingerprint: string;
  private readonly isProductionApi: boolean;
  private readonly activeIntentTokens = new Map<string, string>();

  constructor(options: EnergyPurchaseApiOptions = {}) {
    this.baseUrl = resolveBaseUrl(options.baseUrl);
    this.fetchImpl = options.fetch;
    this.riskStore = options.riskStore || new FileEnergyPaymentRiskStore();
    this.requestTimeoutMs = options.requestTimeoutMs ?? 8000;
    this.paymentRetryIntervalMs = options.paymentRetryIntervalMs ?? 5000;
    this.paymentRetryTimeoutMs = options.paymentRetryTimeoutMs ?? PAYMENT_RETRY_TIMEOUT_MS;
    this.orderPollIntervalMs = options.orderPollIntervalMs ?? 3000;
    this.orderPollTimeoutMs = options.orderPollTimeoutMs ?? 150000;
    this.sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.now = options.now || Date.now;
    this.explicitNetworkFingerprint = options.networkFingerprint?.trim() || "";
    this.isProductionApi = new URL(this.baseUrl).hostname === new URL(DEFAULT_ENERGY_PURCHASE_API_URL).hostname;
  }

  private async request<T>(method: string, apiPath: string, options: {
    body?: unknown;
    token?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
  } = {}): Promise<T> {
    let response: Response;
    try {
      const init: RequestInit = {
        method,
        headers: {
          ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(options.token ? { "X-Consumer-Order-Token": options.token } : {}),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        // Never forward signed payments or order tokens to an unchecked
        // redirect target.
        redirect: "error",
        signal: options.signal,
      };
      response = this.fetchImpl
        ? await this.fetchImpl(`${this.baseUrl}${apiPath}`, init)
        : await fetchWithTimeout(`${this.baseUrl}${apiPath}`, init, options.timeoutMs ?? this.requestTimeoutMs);
    } catch (cause) {
      throw new EnergyPurchaseError("NETWORK_ERROR", "Energy purchase API request returned no response.", {
        retryable: true,
        cause,
      });
    }
    let envelope: { code?: string; msg?: string; data?: T };
    try {
      envelope = await response.json() as typeof envelope;
    } catch (cause) {
      throw new EnergyPurchaseError("INVALID_RESPONSE", "Energy purchase API returned non-JSON data.", {
        status: response.status,
        retryable: response.status >= 500,
        cause,
      });
    }
    if (!response.ok) {
      const code = typeof envelope.code === "string" && envelope.code.length > 0
        ? String(envelope.code).toUpperCase()
        : "HTTP_ERROR";
      throw new EnergyPurchaseError(code, envelope.msg || `Energy purchase API returned HTTP ${response.status}.`, {
        status: response.status,
        isBusinessError: response.status >= 400 && response.status < 500 && code !== "HTTP_ERROR",
        retryable: response.status >= 500,
      });
    }
    if (envelope.code !== "0") {
      const business = typeof envelope.code === "string" && envelope.code.length > 0;
      throw new EnergyPurchaseError(business ? String(envelope.code).toUpperCase() : "INVALID_RESPONSE", envelope.msg, {
        status: response.status,
        isBusinessError: business,
      });
    }
    return envelope.data as T;
  }

  async getConfig(): Promise<EnergyPurchaseConfig> {
    return normalizeConfig(await this.request<Record<string, any>>("GET", ENERGY_PURCHASE_PATHS.config));
  }

  getCurrentPrice(): Promise<Record<string, unknown>> {
    return this.request("GET", ENERGY_PURCHASE_PATHS.currentPrice);
  }

  getPoolHealth(): Promise<Record<string, unknown>> {
    return this.request("GET", ENERGY_PURCHASE_PATHS.poolHealth);
  }

  async quote(
    receivers: string[],
    energyPerReceiver: number,
    duration: string,
    config?: EnergyPurchaseConfig,
  ): Promise<EnergyPurchaseQuote> {
    const liveConfig = config || await this.getConfig();
    validateQuoteInput(receivers, energyPerReceiver, duration, liveConfig);
    const rawQuote = await this.request<Record<string, any>>("POST", ENERGY_PURCHASE_PATHS.quote, {
      body: { receivers, energy_per_receiver: energyPerReceiver },
    });
    const quote = normalizeQuote(rawQuote);
    if (!quote.payment_address && liveConfig.payment_address) quote.payment_address = liveConfig.payment_address;
    if (
      !Number.isSafeInteger(Number(quote?.total_sun)) || Number(quote.total_sun) <= 0 ||
      typeof quote.payment_address !== "string" || !isValidTronAddress(quote.payment_address)
    ) {
      throw new EnergyPurchaseError("INVALID_RESPONSE", "Energy purchase quote is missing required fields.");
    }
    if (quote.can_fulfill === false) {
      throw new EnergyPurchaseError("POOL_INSUFFICIENT", "The live resource pool cannot fulfill this purchase.", {
        details: { maxSingleOrderEnergy: quote.max_single_order_energy },
      });
    }
    return quote;
  }

  getOrder(orderId: string | number, token?: string): Promise<Record<string, any>> {
    if (String(orderId).length === 0) throw new EnergyPurchaseError("INVALID_ORDER_ID", "orderId is required.");
    return this.request("GET", ENERGY_PURCHASE_PATHS.order(orderId), { token });
  }

  getHistory(address: string, options: { page?: number; size?: number } = {}): Promise<Record<string, any>> {
    validateAddress(address, "history address");
    const query = new URLSearchParams({ address });
    if (options.size !== undefined) {
      query.set("page", String(positiveInteger(options.page ?? 1, "page")));
      query.set("size", String(positiveInteger(options.size, "size")));
    }
    return this.request("GET", `${ENERGY_PURCHASE_PATHS.history}?${query}`);
  }

  getPaymentRisks(payerAddress: string): EnergyPaymentRisk[] {
    validateAddress(payerAddress, "payerAddress");
    return this.riskStore.list(payerAddress);
  }

  private async lookupTransaction(
    tronWeb: TronWeb,
    txId: string,
  ): Promise<EnergyTransactionLookup> {
    const trx = (tronWeb as any)?.trx;
    let attempted = 0;
    let unavailable = false;
    let included: EnergyTransactionLookup | null = null;

    // FullNode exposes the execution receipt first, before the block is solidified.
    if (typeof trx?.getUnconfirmedTransactionInfo === "function") {
      attempted += 1;
      try {
        const info = await trx.getUnconfirmedTransactionInfo(txId);
        if (hasTransactionInfo(info, txId)) {
          included = { status: "included", execution: transactionExecution(info) };
        }
      } catch (error) {
        if (!isTransactionNotFound(error)) unavailable = true;
      }
    }

    // SolidityNode is the finality authority. A result here supersedes FullNode.
    if (typeof trx?.getTransactionInfo === "function") {
      attempted += 1;
      try {
        const info = await trx.getTransactionInfo(txId);
        if (hasTransactionInfo(info, txId)) {
          return { status: "solidified", execution: transactionExecution(info) };
        }
      } catch (error) {
        if (!isTransactionNotFound(error)) unavailable = true;
      }
    }

    if (included) return included;

    // Backward-compatible fallback for injected TronWeb clients without receipt helpers.
    if (typeof trx?.getTransaction === "function") {
      attempted += 1;
      try {
        const transaction = await trx.getTransaction(txId);
        if (normalizeHex(transaction?.txID) === normalizeHex(txId)) {
          const execution = transactionExecution(transaction);
          return { status: execution === "unknown" ? "observed" : "included", execution };
        }
      } catch (error) {
        if (!isTransactionNotFound(error)) unavailable = true;
      }
    }

    return { status: attempted === 0 || unavailable ? "unavailable" : "not_found", execution: "unknown" };
  }

  private recordChainLookup(risk: EnergyPaymentRisk, lookup: EnergyTransactionLookup): void {
    if (!["observed", "included", "solidified"].includes(lookup.status)) return;
    const rank: Record<EnergyPaymentChainStatus, number> = { unknown: 0, observed: 1, included: 2, solidified: 3 };
    if (rank[lookup.status as EnergyPaymentChainStatus] < rank[risk.chainStatus || "unknown"]) return;
    risk.chainStatus = lookup.status as EnergyPaymentChainStatus;
    if (lookup.execution !== "unknown" || !risk.chainExecution) risk.chainExecution = lookup.execution;
    if (lookup.status === "solidified" && lookup.execution === "success") {
      risk.paymentConfirmed = true;
    }
    this.riskStore.save(risk);
  }

  private historyContainsRisk(history: Record<string, any>, risk: EnergyPaymentRisk): boolean {
    const rows = Array.isArray(history?.rows) ? history.rows : [];
    const recovered = risk.recoveredOrder && typeof risk.recoveredOrder === "object"
      ? risk.recoveredOrder as Record<string, any>
      : undefined;
    const batch = recovered?.batch && typeof recovered.batch === "object"
      ? recovered.batch as Record<string, any>
      : undefined;
    const recoveredOrderId = batch?.id ?? recovered?.id;
    const normalize = (value: unknown) => value === undefined || value === null
      ? ""
      : String(value).trim().toLowerCase();
    return rows.some((row: unknown) => {
      if (!row || typeof row !== "object") return false;
      const item = row as Record<string, unknown>;
      const historyTxId = item.payment_tx_id ?? item.paymentTxId ?? item.tx_id ?? item.txId;
      const historyOrderId = item.order_id ?? item.orderId ?? item.id;
      return Boolean(
        (normalize(historyTxId) && normalize(historyTxId) === normalize(risk.signedTxId)) ||
        (normalize(recoveredOrderId) && normalize(historyOrderId) === normalize(recoveredOrderId)),
      );
    });
  }

  private async resolveRiskFromHistory(risk: EnergyPaymentRisk): Promise<boolean> {
    try {
      const history = await this.getHistory(risk.payerAddress);
      if (!this.historyContainsRisk(history, risk)) return false;
      this.riskStore.remove(risk.payerAddress, risk.signedTxId);
      return true;
    } catch {
      // History is eventually consistent and may be temporarily unavailable.
      // Retain the replayable request rather than risk a duplicate payment.
      return false;
    }
  }

  async reconcilePaymentRisks(payerAddress: string, network = "mainnet"): Promise<EnergyPaymentRisk[]> {
    const tronWeb = getTronWeb(network);
    const provider = this.explicitNetworkFingerprint || providerFingerprint(tronWeb);
    const networkFingerprint = provider ? `api=${this.baseUrl};provider=${provider}` : "";
    const risks = this.getPaymentRisks(payerAddress);
    for (const risk of risks) {
      if (!risk.networkFingerprint || !risk.signedRequest ||
          !networkFingerprint || risk.networkFingerprint !== networkFingerprint) {
        continue;
      }
      try {
        risk.recoveredOrder = await this.request<Record<string, unknown>>("POST", ENERGY_PURCHASE_PATHS.buy, {
          body: requestForProductionApi(risk.signedRequest),
        });
        risk.paymentConfirmed = true;
        this.riskStore.save(risk);
        await this.resolveRiskFromHistory(risk);
      } catch (error) {
        const typed = error as EnergyPurchaseError;
        if (typed.code === "TX_ALREADY_CLAIMED") {
          risk.paymentConfirmed = true;
          this.riskStore.save(risk);
          await this.resolveRiskFromHistory(risk);
        } else if (shouldClearSignedRisk(typed)) {
          this.riskStore.remove(payerAddress, risk.signedTxId);
        } else {
          const lookup = await this.lookupTransaction(tronWeb, risk.signedTxId);
          if (lookup.status === "solidified" && lookup.execution === "failed" && !risk.paymentConfirmed) {
            this.riskStore.remove(payerAddress, risk.signedTxId);
          } else {
            this.recordChainLookup(risk, lookup);
          }
        }
      }
    }
    return this.riskStore.list(payerAddress);
  }

  private async buildAndSignPayment(
    tronWeb: TronWeb,
    payerAddress: string,
    payAddress: string,
    amountSun: number,
    receivers: string[],
    energyPerReceiver: number,
    duration: string,
    network: string,
  ): Promise<Record<string, any>> {
    validateAddress(payerAddress, "payerAddress");
    validateAddress(payAddress, "payAddress");
    const safeAmount = positiveInteger(amountSun, "amountSun");
    let unsigned = await tronWeb.transactionBuilder.sendTrx(payAddress, safeAmount, payerAddress) as Record<string, any>;
    if (unsigned?.raw_data?.expiration && tronWeb.transactionBuilder.extendExpiration) {
      const seconds = Math.ceil((this.now() + ORDER_TTL_MS - Number(unsigned.raw_data.expiration)) / 1000);
      if (seconds > 0) {
        try {
          const candidate = { ...unsigned, raw_data: { ...unsigned.raw_data } };
          unsigned = await tronWeb.transactionBuilder.extendExpiration(candidate as any, seconds, { txLocal: true }) as Record<string, any>;
        } catch {
          // The shorter node-provided expiration remains a safe fallback.
        }
      }
    }
    unsigned = attachMemo(tronWeb, unsigned, consumerBuyMemo(receivers, energyPerReceiver, duration));
    const description = `Pay ${safeAmount / 1e6} TRX to ${payAddress} for JustLend energy on ${network}. Sign only; the configured backend broadcasts.`;
    return normalizeSignedTransaction(await signTransactionWithWallet(unsigned, description, network), unsigned);
  }

  private async pollOrder(orderId: string | number, token?: string): Promise<Record<string, any> | null> {
    const deadline = this.now() + this.orderPollTimeoutMs;
    let detail: Record<string, any> | null = null;
    while (this.now() < deadline) {
      try {
        detail = await this.getOrder(orderId, token);
        if (ENERGY_PURCHASE_TERMINAL_STATES.includes(detail.state)) return detail;
      } catch {
        // Payment is already accepted; tolerate transient order-query failures until the deadline.
      }
      await this.sleep(this.orderPollIntervalMs);
    }
    return detail;
  }

  async purchase(input: {
    receivers: string[];
    energyPerReceiver: number;
    duration: string;
    expectedAmountSun: number;
    expectedPayAddress: string;
    network?: string;
  }): Promise<Record<string, unknown>> {
    const payerAddress = await getWalletAddress();
    validateAddress(payerAddress, "payerAddress");
    if (activePayers.has(payerAddress)) {
      throw new EnergyPurchaseError(
        "PAYMENT_IN_PROGRESS",
        "Another energy payment is already in progress for this payer.",
        { retryable: true },
      );
    }

    activePayers.add(payerAddress);
    let intentToken: string | undefined;
    try {
      intentToken = this.riskStore.acquireIntent(payerAddress, Date.now() + PAYMENT_INTENT_TTL_MS);
      this.activeIntentTokens.set(payerAddress, intentToken);
      return await this.purchaseWithIntent(input, payerAddress);
    } finally {
      try {
        if (intentToken !== undefined && this.activeIntentTokens.get(payerAddress) === intentToken) {
          this.riskStore.releaseIntent(payerAddress, intentToken);
        }
      } finally {
        if (this.activeIntentTokens.get(payerAddress) === intentToken) {
          this.activeIntentTokens.delete(payerAddress);
        }
        activePayers.delete(payerAddress);
      }
    }
  }

  private async purchaseWithIntent(input: {
    receivers: string[];
    energyPerReceiver: number;
    duration: string;
    expectedAmountSun: number;
    expectedPayAddress: string;
    network?: string;
  }, payerAddress: string): Promise<Record<string, unknown>> {
    const network = input.network || "mainnet";
    if (this.isProductionApi && network !== "mainnet") {
      throw new EnergyPurchaseError(
        "CONFIG_MISSING",
        "Set JUSTLEND_ENERGY_API_URL to the matching non-mainnet service before purchasing energy.",
      );
    }
    const tronWeb = await getSigningClient(network);
    const existedBeforeReconciliation = this.getPaymentRisks(payerAddress);
    const existing = await this.reconcilePaymentRisks(payerAddress, network);
    if (existedBeforeReconciliation.length || existing.length) {
      const error = new EnergyPurchaseError(
        "PAYMENT_RISK_UNRESOLVED",
        existing[0]?.chainStatus === "included" || existing[0]?.chainStatus === "observed"
          ? "A previous payment is visible on FullNode but is not solidified. Do not sign another payment."
          : existing[0]?.paymentConfirmed
            ? "A previous payment was recovered or solidified. Record its order result and resolve the marker before signing another payment."
            : "A previous payment has an unknown result. Reconcile the exact signed request before signing another payment.",
      );
      error.paymentRisk = existing[0] || existedBeforeReconciliation[0];
      throw error;
    }

    const config = await this.getConfig();
    const durations = Array.isArray(config.supported_durations) ? config.supported_durations.filter(item => typeof item === "string" && item.trim()) : [];
    if (!durations.includes(input.duration)) {
      throw new EnergyPurchaseError("INVALID_DURATION", "duration must come from the live /v1/config durations list.");
    }
    const quote = await this.quote(input.receivers, input.energyPerReceiver, input.duration, config);
    const confirmedAmount = positiveInteger(input.expectedAmountSun, "expectedAmountSun");
    if (quote.total_sun !== confirmedAmount) {
      throw new EnergyPurchaseError("AMOUNT_CHANGED", "The authoritative quote differs from the user-confirmed amount.", {
        details: { expectedAmountSun: confirmedAmount, amountSun: quote.total_sun },
      });
    }
    validateAddress(input.expectedPayAddress, "expectedPayAddress");
    if (quote.payment_address !== input.expectedPayAddress) {
      throw new EnergyPurchaseError(
        "PAYMENT_ADDRESS_CHANGED",
        "The configured payment address differs from the exact address confirmed by the user.",
      );
    }
    const provider = this.explicitNetworkFingerprint || providerFingerprint(tronWeb);
    if (!provider) {
      throw new EnergyPurchaseError("NETWORK_FINGERPRINT_REQUIRED", "A fixed network/provider fingerprint is required.");
    }
    const networkFingerprint = `api=${this.baseUrl};provider=${provider}`;
    const balanceSun = BigInt(await tronWeb.trx.getBalance(payerAddress));
    if (balanceSun < BigInt(quote.total_sun)) {
      throw new EnergyPurchaseError(
        "INSUFFICIENT_BALANCE",
        `Payment requires ${quote.total_sun / 1e6} TRX before bandwidth cost.`,
      );
    }

    let signed: Record<string, any>;
    try {
      signed = await this.buildAndSignPayment(
        tronWeb,
        payerAddress,
        quote.payment_address,
        quote.total_sun,
        input.receivers,
        input.energyPerReceiver,
        input.duration,
        network,
      );
    } catch (cause) {
      // Signing may have completed before the bridge/provider response was
      // lost. Preserve the payer intent until its conservative TTL.
      this.activeIntentTokens.delete(payerAddress);
      throw new EnergyPurchaseError(
        "SIGNING_RESULT_UNKNOWN",
        "The signer result is unknown. The payer remains blocked until the intent is reviewed.",
        { cause },
      );
    }
    const signedDeadline = Number.isFinite(Number(signed.raw_data?.expiration))
      ? Number(signed.raw_data.expiration)
      : this.now() + ORDER_TTL_MS;
    const retryDeadline = Math.min(signedDeadline, this.now() + this.paymentRetryTimeoutMs);
    const signedRequest: SignedEnergyPurchaseRequest = {
      receivers: [...input.receivers],
      energy_per_receiver: input.energyPerReceiver,
      duration: input.duration,
      payer_address: payerAddress,
      signed_transaction: signedTransactionForWire(signed),
    };
    const txId = signedRequest.signed_transaction.txID;
    const risk: EnergyPaymentRisk = {
      payerAddress,
      signedTxId: txId,
      createdAt: this.now(),
      expiresAt: signedDeadline,
      paymentConfirmed: false,
      chainStatus: "unknown",
      chainExecution: "unknown",
      networkFingerprint,
      signedRequest,
    };
    const intentToken = this.activeIntentTokens.get(payerAddress);
    if (intentToken && typeof this.riskStore.finalizeIntent === "function") {
      this.activeIntentTokens.delete(payerAddress);
      this.riskStore.finalizeIntent(payerAddress, intentToken, risk);
    } else {
      this.riskStore.save(risk);
    }

    let order: Record<string, any> | null = null;
    while (!order) {
      this.riskStore.save(risk);
      try {
        order = await this.request("POST", ENERGY_PURCHASE_PATHS.buy, {
          body: signedRequest,
        });
      } catch (error) {
        const typed = error as EnergyPurchaseError;
        if (typed.isBusinessError) {
          if (typed.code === "TX_ALREADY_CLAIMED") {
            risk.paymentConfirmed = true;
            this.riskStore.save(risk);
            typed.paymentRisk = risk;
          } else if (shouldClearSignedRisk(typed)) {
            this.riskStore.remove(payerAddress, txId);
          }
          throw typed;
        }
        if (this.now() >= retryDeadline) {
          const lookup = await this.lookupTransaction(tronWeb, txId);
          if (["observed", "included", "solidified"].includes(lookup.status)) {
            if (lookup.status === "solidified" && lookup.execution === "failed") {
              this.riskStore.remove(payerAddress, txId);
              throw new EnergyPurchaseError(
                "PAYMENT_FAILED_ON_CHAIN",
                "The signed payment failed in a solidified block and was not accepted as payment.",
                { cause: typed, details: { txId, chainStatus: lookup.status, chainExecution: lookup.execution } },
              );
            }
            this.recordChainLookup(risk, lookup);
            if (lookup.execution === "failed") {
              const unknown = new EnergyPurchaseError(
                "PAYMENT_RESULT_UNKNOWN",
                "FullNode reports a failed execution, but the block is not solidified. Do not sign another payment yet.",
                { cause: typed, details: { txId, chainStatus: lookup.status, chainExecution: lookup.execution } },
              );
              unknown.paymentRisk = risk;
              throw unknown;
            }
            return {
              ok: true,
              orderId: null,
              txHash: txId,
              state: "pending",
              reconciliationRequired: true,
              observedOnChain: true,
              confirmedOnChain: lookup.status === "solidified",
              chainStatus: lookup.status,
              chainExecution: lookup.execution,
            };
          }
          const unknown = new EnergyPurchaseError(
            "PAYMENT_RESULT_UNKNOWN",
            "Payment result is unknown. Do not create another signed payment until this risk is reconciled.",
            { cause: typed },
          );
          unknown.paymentRisk = risk;
          throw unknown;
        }
        await this.sleep(this.paymentRetryIntervalMs);
      }
    }

    const batch = order.batch && typeof order.batch === "object" ? order.batch : undefined;
    const payment = order.payment && typeof order.payment === "object" ? order.payment : undefined;
    const orderId = batch?.id ?? order.id;
    const accessToken = batch?.access_token ?? order.access_token;
    risk.recoveredOrder = order;
    risk.paymentConfirmed = true;
    this.riskStore.save(risk);
    if (!((typeof orderId === "string" && orderId.trim()) || Number.isSafeInteger(orderId))) {
      const invalid = new EnergyPurchaseError("INVALID_RESPONSE", "Energy purchase response is missing an order id.");
      invalid.paymentRisk = risk;
      throw invalid;
    }
    const txHash = payment?.tx_hash || order.tx_id || order.payment_tx_id || txId;
    const canPoll = typeof accessToken === "string" && accessToken.length > 0;
    const detail = canPoll ? await this.pollOrder(orderId, accessToken) : null;
    const state = detail?.state || batch?.state || order.state || "pending";
    const reconciled = await this.resolveRiskFromHistory(risk);
    if (state === "failed" || state === "expired") {
      throw new EnergyPurchaseError("DELIVERY_FAILED", "Payment was accepted but energy delivery failed.", {
        details: { orderId, txHash, state, detail, reconciliationRequired: !reconciled },
      });
    }
    return { ok: true, orderId, txHash, state, detail, reconciliationRequired: !reconciled };
  }
}

let defaultApi: EnergyPurchaseApi | null = null;
function api(): EnergyPurchaseApi {
  defaultApi ||= new EnergyPurchaseApi();
  return defaultApi;
}

export async function getEnergyPurchaseConfig() {
  const [config, price, pool] = await Promise.all([api().getConfig(), api().getCurrentPrice(), api().getPoolHealth()]);
  return { config, price, pool };
}

export const quoteEnergyPurchase = (receivers: string[], energyPerReceiver: number, duration: string) =>
  api().quote(receivers, energyPerReceiver, duration);

export const getEnergyPurchaseOrder = (orderId: string | number, token?: string) => api().getOrder(orderId, token);

export const getEnergyPurchaseHistory = (address: string, options: { page?: number; size?: number } = {}) =>
  api().getHistory(address, options);

// A read-only MCP tool must never submit a stored signed payment. Reconciliation
// remains private to the explicitly confirmed purchase path above, while this
// public service export only reports metadata for the configured payer.
export const getEnergyPaymentRisks = (address: string) => api().getPaymentRisks(address);

export const buyEnergyDirect = (input: {
  receivers: string[];
  energyPerReceiver: number;
  duration: string;
  expectedAmountSun: number;
  expectedPayAddress: string;
  network?: string;
}) => api().purchase(input);

export function resetEnergyPurchaseApiForTests(): void {
  defaultApi = null;
}

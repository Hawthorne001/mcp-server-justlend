import { describe, expect, it, vi } from "vitest";

vi.mock("../../../src/core/services/wallet.js", () => ({
  getSigningClient: vi.fn(async () => ({
    defaultAddress: { base58: "TJRabPrwbZy45sbavfcjinPJC18kjpRTv8" },
  })),
}));

vi.mock("../../../src/core/services/contracts.js", () => ({
  readContract: vi.fn(async () => 255),
  safeSend: vi.fn(),
}));

vi.mock("../../../src/core/services/moolah-query.js", () => ({
  getMoolahMarketParams: vi.fn(async () => ({
    loanToken: "TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR",
    collateralToken: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
    oracle: "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb",
    irm: "TVjsyZ7fYF3qLF6BQgPmTEZy1xrNNyVAAA",
    lltv: 800000000000000000n,
  })),
  getMoolahUserPosition: vi.fn(),
  getMoolahMarketState: vi.fn(),
}));

import { safeSend } from "../../../src/core/services/contracts.js";
import { moolahSupplyCollateral } from "../../../src/core/services/moolah-market.js";

describe("Moolah market token decimals", () => {
  it("fails closed before scaling or signing when decimals are out of range", async () => {
    await expect(
      moolahSupplyCollateral({ marketId: "0xmarket", amount: "1", network: "mainnet" }),
    ).rejects.toThrow(/Invalid .* decimals.*255/i);
    expect(safeSend).not.toHaveBeenCalled();
  });
});

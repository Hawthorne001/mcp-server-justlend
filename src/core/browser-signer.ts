/**
 * Compatibility shim for the disabled legacy browser-wallet mode.
 *
 * The previous loopback bridge had no request-level authentication. Keep the
 * exported interface temporarily so existing callers fail closed with an
 * actionable message instead of starting a local signing service.
 */


export interface ConnectResult {
  address: string;
  approvalUrl: string;
}

export interface SignTransactionResult {
  signedTransaction: any;
  approvalUrl: string;
}

export interface SignMessageResult {
  signature: string;
  approvalUrl: string;
}

export interface SignTypedDataResult {
  signature: string;
}

export class TronWalletSigner {
  private _connectedAddress: string | null = null;

  private disabled(): never {
    throw new Error(
      "Browser wallet signing is disabled: the legacy loopback bridge has no request-level authentication. " +
      "Use agent-wallet until an authenticated capability-bound bridge is available.",
    );
  }

  /** Refuse to start the unauthenticated legacy bridge. */
  async start(): Promise<number> {
    return this.disabled();
  }

  getConnectedAddress(): string | null {
    return this._connectedAddress;
  }

  /** Refuse browser-wallet connection until an authenticated bridge exists. */
  async connectWallet(options?: { address?: string; network?: string }): Promise<ConnectResult> {
    void options;
    return this.disabled();
  }

  /** Refuse browser-wallet transaction signing. */
  async signTransaction(unsignedTx: unknown, description?: string, network?: string): Promise<SignTransactionResult> {
    void unsignedTx;
    void description;
    void network;
    return this.disabled();
  }

  /** Refuse browser-wallet message signing. */
  async signMessage(params: { message: string; address?: string; network?: string }): Promise<SignMessageResult> {
    void params;
    return this.disabled();
  }

  /** Refuse browser-wallet typed-data signing. */
  async signTypedData(typedData: Record<string, unknown>, network?: string): Promise<SignTypedDataResult> {
    void typedData;
    void network;
    return this.disabled();
  }

  /** Shut down HTTP server and clear state. */
  async shutdown(): Promise<void> {
    this._connectedAddress = null;
  }
}

// Return accumulated market credit to the gateway float in one transaction rather
// than withdrawing the refund after every task. No local balance journal is needed:
// the market's credit is the durable source of truth across restarts.
export class CreditSweeper {
  constructor({ threshold, read, withdraw, wait }) {
    this.threshold = BigInt(threshold);
    if (this.threshold <= 0n) throw Error('positive credit sweep threshold required');
    this.read = read;
    this.withdraw = withdraw;
    this.wait = wait;
    this.pending = null;
  }
  maybeSweep() {
    if (this.pending) { this.rescan = true; return this.pending; }
    const pending = (async () => {
      let last = null;
      do {
        this.rescan = false;
        if (BigInt(await this.read()) >= this.threshold) {
          const hash = await this.withdraw();
          const receipt = await this.wait(hash);
          if (receipt.status !== 'success') throw Error('market credit withdrawal reverted');
          last = hash;
        }
      } while (this.rescan);
      return last;
    })();
    this.pending = pending;
    void pending.finally(() => { if (this.pending === pending) this.pending = null; }).catch(() => {});
    return pending;
  }
}

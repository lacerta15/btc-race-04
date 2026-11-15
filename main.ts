import { BPS, runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

// 105m Dual Washout Mean-Reversion Bot - Refined Revision
// Analyzes Orca Whirlpool 1-minute bars for CBBTC, executes buy and sell orders on batch stream.

const LOOKBACK_WINDOW = 105;
const WASHOUT_BPS = 190;
const PROFIT_TARGET_BPS = 500;
const TRAILING_ACTIVE_BPS = 90;
const TRAILING_DELTA_BPS = 48;
const EMERGENCY_STOP_BPS = 300;
const SLIPPAGE_LIMIT_BPS = 100;

interface ReversionState {
  historyPrices: number[];
  peakReboundPrice: number;
  openPositionPrice: number;
  totalExecutions: number;
}

const reversion: ReversionState = {
  historyPrices: [],
  peakReboundPrice: 0,
  openPositionPrice: 0,
  totalExecutions: 0,
};

await runBars({
  onHello(barsState: BarsState) {
    reversion.historyPrices = [];
    reversion.peakReboundPrice = 0;
    reversion.openPositionPrice = 0;
    reversion.totalExecutions = 0;
  },
  onBatch(barsState: BarsState, batch) {
    const bar = batch.bars.find((b) => b.symbol === 'CBBTC');
    if (!bar) return [];

    const currentClose = Number(bar.c);
    reversion.historyPrices.push(currentClose);
    if (reversion.historyPrices.length > LOOKBACK_WINDOW * 3) {
      reversion.historyPrices.shift();
    }

    const currentPos = barsState.positions.get('CBBTC');
    const sells: SellInput[] = [];
    const buys: BuyInput[] = [];

    if (currentPos && currentPos.qty > 0n) {
      if (currentClose > reversion.peakReboundPrice) {
        reversion.peakReboundPrice = currentClose;
      }
      const entry = reversion.openPositionPrice > 0 ? reversion.openPositionPrice : Number(currentPos.cost) / (Number(currentPos.qty) / 1e8);
      const profitBps = ((currentClose - entry) / entry) * 10000;
      const retracementBps = ((reversion.peakReboundPrice - currentClose) / reversion.peakReboundPrice) * 10000;

      let shouldExit = false;
      if (profitBps >= PROFIT_TARGET_BPS) {
        shouldExit = true;
      } else if (profitBps >= TRAILING_ACTIVE_BPS && retracementBps >= TRAILING_DELTA_BPS) {
        shouldExit = true;
      } else if (profitBps <= -EMERGENCY_STOP_BPS) {
        shouldExit = true;
      }

      if (shouldExit) {
        sells.push({
          side: 'sell',
          symbol: 'CBBTC',
          qty: currentPos.qty,
          max_slippage_bps: SLIPPAGE_LIMIT_BPS,
        });
        reversion.peakReboundPrice = 0;
        reversion.openPositionPrice = 0;
        reversion.totalExecutions++;
      }
    } else {
      reversion.peakReboundPrice = 0;
      reversion.openPositionPrice = 0;

      if (reversion.historyPrices.length >= LOOKBACK_WINDOW) {
        const windowSlice = reversion.historyPrices.slice(-LOOKBACK_WINDOW);
        const smaVal = windowSlice.reduce((s, v) => s + v, 0) / LOOKBACK_WINDOW;
        const dipBps = ((currentClose - smaVal) / smaVal) * 10000;

        let requiredDipBps = WASHOUT_BPS;
        if (reversion.totalExecutions === 0 && barsState.seq > 920) {
          requiredDipBps = 110;
        }

        if (dipBps <= -requiredDipBps && barsState.cash >= BigInt(barsState.hello.fees.min_notional_quote_units)) {
          buys.push({
            side: 'buy',
            symbol: 'CBBTC',
            notional_quote_units: barsState.cash,
            max_slippage_bps: SLIPPAGE_LIMIT_BPS,
          });
          reversion.openPositionPrice = currentClose;
          reversion.peakReboundPrice = currentClose;
          reversion.totalExecutions++;
        }
      }
    }

    const orders = [...sells, ...buys].slice(0, barsState.hello.caps.max_orders_per_bar);
    return orders;
  },
});

// TypeScript fixture: typed long function + a class method that uses `this`.

export interface Item {
  sku: string;
  qty: number;
  price: number;
  category: "food" | "tools" | "toys";
}

export interface Report {
  lowStock: string[];
  value: number;
  byCategory: Record<string, number>;
  flags: string[];
}

export function buildReport(items: Item[], threshold: number): Report {
  const lowStock: string[] = [];
  const flags: string[] = [];
  let value = 0;

  // collect low stock
  for (const item of items) {
    if (item.qty < threshold) {
      lowStock.push(item.sku);
      if (item.qty === 0) {
        flags.push(`out:${item.sku}`);
      }
    }
  }

  // compute inventory value
  for (const item of items) {
    let v = item.qty * item.price;
    if (item.category === "food") {
      v = v * 0.8;
    } else if (item.category === "toys") {
      v = v * 1.1;
    }
    value += v;
  }

  // group by category
  const byCategory: Record<string, number> = {};
  for (const item of items) {
    byCategory[item.category] = (byCategory[item.category] || 0) + item.qty;
    if (byCategory[item.category] > 100) {
      flags.push(`overstock:${item.category}`);
    }
  }

  return { lowStock, value: Math.round(value * 100) / 100, byCategory, flags };
}

export class Warehouse {
  private events: string[] = [];
  private stock: Record<string, number> = {};

  receive(items: Item[], dock: string): number {
    let accepted = 0;

    // validate dock and log arrival
    if (!dock) {
      this.events.push("rejected: no dock");
      return 0;
    }
    this.events.push(`arrival at ${dock}`);
    this.events.push(`items: ${items.length}`);

    // put items away
    for (const item of items) {
      if (item.qty <= 0) {
        this.events.push(`skip ${item.sku}`);
        continue;
      }
      this.stock[item.sku] = (this.stock[item.sku] || 0) + item.qty;
      accepted += item.qty;
      if (this.stock[item.sku] > 50) {
        this.events.push(`high ${item.sku}`);
      }
    }

    this.events.push(`accepted ${accepted}`);
    return accepted;
  }
}

export function receiveAll(items: Item[], dock: string): { accepted: number } {
  const w = new Warehouse();
  return { accepted: w.receive(items, dock) };
}

// Legacy order processing module (fixture). Deliberately messy: one giant function,
// mutable accumulators, magic numbers, nested conditionals and comment-delimited sections.
"use strict";

var TAX_RATES = { US: 0.07, CA: 0.13, GB: 0.2, DE: 0.19 };

function formatMoney(n) {
  return Math.round(n * 100) / 100;
}

function processOrder(order, options) {
  var opts = options || {};
  var warnings = [];
  var total = 0;
  var itemCount = 0;

  // ---- validate the order ----
  if (!order) {
    throw new Error("order is required");
  }
  if (!order.items || order.items.length === 0) {
    throw new Error("order has no items");
  }
  var country = order.country || "US";
  if (!TAX_RATES[country]) {
    warnings.push("unknown country " + country + ", using US tax");
    country = "US";
  }

  // ---- sum line items ----
  for (var i = 0; i < order.items.length; i++) {
    var item = order.items[i];
    var qty = item.qty || 1;
    if (qty < 0) {
      warnings.push("negative quantity for " + item.sku);
      qty = 0;
    }
    var price = item.price;
    if (item.onSale) {
      price = price * 0.9;
    }
    if (qty > 10) {
      price = price * 0.95;
      warnings.push("bulk discount on " + item.sku);
    }
    total += price * qty;
    itemCount += qty;
  }

  // ---- apply customer discounts ----
  var discount = 0;
  if (order.customer) {
    if (order.customer.tier === "gold") {
      discount = total * 0.1;
    } else if (order.customer.tier === "silver") {
      discount = total * 0.05;
    } else if (order.customer.tier === "staff") {
      discount = total * 0.3;
      if (total > 500) {
        discount = 150;
      }
    }
    if (order.customer.firstOrder && total > 50) {
      discount += 5;
    }
  }
  if (opts.coupon === "SAVE20" && total >= 100) {
    discount += 20;
  } else if (opts.coupon === "HALF") {
    discount = Math.max(discount, total / 2);
  } else if (opts.coupon) {
    warnings.push("invalid coupon " + opts.coupon);
  }
  if (discount > total) {
    discount = total;
  }

  // ---- shipping ----
  var shipping = 0;
  var subtotal = total - discount;
  if (country === "US") {
    shipping = subtotal >= 75 ? 0 : 7.5;
  } else if (country === "CA") {
    shipping = 12;
  } else {
    shipping = 20;
    if (itemCount > 5) {
      shipping += (itemCount - 5) * 2;
    }
  }
  if (opts.express) {
    shipping = shipping * 2 + 10;
  }

  // ---- tax ----
  var taxRate = TAX_RATES[country];
  var tax = 0;
  if (!order.taxExempt) {
    tax = (subtotal + shipping) * taxRate;
  }

  // ---- build result ----
  var grandTotal = subtotal + shipping + tax;
  var result = {
    country: country,
    items: itemCount,
    subtotal: formatMoney(subtotal),
    discount: formatMoney(discount),
    shipping: formatMoney(shipping),
    tax: formatMoney(tax),
    total: formatMoney(grandTotal),
    warnings: warnings,
  };
  if (opts.includeLines) {
    result.lines = order.items.map(function (it) {
      return { sku: it.sku, qty: it.qty || 1 };
    });
  }
  return result;
}

module.exports = { processOrder: processOrder, formatMoney: formatMoney };

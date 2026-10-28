interface SaleTotalsInput {
  cash?: number;
  upiCharge?: number;
  expenses?: { amount: number }[];
  totalExpenses?: number;
  bankingCash?: number;
}

export function withSaleTotals<T extends SaleTotalsInput>(sale: T) {
  // Fill missing legacy fields only: zero and negative stored totals are meaningful, not defaults.
  const totalExpenses = sale.totalExpenses ?? (sale.expenses ?? []).reduce((sum, expense) => sum + expense.amount, 0);
  return {
    ...sale,
    upiCharge: sale.upiCharge ?? 0,
    totalExpenses,
    bankingCash: sale.bankingCash ?? (sale.cash ?? 0) - totalExpenses,
  };
}

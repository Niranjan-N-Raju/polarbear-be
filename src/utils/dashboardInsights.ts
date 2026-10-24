export interface SaleInsight {
  date: string;
  totalSale: number;
  swiggy: number;
  zomato: number;
  upi: number;
  cash: number;
  expenses: { name: string; amount: number }[];
}

export interface EmployeeInsight {
  dateOfJoining?: Date | string | null;
  archivedAt?: Date | string | null;
}

export function computeWeekdayPerformance(sales: SaleInsight[]) {
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const totals = Array.from({ length: 7 }, () => ({ total: 0, count: 0 }));
  for (const sale of sales) {
    const weekday = new Date(`${sale.date}T00:00:00Z`).getUTCDay();
    totals[weekday].total += sale.totalSale;
    totals[weekday].count += 1;
  }
  return weekdays.map((day, index) => ({
    day,
    average: totals[index].count ? Math.round(totals[index].total / totals[index].count) : 0,
  }));
}

export function computeExpenseBreakdown(sales: SaleInsight[], limit = 8) {
  const totals = new Map<string, number>();
  for (const sale of sales) {
    for (const expense of sale.expenses ?? []) {
      totals.set(expense.name, (totals.get(expense.name) ?? 0) + expense.amount);
    }
  }
  return [...totals.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, limit)
    .map(([name, amount]) => ({ name, amount: Math.round(amount) }));
}

export function computePaymentMixTrend(sales: SaleInsight[], months = 6) {
  const totals = new Map<string, { sales: number; online: number; upi: number; cash: number }>();
  for (const sale of sales) {
    const month = sale.date.slice(0, 7);
    const entry = totals.get(month) ?? { sales: 0, online: 0, upi: 0, cash: 0 };
    entry.sales += sale.totalSale;
    entry.online += sale.swiggy + sale.zomato;
    entry.upi += sale.upi;
    entry.cash += sale.cash;
    totals.set(month, entry);
  }
  return [...totals.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(-months)
    .map(([month, entry]) => ({
      month,
      monthLabel: new Intl.DateTimeFormat('en-IN', {
        month: 'short',
        year: 'numeric',
        timeZone: 'UTC',
      }).format(new Date(`${month}-01T00:00:00Z`)),
      onlinePercent: entry.sales > 0 ? Math.round((entry.online / entry.sales) * 1000) / 10 : 0,
      upiPercent: entry.sales > 0 ? Math.round((entry.upi / entry.sales) * 1000) / 10 : 0,
      cashPercent: entry.sales > 0 ? Math.round((entry.cash / entry.sales) * 1000) / 10 : 0,
    }));
}

export function computeMonthlyAttrition(employees: EmployeeInsight[], referenceDate = new Date(), months = 6) {
  const results = [];
  const anchorYear = referenceDate.getUTCFullYear();
  const anchorMonth = referenceDate.getUTCMonth();

  for (let offset = months - 1; offset >= 0; offset -= 1) {
    const monthStart = new Date(Date.UTC(anchorYear, anchorMonth - offset, 1));
    const monthEnd = new Date(Date.UTC(anchorYear, anchorMonth - offset + 1, 1));
    let headcount = 0;
    let leavers = 0;

    for (const employee of employees) {
      if (!employee.dateOfJoining) continue;
      const joinedAt = new Date(employee.dateOfJoining);
      if (joinedAt >= monthEnd) continue;

      const exitedAt = employee.archivedAt
        ? new Date(new Date(employee.archivedAt).getTime() - 24 * 60 * 60 * 1000)
        : null;
      if (joinedAt < monthStart && (!exitedAt || exitedAt >= monthStart)) headcount += 1;
      if (exitedAt && exitedAt >= monthStart && exitedAt < monthEnd) leavers += 1;
    }

    results.push({
      month: `${monthStart.getUTCFullYear()}-${String(monthStart.getUTCMonth() + 1).padStart(2, '0')}`,
      monthLabel: new Intl.DateTimeFormat('en-IN', { month: 'short', year: 'numeric', timeZone: 'UTC' }).format(monthStart),
      headcount,
      leavers,
      rate: headcount ? Math.round((leavers / headcount) * 1000) / 10 : 0,
    });
  }
  return results;
}

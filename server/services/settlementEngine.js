function buildNetTransfers(balancesByUser) {
  const debtors = [];
  const creditors = [];

  for (const [userId, cents] of Object.entries(balancesByUser)) {
    if (cents < 0) {
      debtors.push({ userId, cents: Math.abs(cents) });
    } else if (cents > 0) {
      creditors.push({ userId, cents });
    }
  }

  debtors.sort((a, b) => b.cents - a.cents);
  creditors.sort((a, b) => b.cents - a.cents);

  const transfers = [];
  let i = 0;
  let j = 0;

  while (i < debtors.length && j < creditors.length) {
    const amount = Math.min(debtors[i].cents, creditors[j].cents);
    transfers.push({
      fromId: debtors[i].userId,
      toId: creditors[j].userId,
      amount_cents: amount
    });

    debtors[i].cents -= amount;
    creditors[j].cents -= amount;

    if (debtors[i].cents === 0) {
      i += 1;
    }
    if (creditors[j].cents === 0) {
      j += 1;
    }
  }

  return transfers;
}

module.exports = {
  buildNetTransfers
};

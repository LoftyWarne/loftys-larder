import { sql } from 'drizzle-orm';

import { CURRENT_HOUSEHOLD_ID } from '../config.ts';
import type { Tx } from '../db/withTransaction.ts';
import { formatCivilDate } from './date-utils.ts';

// Settles the household's due Reservations (cross-cutting #23, DEC-118): each
// one whose `needed_on` is before today is deleted and its amount taken off
// its Stock item, and an item brought to zero is deleted. Every read that
// shows held stock, or plans against it, calls this first, in its own
// transaction. So does every write to Stock items, so all paths lock
// Reservations before items and can't deadlock against a settle.
//
// It's one statement so two reads at once can't count a Reservation twice:
// the second read's DELETE waits on the first's row locks, then finds the
// rows gone and returns nothing, so its totals are empty.
//
// `locked` takes the items' row locks and reads their latest committed
// quantity before either branch runs. Without it, both branches would choose
// rows from the statement's snapshot, and an edit committed meanwhile that
// moves an amount across the settled total would leave the item neither
// lowered nor deleted.
export async function settleReservations(tx: Tx, today: Date): Promise<number> {
  const result = await tx.execute<{ settled: number }>(sql`
    with settled as (
      delete from stock_reservations
      where household_id = ${CURRENT_HOUSEHOLD_ID}
        and needed_on < ${formatCivilDate(today)}::date
      returning stock_item_id, amount
    ), totals as (
      select stock_item_id, sum(amount) as amount
      from settled
      group by stock_item_id
    ), locked as (
      select s.id, s.quantity
      from stock_items s
      where s.household_id = ${CURRENT_HOUSEHOLD_ID}
        and s.id in (select stock_item_id from totals)
      order by s.id
      for update
    ), emptied as (
      delete from stock_items s
      using locked l, totals t
      where s.id = l.id
        and t.stock_item_id = l.id
        and s.household_id = ${CURRENT_HOUSEHOLD_ID}
        and l.quantity <= t.amount
    ), lowered as (
      update stock_items s
      set quantity = l.quantity - t.amount, updated_at = now()
      from locked l, totals t
      where s.id = l.id
        and t.stock_item_id = l.id
        and s.household_id = ${CURRENT_HOUSEHOLD_ID}
        and l.quantity > t.amount
    )
    select count(*)::int as settled from settled
  `);
  return result.rows[0]?.settled ?? 0;
}

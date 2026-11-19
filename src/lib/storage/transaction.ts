import type Dexie from 'dexie'
import type { Table, Transaction, TransactionMode } from 'dexie'

/** Explicit database handle; helpers must receive this handle too. No ambient global transaction. */
export function transact<D extends Dexie, R>(db: D, mode: TransactionMode, tables: (Table | Table[])[], work: (db: D, transaction: Transaction) => Promise<R>): Promise<R> {
  return db.transaction(mode, tables.flat(), transaction => {
    const scoped = new Proxy(transaction.db as D, {
      get(target, property) {
        if (property === 'table') return transaction.table.bind(transaction)
        if (property === 'tables') return transaction.storeNames.map(name => transaction.table(name))
        if (typeof property === 'string' && transaction.storeNames.includes(property)) return transaction.table(property)
        return Reflect.get(target, property)
      },
    })
    return work(scoped, transaction)
  })
}

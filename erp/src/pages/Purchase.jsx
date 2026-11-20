import OrderList from '../components/OrderList.jsx';
import { PURCHASES, PURCHASE_STATUS } from '../data/operations.js';
import { day } from '../lib/format.js';

export default function Purchase() {
  return (
    <OrderList
      orders={PURCHASES}
      statuses={PURCHASE_STATUS}
      partyLabel="Supplier"
      partyKey="supplier"
      rateLabel="Cost / sqft"
      newLabel="New purchase order"
      intro="What the studio has ordered from its suppliers, and what has arrived. A received order is what a stock receipt in the ledger refers back to."
      extraColumn={{
        key: 'expectedOn',
        label: 'Expected',
        width: 118,
        render: (o) => day(o.expectedOn),
      }}
    />
  );
}

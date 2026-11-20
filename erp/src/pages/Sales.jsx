import OrderList from '../components/OrderList.jsx';
import { SALES, SALES_STATUS } from '../data/operations.js';

export default function Sales() {
  return (
    <OrderList
      orders={SALES}
      statuses={SALES_STATUS}
      partyLabel="Customer"
      partyKey="customer"
      rateLabel="Sell / sqft"
      newLabel="New sales order"
      intro="What customers have ordered, from quotation through to delivery. A dispatched order is what a sale movement in the ledger refers back to."
      extraColumn={{
        key: 'customerType',
        label: 'Type',
        width: 100,
      }}
    />
  );
}

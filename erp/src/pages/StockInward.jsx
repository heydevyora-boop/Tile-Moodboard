import MovementList from '../components/MovementList.jsx';

export default function StockInward() {
  return (
    <MovementList
      dir="in"
      title="Inward"
      recordLabel="Record a receipt"
      intro="Everything that came in: purchase receipts, customer returns and upward adjustments. Each row is the same record the stock ledger shows — there is no separate inward register."
    />
  );
}
